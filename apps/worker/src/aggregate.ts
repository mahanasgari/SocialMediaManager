import { withAggregator } from '@smm/database'
import { log } from '@smm/observability'

const jobLog = log.child({ service: 'worker', job: 'aggregate' })

/**
 * Rolling raw metrics up into daily snapshots.
 *
 * The dashboard used to run a DISTINCT ON over every PostMetric in its window on
 * every page load. That is fine at demo scale and gets worse every hour the
 * ingestion job runs, because the table it scans only ever grows and nothing
 * ever shrinks it.
 *
 * Three decisions worth stating, because each could reasonably go another way.
 *
 * RECENT DAYS ARE RECOMPUTED, not computed once. Metrics arrive late — a
 * provider's numbers for Tuesday keep moving through Wednesday, and some
 * networks revise days later. Computing a day once and never revisiting it
 * freezes whatever had arrived by the time the job first ran. So the job
 * rewrites a trailing window on every pass, and the unique index makes that a
 * replacement rather than a duplicate.
 *
 * A DAY IS A UTC DAY. Not the workspace's local day: two workspaces in
 * different zones can hold the same account, and a local day would have them
 * disagree about which day a metric belongs to. The dashboard renders in the
 * viewer's zone; the storage unit stays absolute.
 *
 * NULL IS NOT ZERO, all the way through. A network that does not report reach
 * contributes nothing to reach rather than dragging the total toward zero, and
 * a day where nobody reported it stays null so the chart can show a gap instead
 * of a cliff.
 */

/** How far back to rewrite on each pass. Covers late-arriving metrics. */
const WINDOW_DAYS = 7

/**
 * How much history to catch up on PER RUN, beyond the trailing window.
 *
 * A workspace with a year of metrics and no snapshots needs a year built, or
 * the dashboard is correct and empty. But building a year in one pass means
 * seven hundred queries inside a single transaction, and this codebase's own
 * rule is that transactions are short and contain no I/O (ARCHITECTURE §2.3) —
 * a long one pins a connection and, under load, exhausts the pool.
 *
 * So catch-up is incremental: each run extends a little further back, and the
 * work converges over a few minutes of ordinary ticks instead of one long
 * stall. Thirty days a run reaches a full year in twelve passes, which at a
 * thirty-second tick is about six minutes after a deploy.
 */
const CATCHUP_DAYS_PER_RUN = 30

/** The furthest back a snapshot is ever built. Matches the longest dashboard window. */
const MAX_HISTORY_DAYS = 365

type Totals = {
  impressions: number | null
  reach: number | null
  likes: number | null
  comments: number | null
  shares: number | null
  saves: number | null
  clicks: number | null
  videoViews: number | null
  engagementRate: number | null
  sampleSize: number
}

export async function aggregateAnalytics(): Promise<{
  workspaces: number
  days: number
  rows: number
}> {
  const today = startOfUtcDay(new Date())
  const days = Array.from(
    { length: WINDOW_DAYS },
    (_, i) => new Date(today.getTime() - i * 86_400_000)
  )

  return withAggregator(async (tx) => {
    const workspaces = await tx.workspace.findMany({
      where: { deletedAt: null },
      select: { id: true, organizationId: true },
    })

    let rows = 0

    for (const workspace of workspaces) {
      // The trailing window always, plus a slice of history that has metrics and
      // no snapshot yet.
      //
      // Progress is measured by ASKING WHICH DAYS ARE MISSING rather than by
      // remembering how far back a previous run reached. The first attempt used
      // the oldest snapshot as a high-water mark and could not move: days with
      // no activity write no row, so a workspace whose recent weeks are quiet
      // never produced a mark to advance from, and history older than the
      // window was never built at all. Asking the data cannot get stuck.
      const pending = await tx.$queryRaw<Array<{ day: Date }>>`
        SELECT DISTINCT date_trunc('day', m."capturedAt") AS day
        FROM "PostMetric" m
        WHERE m."workspaceId" = ${workspace.id}::uuid
          AND m."capturedAt" >= ${new Date(today.getTime() - MAX_HISTORY_DAYS * 86_400_000)}
          AND NOT EXISTS (
            SELECT 1 FROM "AnalyticsSnapshot" s
            WHERE s."workspaceId" = m."workspaceId"
              AND s."day" = date_trunc('day', m."capturedAt")
              AND s."socialAccountId" IS NULL
          )
        ORDER BY day DESC
        LIMIT ${CATCHUP_DAYS_PER_RUN}
      `

      const forWorkspace = [...days, ...pending.map((row) => new Date(row.day))]

      for (const day of forWorkspace) {
        const next = new Date(day.getTime() + 86_400_000)

        // The LATEST reading per variant within the day. A variant polled six
        // times on Tuesday must count once, at its highest-water mark, not six
        // times — summing every poll would multiply a day's impressions by
        // however often the ingestion job happened to run.
        const metrics = await tx.$queryRaw<
          Array<{
            postVariantId: string
            socialAccountId: string
            impressions: number | null
            reach: number | null
            likes: number | null
            comments: number | null
            shares: number | null
            saves: number | null
            clicks: number | null
            videoViews: number | null
            engagementRate: number | null
          }>
        >`
          SELECT DISTINCT ON (m."postVariantId")
                 m."postVariantId", v."socialAccountId",
                 m."impressions", m."reach", m."likes", m."comments",
                 m."shares", m."saves", m."clicks", m."videoViews",
                 m."engagementRate"
          FROM "PostMetric" m
          JOIN "PostVariant" v ON v."id" = m."postVariantId"
          WHERE m."workspaceId" = ${workspace.id}::uuid
            AND m."capturedAt" >= ${day}
            AND m."capturedAt" < ${next}
          ORDER BY m."postVariantId", m."capturedAt" DESC
        `

        const published = await tx.postVariant.count({
          where: {
            workspaceId: workspace.id,
            status: 'PUBLISHED',
            publishedAt: { gte: day, lt: next },
          },
        })

        // Nothing measured and nothing published is not a day worth a row. An
        // empty snapshot per workspace per day would be most of the table.
        if (metrics.length === 0 && published === 0) continue

        // One row per account, plus one for the workspace as a whole. The
        // workspace row is what a dashboard opens with, and precomputing it
        // means the common case is a single indexed read.
        const byAccount = new Map<string, typeof metrics>()
        for (const metric of metrics) {
          byAccount.set(metric.socialAccountId, [
            ...(byAccount.get(metric.socialAccountId) ?? []),
            metric,
          ])
        }

        await writeSnapshot(tx, workspace, day, null, sum(metrics), published)
        rows++

        for (const [accountId, forAccount] of byAccount) {
          const publishedForAccount = await tx.postVariant.count({
            where: {
              workspaceId: workspace.id,
              socialAccountId: accountId,
              status: 'PUBLISHED',
              publishedAt: { gte: day, lt: next },
            },
          })
          await writeSnapshot(tx, workspace, day, accountId, sum(forAccount), publishedForAccount)
          rows++
        }
      }
    }

    if (rows > 0) {
      jobLog.info('analytics rolled up', {
        workspaces: workspaces.length,
        days: days.length,
        rows,
      })
    }

    return { workspaces: workspaces.length, days: days.length, rows }
  })
}

