import { Controller, Get, Query } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import { withTenant } from '@smm/database'
import { errors } from '../common/errors.js'
import { CurrentUser } from '../auth/current-user.js'
import type { SessionPrincipal } from '../auth/session.service.js'
import { MembershipService } from '../tenancy/membership.service.js'

/**
 * Analytics.
 *
 * Everything here reads STORED metrics. Nothing calls a provider on request:
 * a dashboard that fetched live would be slow, would fail whenever a network
 * was down, and would spend the same quota that publishing needs.
 *
 * The nullability discipline runs all the way through. A metric a platform does
 * not report stays null from ingestion to the chart, so the UI can render "—"
 * rather than a zero nobody measured.
 */

type Totals = {
  impressions: number | null
  reach: number | null
  likes: number | null
  comments: number | null
  shares: number | null
  clicks: number | null
}

@ApiTags('analytics')
@Controller('analytics')
export class AnalyticsController {
  constructor(private readonly memberships: MembershipService) {}

  @Get('overview')
  @ApiOperation({ summary: 'Workspace totals and top posts over a date range' })
  async overview(
    @Query('workspaceId') workspaceId: string,
    @Query('days') days: string,
    @CurrentUser() principal: SessionPrincipal | undefined
  ) {
    if (!principal) throw errors.unauthenticated()
    if (!workspaceId) throw errors.validation('workspaceId is required.', 'workspaceId')
    await this.memberships.requireAccess(principal.userId, workspaceId)

    const window = Math.min(Math.max(Number(days) || 30, 1), 365)
    const since = new Date(Date.now() - window * 86_400_000)

    return withTenant(workspaceId, async (tx) => {
      // Latest reading per variant, not a sum across readings — the same post
      // measured six times would otherwise count six times.
      const latest = await tx.$queryRaw<
        Array<{
          postVariantId: string
          impressions: number | null
          reach: number | null
          likes: number | null
          comments: number | null
          shares: number | null
          clicks: number | null
          engagementRate: number | null
        }>
      >`
        SELECT DISTINCT ON (m."postVariantId")
               m."postVariantId", m."impressions", m."reach", m."likes",
               m."comments", m."shares", m."clicks", m."engagementRate"
        FROM "PostMetric" m
        WHERE m."capturedAt" >= ${since}
        ORDER BY m."postVariantId", m."capturedAt" DESC
      `

      const totals = sumNullable(latest as unknown as Array<Record<string, number | null>>)

      const publishedCount = await tx.postVariant.count({
        where: { status: 'PUBLISHED', publishedAt: { gte: since } },
      })

      const accounts = await tx.socialAccount.count({ where: { status: 'ACTIVE' } })

      // Top posts by engagement rate, then by reach. Posts with no metrics at
      // all are excluded rather than ranked last — an unmeasured post is not a
      // badly performing one.
      const ranked = [...latest]
        .filter((m) => m.engagementRate !== null || m.reach !== null)
        .sort((a, b) => (b.engagementRate ?? 0) - (a.engagementRate ?? 0))
        .slice(0, 5)

      const topVariants = ranked.length
        ? await tx.postVariant.findMany({
            where: { id: { in: ranked.map((r) => r.postVariantId) } },
            select: {
              id: true,
              remoteUrl: true,
              post: { select: { baseContent: true } },
              socialAccount: { select: { handle: true } },
            },
          })
        : []

      return {
        windowDays: window,
        publishedCount,
        activeAccounts: accounts,
        measuredCount: latest.length,
        totals,
        top: ranked.map((r) => {
          const variant = topVariants.find((v) => v.id === r.postVariantId)
          return {
            variantId: r.postVariantId,
            excerpt: variant?.post.baseContent.slice(0, 120) ?? '',
            handle: variant?.socialAccount.handle ?? '',
            remoteUrl: variant?.remoteUrl ?? null,
            engagementRate: r.engagementRate,
            reach: r.reach,
            likes: r.likes,
          }
        }),
      }
    })
  }

  @Get('series')
  @ApiOperation({ summary: 'Daily totals, and the same span immediately before' })
  async series(
    @Query('workspaceId') workspaceId: string,
    @Query('days') days: string,
    @CurrentUser() principal: SessionPrincipal | undefined
  ) {
    if (!principal) throw errors.unauthenticated()
    if (!workspaceId) throw errors.validation('workspaceId is required.', 'workspaceId')
    await this.memberships.requireAccess(principal.userId, workspaceId)

    const window = Math.min(Math.max(Number(days) || 30, 1), 365)

    // Whole UTC days, matching how snapshots are stored. Starting the window at
    // "now minus N days" would put a partial day at each end and make the first
    // and last points of every chart quietly lower than the rest.
    const today = startOfUtcDay(new Date())
    const from = new Date(today.getTime() - (window - 1) * DAY_MS)
    const previousFrom = new Date(from.getTime() - window * DAY_MS)

    return withTenant(workspaceId, async (tx) => {
      // Reads SNAPSHOTS, not raw metrics — the read model exists for exactly
      // this: a year-long chart is 365 indexed rows rather than a scan of every
      // reading ever captured.
      const rows = await tx.analyticsSnapshot.findMany({
        where: { socialAccountId: null, day: { gte: previousFrom, lte: today } },
        orderBy: { day: 'asc' },
        select: {
          day: true,
          postsPublished: true,
          impressions: true,
          reach: true,
          likes: true,
          comments: true,
          shares: true,
          clicks: true,
          engagementRate: true,
        },
      })

      const current = rows.filter((r) => r.day >= from)
      const previous = rows.filter((r) => r.day < from)

      return {
        windowDays: window,
        from: from.toISOString(),
        // Every day in the range, including ones with no snapshot. A chart that
        // silently omits quiet days compresses time and makes a gap look like
        // continuity.
        points: Array.from({ length: window }, (_, i) => {
          const day = new Date(from.getTime() + i * DAY_MS)
          const row = current.find((r) => r.day.getTime() === day.getTime())
          return {
            day: day.toISOString().slice(0, 10),
            postsPublished: row?.postsPublished ?? 0,
            impressions: row?.impressions ?? null,
            reach: row?.reach ?? null,
            likes: row?.likes ?? null,
            engagementRate: row?.engagementRate ?? null,
          }
        }),
        totals: totalsOf(current),
        // The same span immediately before, so "up 12%" has something to be up
        // from. Comparing to a DIFFERENT length would be meaningless, which is
        // why the previous window is derived rather than configurable.
        previous: totalsOf(previous),
        comparable: previous.length > 0,
      }
    })
  }

