import { decrypt, keyProvider, withScheduler } from '@smm/database'
import { registry, windowMs } from '@smm/providers'

/**
 * Metrics ingestion.
 *
 * Polling happens on a DECAYING schedule after publish — 1h, 6h, 24h, 3d, 7d,
 * 30d — rather than at a fixed interval. Engagement is heavily front-loaded, so
 * this captures the shape of the curve at a fraction of the request cost, and
 * every one of those requests competes for the same provider quota as
 * publishing. Polling everything hourly forever would spend the budget that
 * actually matters on data nobody is watching.
 *
 * Nothing is fetched on page load, ever. Dashboards read what this stored.
 */

/** Hours after publish at which a post is worth re-measuring. */
const SCHEDULE_HOURS = [1, 6, 24, 72, 168, 720] as const

/** Tolerance around each point, so a tick that runs late still collects. */
const WINDOW_HOURS = 0.5

export type IngestResult = {
  collected: number
  skipped: number
  failed: number
}

/** Whether a variant is due for a metrics read right now. */
export function isDue(publishedAt: Date, lastCapturedAt: Date | null, now: Date): boolean {
  const ageHours = (now.getTime() - publishedAt.getTime()) / 3_600_000

  const target = SCHEDULE_HOURS.find(
    (h) => ageHours >= h - WINDOW_HOURS && ageHours <= h + WINDOW_HOURS
  )
  if (target === undefined) return false

  if (!lastCapturedAt) return true

  // Already sampled at this point in the curve.
  const sinceLast = (now.getTime() - lastCapturedAt.getTime()) / 3_600_000
  return sinceLast > WINDOW_HOURS * 2
}

export async function ingestMetrics(now: Date = new Date()): Promise<IngestResult> {
  const result: IngestResult = { collected: 0, skipped: 0, failed: 0 }

  const due = await withScheduler(async (tx) => {
    const rows = await tx.$queryRaw<
      Array<{
        id: string
        workspaceId: string
        remoteId: string | null
        publishedAt: Date
        lastCapturedAt: Date | null
      }>
    >`
      SELECT v."id", v."workspaceId", v."remoteId", v."publishedAt",
             (SELECT MAX(m."capturedAt") FROM "PostMetric" m WHERE m."postVariantId" = v."id")
               AS "lastCapturedAt"
      FROM "PostVariant" v
      WHERE v."status" = 'PUBLISHED'
        AND v."remoteId" IS NOT NULL
        AND v."publishedAt" IS NOT NULL
        AND v."publishedAt" > ${new Date(now.getTime() - 31 * 86_400_000)}
      LIMIT 200
    `
    return rows.filter((r) => isDue(r.publishedAt, r.lastCapturedAt, now))
  })

  for (const variant of due) {
    try {
      const collected = await collectFor(variant.id, variant.workspaceId, variant.remoteId!)
      if (collected) result.collected++
      else result.skipped++
    } catch {
      // A provider being unavailable must not stop the sweep; the next pass
      // picks this up again inside the same window.
      result.failed++
    }
  }

  return result
}

async function collectFor(
  variantId: string,
  workspaceId: string,
  remoteId: string
): Promise<boolean> {
  return withScheduler(async (tx) => {
    const variant = await tx.postVariant.findUnique({
      where: { id: variantId },
      select: {
        socialAccount: {
          select: {
            id: true,
            provider: true,
            providerAccountId: true,
            handle: true,
            displayName: true,
            platformMeta: true,
            credential: { select: { accessToken: true, scopes: true } },
          },
        },
      },
    })

    const account = variant?.socialAccount
    if (!account?.credential) return false

    const provider = registry.get(account.provider as never)
    // Not every network reports post metrics. Skipping is the honest outcome —
    // the UI renders "—" rather than a fabricated zero.
    if (!provider?.capabilities.analytics || !provider.fetchPostMetrics) return false

    void windowMs

    const raw = await provider.fetchPostMetrics(
      {
        id: account.id,
        providerAccountId: account.providerAccountId,
        handle: account.handle,
        displayName: account.displayName,
        platformMeta: account.platformMeta as Record<string, unknown>,
      },
      {
        accessToken: decrypt(account.credential.accessToken, keyProvider()),
        scopes: account.credential.scopes,
      },
      remoteId
    )

    await tx.postMetric.create({
      data: {
        workspaceId,
        postVariantId: variantId,
        // Null passes through as null. A metric the provider did not report must
        // not become a zero somewhere between here and the chart.
        impressions: raw['impressions'] ?? null,
        reach: raw['reach'] ?? null,
        views: raw['views'] ?? null,
        likes: raw['likes'] ?? null,
        comments: raw['comments'] ?? null,
        shares: raw['shares'] ?? null,
        saves: raw['saves'] ?? null,
        clicks: raw['clicks'] ?? null,
        videoViews: raw['videoViews'] ?? null,
        engagementRate: engagementRate(raw),
        raw: raw as object,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
    })

    return true
  })
}

/**
 * Engagement rate over reach, falling back to impressions.
 *
 * Returns null rather than 0 when the denominator is missing: "0% engagement"
 * and "we do not know the engagement" are different claims, and only one of them
 * is true.
 */
export function engagementRate(raw: Record<string, number | null>): number | null {
  const denominator = raw['reach'] ?? raw['impressions']
  if (!denominator || denominator <= 0) return null

  const interactions =
    (raw['likes'] ?? 0) + (raw['comments'] ?? 0) + (raw['shares'] ?? 0) + (raw['saves'] ?? 0)
  return Number(((interactions / denominator) * 100).toFixed(2))
}
