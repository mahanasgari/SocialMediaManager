import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  createTestClient,
  withAggregator,
  withOrganization,
  withSystemScope,
  withTenant,
  type Db,
} from '@smm/database'

/**
 * Rolling metrics into daily snapshots, against a real database.
 *
 * The arithmetic is simple and the ways it goes wrong are not, so the tests
 * here are about the three rules that are easy to get backwards:
 *
 *   - The LATEST reading per variant counts, not every reading. A variant
 *     polled six times in a day must count once; summing polls multiplies a
 *     day's impressions by however often the ingestion job happened to run,
 *     which looks like growth.
 *   - Null is not zero. A network that does not report reach must not drag the
 *     total toward zero, and a day nobody reported must stay null so the chart
 *     shows a gap rather than a cliff.
 *   - Re-running replaces a day rather than duplicating it, because the job
 *     rewrites a trailing week on every pass.
 */

const dbUrl = process.env['TEST_DATABASE_URL']
const ownerUrl = process.env['TEST_DATABASE_OWNER_URL'] ?? dbUrl

const suite = dbUrl ? describe : describe.skip
if (!dbUrl) console.warn('\n  [skipped] aggregate — run: bash scripts/test-db.sh up\n')

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const omitTenancy = <T,>(data: T) => data as any

let client: Db
let orgId: string
let userId: string
let workspaceId: string
let accountId: string

/** Midnight UTC today, the day the job writes into. */
const today = new Date(
  Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate())
)
/** Mid-morning today, safely inside the day and not near a boundary. */
const during = new Date(today.getTime() + 10 * 3_600_000)