  @Get('accounts')
  @ApiOperation({ summary: 'Per-account performance' })
  async byAccount(
    @Query('workspaceId') workspaceId: string,
    @Query('days') days: string,
    @CurrentUser() principal: SessionPrincipal | undefined
  ) {
    if (!principal) throw errors.unauthenticated()
    if (!workspaceId) throw errors.validation('workspaceId is required.', 'workspaceId')
    await this.memberships.requireAccess(principal.userId, workspaceId)

    const window = Math.min(Math.max(Number(days) || 30, 1), 365)
    const since = new Date(Date.now() - window * 86_400_000)

    return withTenant(workspaceId, async (tx) =>
      tx.$queryRaw<
        Array<{
          accountId: string
          handle: string
          provider: string
          published: bigint
          impressions: number | null
          likes: number | null
        }>
      >`
        SELECT a."id" AS "accountId", a."handle", a."provider",
               COUNT(DISTINCT v."id") FILTER (WHERE v."status" = 'PUBLISHED') AS "published",
               SUM(m."impressions") AS "impressions",
               SUM(m."likes") AS "likes"
        FROM "SocialAccount" a
        LEFT JOIN "PostVariant" v ON v."socialAccountId" = a."id" AND v."publishedAt" >= ${since}
        LEFT JOIN LATERAL (
          SELECT * FROM "PostMetric" pm
          WHERE pm."postVariantId" = v."id"
          ORDER BY pm."capturedAt" DESC
          LIMIT 1
        ) m ON TRUE
        WHERE a."deletedAt" IS NULL
        GROUP BY a."id", a."handle", a."provider"
        ORDER BY "published" DESC
      `
    ).then((rows) =>
      rows.map((r) => ({
        ...r,
        // bigint does not survive JSON, and a count is never large enough to
        // need one on the wire.
        published: Number(r.published),
      }))
    )
  }
}

/**
 * Sums a metric across posts, preserving "not reported".
 *
 * If NO post reported a metric, the total is null rather than 0 — because the
 * honest answer is "we have no impressions data", not "you got zero
 * impressions". Once at least one post reports it, absent values count as zero.
 */
function sumNullable(rows: Array<Record<string, number | null>>): Totals {
  const keys: (keyof Totals)[] = ['impressions', 'reach', 'likes', 'comments', 'shares', 'clicks']
  const totals = {} as Totals

  for (const key of keys) {
    const reported = rows.filter((r) => r[key] !== null && r[key] !== undefined)
    totals[key] = reported.length === 0 ? null : reported.reduce((sum, r) => sum + (r[key] ?? 0), 0)
  }

  return totals
}

const DAY_MS = 86_400_000

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
}

/**
 * Adds a set of daily snapshots together.
 *
 * Null stays null when NOTHING reported a metric, so a chart shows a gap rather
 * than a confident zero — the same rule the rollup itself follows. The rate is
 * averaged across the days that have one, because a rate that adds up is not a
 * rate.
 */
function totalsOf(
  rows: Array<{
    postsPublished: number
    impressions: number | null
    reach: number | null
    likes: number | null
    comments: number | null
    shares: number | null
    clicks: number | null
    engagementRate: number | null
  }>
): Record<string, number | null> {
  const add = (pick: (r: (typeof rows)[number]) => number | null): number | null => {
    let running: number | null = null
    for (const row of rows) {
      const value = pick(row)
      if (typeof value === 'number') running = (running ?? 0) + value
    }
    return running
  }

  const rates = rows
    .map((r) => r.engagementRate)
    .filter((r): r is number => typeof r === 'number')

  return {
    postsPublished: rows.reduce((total, r) => total + r.postsPublished, 0),
    impressions: add((r) => r.impressions),
    reach: add((r) => r.reach),
    likes: add((r) => r.likes),
    comments: add((r) => r.comments),
    shares: add((r) => r.shares),
    clicks: add((r) => r.clicks),
    engagementRate: rates.length > 0 ? rates.reduce((a, b) => a + b, 0) / rates.length : null,
  }
}

