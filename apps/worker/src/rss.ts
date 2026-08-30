import { assertOutsideTransaction } from '@smm/config'
import { withScheduler } from '@smm/database'
// Shared with the API, which validates the same addresses at creation time.
// One definition, because the risk is one risk.
import { assertSafeUrl, UnsafeFeedUrl } from '@smm/integrations'

/**
 * RSS ingestion.
 *
 * The one place in the product where a USER-SUPPLIED URL is fetched, which makes
 * it the one place with a genuine SSRF surface. Everything else that "fetches"
 * takes an opaque token naming something we already own; this takes an address
 * somebody typed.
 *
 * Items become DRAFTS by default. Auto-publishing from a feed you do not control
 * is how someone else's headline ends up on your brand account.
 */

const FETCH_TIMEOUT_MS = 15_000
const MAX_BYTES = 2 * 1024 * 1024
const MAX_REDIRECTS = 3
/** Feeds are polled at most this often, whatever the tick rate. */
const MIN_INTERVAL_MS = 15 * 60_000

export type RssItem = {
  guid: string
  title: string
  link: string
  publishedAt: Date | null
}

/**
 * Minimal RSS/Atom parsing.
 *
 * Regex rather than an XML parser, deliberately: a full parser is a large
 * dependency and an XXE surface for content we already treat as hostile. We need
 * four fields, and anything we fail to extract simply produces no item — a
 * missed post, not a vulnerability.
 */
export function parseFeed(xml: string): RssItem[] {
  const items: RssItem[] = []
  const entries = xml.match(/<(item|entry)\b[\s\S]*?<\/\1>/gi) ?? []

  for (const entry of entries.slice(0, 50)) {
    const title = tag(entry, 'title')
    const link = tag(entry, 'link') || attr(entry, 'link', 'href')
    const guid = tag(entry, 'guid') || tag(entry, 'id') || link
    const dateText = tag(entry, 'pubDate') || tag(entry, 'published') || tag(entry, 'updated')

    if (!guid || !title) continue

    const published = dateText ? new Date(dateText) : null
    items.push({
      guid,
      title: decodeEntities(title).slice(0, 500),
      link: link || '',
      publishedAt: published && !Number.isNaN(published.getTime()) ? published : null,
    })
  }

  return items
}

function tag(xml: string, name: string): string {
  const match = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, 'i').exec(xml)
  if (!match) return ''
  return match[1]!
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .trim()
}

function attr(xml: string, name: string, attribute: string): string {
  const match = new RegExp(`<${name}\\b[^>]*${attribute}=["']([^"']+)["']`, 'i').exec(xml)
  return match?.[1] ?? ''
}

function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

export function renderTemplate(template: string, item: RssItem): string {
  return template
    .replace(/\{\{title\}\}/g, item.title)
    .replace(/\{\{link\}\}/g, item.link)
    .trim()
}

async function fetchFeed(rawUrl: string): Promise<string> {
  assertOutsideTransaction('RSS fetch')

  let url = assertSafeUrl(rawUrl)

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

    const response = await fetch(url, {
      // Redirects are followed MANUALLY so each hop can be re-validated.
      // Automatic following would let a public hostname redirect straight to a
      // metadata endpoint.
      redirect: 'manual',
      signal: controller.signal,
      headers: { accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml' },
    })
    clearTimeout(timer)

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      if (!location) throw new UnsafeFeedUrl('redirect without a destination')
      url = assertSafeUrl(new URL(location, url).toString())
      continue
    }

    if (!response.ok) throw new Error(`feed responded ${response.status}`)

    const text = await response.text()
    if (text.length > MAX_BYTES) throw new Error('feed is too large')
    return text
  }

  throw new UnsafeFeedUrl('too many redirects')
}

export type RssResult = { feeds: number; created: number; skipped: number }

export async function ingestFeeds(now: Date = new Date()): Promise<RssResult> {
  const result: RssResult = { feeds: 0, created: 0, skipped: 0 }
  const cutoff = new Date(now.getTime() - MIN_INTERVAL_MS)

  const feeds = await withScheduler(async (tx) =>
    tx.rSSFeed.findMany({
      where: {
        deletedAt: null,
        pausedAt: null,
        OR: [{ lastFetchedAt: null }, { lastFetchedAt: { lte: cutoff } }],
      },
      select: {
        id: true,
        workspaceId: true,
        organizationId: true,
        url: true,
        template: true,
        targetAccountIds: true,
        autoPublish: true,
      },
      take: 20,
    })
  )

  for (const feed of feeds) {
    result.feeds++
    try {
      const items = parseFeed(await fetchFeed(feed.url))

      for (const item of items.slice(0, 10)) {
        const created = await createFromItem(feed, item, now)
        if (created) result.created++
        else result.skipped++
      }

      await withScheduler(async (tx) => {
        await tx.rSSFeed.update({ where: { id: feed.id }, data: { lastFetchedAt: now } })
      })
    } catch {
      // A broken feed must not stop the others. lastFetchedAt is still stamped
      // so a permanently dead feed is retried on the interval rather than on
      // every single tick.
      await withScheduler(async (tx) => {
        await tx.rSSFeed.update({ where: { id: feed.id }, data: { lastFetchedAt: now } })
      }).catch(() => undefined)
    }
  }

  return result
}

async function createFromItem(
  feed: {
    id: string
    workspaceId: string
    organizationId: string
    template: string
    targetAccountIds: string[]
    autoPublish: boolean
  },
  item: RssItem,
  now: Date
): Promise<boolean> {
  return withScheduler(async (tx) => {
    const existing = await tx.rSSItem.findFirst({
      where: { feedId: feed.id, guid: item.guid },
      select: { id: true },
    })
    // A feed re-publishing an item with the same guid is normal, not an edge
    // case. Without this the same headline posts every fifteen minutes.
    if (existing) return false

    if (feed.targetAccountIds.length === 0) {
      await tx.rSSItem.create({
         
        data: {
          workspaceId: feed.workspaceId,
          feedId: feed.id,
          guid: item.guid,
          title: item.title,
          link: item.link,
          publishedAt: item.publishedAt,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
      })
      return false
    }

    const post = await tx.post.create({
       
      data: {
        workspaceId: feed.workspaceId,
        organizationId: feed.organizationId,
        baseContent: renderTemplate(feed.template, item),
        // A draft unless the workspace explicitly opted into auto-publishing.
        status: feed.autoPublish ? 'SCHEDULED' : 'DRAFT',
        scheduledAt: feed.autoPublish ? now : null,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      select: { id: true },
    })

    for (const accountId of feed.targetAccountIds) {
      await tx.postVariant.create({
         
        data: {
          postId: post.id,
          workspaceId: feed.workspaceId,
          organizationId: feed.organizationId,
          socialAccountId: accountId,
          surface: 'feed',
          status: feed.autoPublish ? 'SCHEDULED' : 'DRAFT',
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
      })
    }

    await tx.rSSItem.create({
       
      data: {
        workspaceId: feed.workspaceId,
        feedId: feed.id,
        guid: item.guid,
        title: item.title,
        link: item.link,
        publishedAt: item.publishedAt,
        postId: post.id,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
    })

    return true
  })
}