suite('rolling metrics into daily snapshots', () => {
  beforeAll(async () => {
    client = createTestClient(ownerUrl!)
    process.env['DATABASE_URL'] = ownerUrl!
    const stamp = Date.now()

    await withSystemScope('aggregate fixture', async () => {
      const org = await client.organization.create({
        data: { name: 'Agg Org', slug: `agg-${stamp}` },
      })
      orgId = org.id
      const user = await client.user.create({
        data: { email: `agg-${stamp}@example.com`, passwordHash: 'x', name: 'Agg' },
      })
      userId = user.id
    })

    await withOrganization(orgId, async (tx) => {
      const ws = await tx.workspace.create({
        data: omitTenancy({ name: 'Agg WS', slug: `agg-${stamp}` }),
      })
      workspaceId = ws.id
      await tx.membership.create({ data: omitTenancy({ userId, workspaceId, role: 'OWNER' }) })
    })

    await withTenant(workspaceId, async (tx) => {
      const account = await tx.socialAccount.create({
        data: omitTenancy({
          organizationId: orgId,
          provider: 'mock',
          providerAccountId: `agg-${stamp}`,
          handle: '@agg',
          displayName: 'Agg',
          surfaces: ['feed'],
        }),
        select: { id: true },
      })
      accountId = account.id
    })
  }, 60_000)

  afterEach(async () => {
    await withSystemScope('aggregate reset', async () => {
      await client.analyticsSnapshot.deleteMany({ where: { workspaceId } })
      await client.postMetric.deleteMany({ where: { workspaceId } })
      await client.post.deleteMany({ where: { workspaceId } })
    })
  })

  afterAll(async () => {
    await withSystemScope('aggregate teardown', async () => {
      await client.organization.delete({ where: { id: orgId } })
      await client.user.delete({ where: { id: userId } })
    })
    await client.$disconnect()
  }, 30_000)

  /** A published variant with a set of readings attached. */
  async function seed(
    readings: Array<{ at: Date; impressions?: number | null; reach?: number | null }>
  ): Promise<string> {
    return withTenant(workspaceId, async (tx) => {
      const post = await tx.post.create({
        data: omitTenancy({
          organizationId: orgId,
          authorId: userId,
          baseContent: 'Aggregated',
          status: 'PUBLISHED',
        }),
        select: { id: true },
      })
      const variant = await tx.postVariant.create({
        data: omitTenancy({
          organizationId: orgId,
          postId: post.id,
          socialAccountId: accountId,
          surface: 'feed',
          status: 'PUBLISHED',
          publishedAt: during,
        }),
        select: { id: true },
      })

      for (const reading of readings) {
        await tx.postMetric.create({
          data: omitTenancy({
            postVariantId: variant.id,
            capturedAt: reading.at,
            impressions: reading.impressions ?? null,
            reach: reading.reach ?? null,
          }),
        })
      }
      return variant.id
    })
  }

  async function run() {
    const { aggregateAnalytics } = await import('./aggregate.js')
    return aggregateAnalytics()
  }

  async function snapshots() {
    return withAggregator(async (tx) =>
      tx.analyticsSnapshot.findMany({
        where: { workspaceId, day: today },
        orderBy: { socialAccountId: { sort: 'asc', nulls: 'first' } },
      })
    )
  }

  it('counts the latest reading per variant, not every reading', async () => {
    // THE bug this kind of job is born with. Six polls of one post is one post,
    // at its highest-water mark — summing them turns polling frequency into
    // apparent growth.
    await seed([
      { at: new Date(during.getTime() - 3 * 3_600_000), impressions: 100 },
      { at: new Date(during.getTime() - 2 * 3_600_000), impressions: 180 },
      { at: during, impressions: 240 },
    ])

    await run()
    const rows = await snapshots()
    const workspaceRow = rows.find((r) => r.socialAccountId === null)

    expect(workspaceRow?.impressions).toBe(240)
    expect(workspaceRow?.sampleSize).toBe(1)
  })

  it('sums across variants', async () => {
    await seed([{ at: during, impressions: 100 }])
    await seed([{ at: during, impressions: 50 }])

    await run()
    const workspaceRow = (await snapshots()).find((r) => r.socialAccountId === null)

    expect(workspaceRow?.impressions).toBe(150)
    expect(workspaceRow?.sampleSize).toBe(2)
  })

  it('keeps a metric nobody reported as null, not zero', async () => {
    // "We measured nothing" and "we measured zero" are different claims, and a
    // chart that renders the first as the second invents a cliff.
    await seed([{ at: during, impressions: 100, reach: null }])

    await run()
    const workspaceRow = (await snapshots()).find((r) => r.socialAccountId === null)

    expect(workspaceRow?.impressions).toBe(100)
    expect(workspaceRow?.reach).toBeNull()
  })

  it('ignores a null contribution rather than counting it as zero', async () => {
    await seed([{ at: during, impressions: 100, reach: 40 }])
    await seed([{ at: during, impressions: 60, reach: null }])

    await run()
    const workspaceRow = (await snapshots()).find((r) => r.socialAccountId === null)

    expect(workspaceRow?.impressions).toBe(160)
    // 40, not 20: the variant that reported nothing is absent from the total,
    // not a zero dragging an average down.
    expect(workspaceRow?.reach).toBe(40)
  })

  it('writes a per-account row alongside the workspace total', async () => {
    await seed([{ at: during, impressions: 100 }])

    await run()
    const rows = await snapshots()

    expect(rows).toHaveLength(2)
    expect(rows.find((r) => r.socialAccountId === null)?.impressions).toBe(100)
    expect(rows.find((r) => r.socialAccountId === accountId)?.impressions).toBe(100)
  })

  it('replaces a day on re-run rather than duplicating it', async () => {
    // The job rewrites a trailing week on every tick, so this happens
    // constantly. Without the unique index it would double every total each
    // time the worker ran.
    await seed([{ at: during, impressions: 100 }])

    await run()
    await run()
    await run()

    const rows = await snapshots()
    expect(rows).toHaveLength(2)
    expect(rows.find((r) => r.socialAccountId === null)?.impressions).toBe(100)
  })

  it('picks up a late-arriving metric on the next run', async () => {
    // The reason a trailing window is rewritten rather than each day computed
    // once. Provider numbers keep moving for days.
    const variantId = await seed([{ at: during, impressions: 100 }])
    await run()

    await withTenant(workspaceId, async (tx) => {
      await tx.postMetric.create({
        data: omitTenancy({
          postVariantId: variantId,
          capturedAt: new Date(during.getTime() + 3_600_000),
          impressions: 500,
        }),
      })
    })
    await run()

    const workspaceRow = (await snapshots()).find((r) => r.socialAccountId === null)
    expect(workspaceRow?.impressions).toBe(500)
  })

  it('writes no row for a day with nothing measured and nothing published', async () => {
    // An empty snapshot per workspace per day would be most of the table.
    await run()
    expect(await snapshots()).toEqual([])
  })

  it('reads nothing without the aggregator actor', async () => {
    // The eighth instance of the pattern: a cross-cutting query that precedes
    // tenancy returns zero rows under RLS while nothing errors.
    await seed([{ at: during, impressions: 100 }])
    await run()

    const app = createTestClient(dbUrl!)
    try {
      const rows = await app.$queryRawUnsafe<unknown[]>('SELECT * FROM "AnalyticsSnapshot"')
      expect(rows).toEqual([])
    } finally {
      await app.$disconnect()
    }
  })
})