/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Writes one snapshot row, replacing any existing one for that day.
 *
 * Not `upsert`. Prisma refuses null inside a compound unique `where`, and the
 * workspace-wide row is precisely the one whose socialAccountId is null — so
 * the ORM cannot address the row the database is perfectly able to key. The
 * unique index does declare NULLS NOT DISTINCT, so the constraint is real; this
 * reaches it through SQL rather than working around it with a sentinel id,
 * which would put a fake account in a foreign-keyed column.
 *
 * ON CONFLICT makes the re-run idempotent at the database rather than by
 * checking first, which matters because the job rewrites a trailing week on
 * every tick and two workers can be in the same day at once.
 */
async function writeSnapshot(
  tx: any,
  workspace: { id: string; organizationId: string },
  day: Date,
  socialAccountId: string | null,
  totals: Totals,
  postsPublished: number
): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO "AnalyticsSnapshot" (
      "workspaceId", "organizationId", "day", "socialAccountId", "postsPublished",
      "impressions", "reach", "likes", "comments", "shares", "saves", "clicks",
      "videoViews", "engagementRate", "sampleSize", "computedAt"
    ) VALUES (
      ${workspace.id}::uuid, ${workspace.organizationId}::uuid, ${day},
      ${socialAccountId}::uuid, ${postsPublished},
      ${totals.impressions}, ${totals.reach}, ${totals.likes}, ${totals.comments},
      ${totals.shares}, ${totals.saves}, ${totals.clicks}, ${totals.videoViews},
      ${totals.engagementRate}, ${totals.sampleSize}, NOW()
    )
    ON CONFLICT ("workspaceId", "day", "socialAccountId") DO UPDATE SET
      "postsPublished" = EXCLUDED."postsPublished",
      "impressions"    = EXCLUDED."impressions",
      "reach"          = EXCLUDED."reach",
      "likes"          = EXCLUDED."likes",
      "comments"       = EXCLUDED."comments",
      "shares"         = EXCLUDED."shares",
      "saves"          = EXCLUDED."saves",
      "clicks"         = EXCLUDED."clicks",
      "videoViews"     = EXCLUDED."videoViews",
      "engagementRate" = EXCLUDED."engagementRate",
      "sampleSize"     = EXCLUDED."sampleSize",
      "computedAt"     = NOW()
  `
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Sums a day's readings, keeping null distinct from zero.
 *
 * A network that does not report saves contributes nothing to saves rather than
 * pulling the total toward zero — and if NO variant reported it, the total
 * stays null so the chart shows a gap rather than a confident zero.
 */
function sum(
  metrics: Array<Record<string, number | null | string>>
): Totals {
  const fields = [
    'impressions',
    'reach',
    'likes',
    'comments',
    'shares',
    'saves',
    'clicks',
    'videoViews',
  ] as const

  const totals: Record<string, number | null> = {}
  for (const field of fields) {
    let running: number | null = null
    for (const metric of metrics) {
      const value = metric[field]
      if (typeof value === 'number') running = (running ?? 0) + value
    }
    totals[field] = running
  }

  // Averaged, not summed. A rate that adds up is not a rate.
  const rates = metrics
    .map((m) => m['engagementRate'])
    .filter((r): r is number => typeof r === 'number')
  const engagementRate =
    rates.length > 0 ? rates.reduce((a, b) => a + b, 0) / rates.length : null

  return {
    impressions: totals['impressions'] ?? null,
    reach: totals['reach'] ?? null,
    likes: totals['likes'] ?? null,
    comments: totals['comments'] ?? null,
    shares: totals['shares'] ?? null,
    saves: totals['saves'] ?? null,
    clicks: totals['clicks'] ?? null,
    videoViews: totals['videoViews'] ?? null,
    engagementRate,
    sampleSize: metrics.length,
  }
}

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
}
