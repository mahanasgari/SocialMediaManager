import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  createTestClient,
  withOrganization,
  withSystemScope,
  withTenant,
  type Db,
} from '@smm/database'

/**
 * Expanding recurring schedules into real scheduled posts.
 *
 * The pure date arithmetic is tested in packages/content — including both
 * daylight-saving boundaries. What is tested here is the part that touches the
 * database, and specifically the three properties that make expansion safe to
 * run on every tick of every worker:
 *
 *   1. It is IDEMPOTENT. It runs twice a minute forever against overlapping
 *      windows, and must produce one post per occurrence regardless.
 *   2. It never back-fills. A schedule created today does not invent last
 *      month, and a worker that was down does not publish into the past.
 *   3. Editing a generated post STICKS. Expansion fills gaps; it does not
 *      reconcile the calendar back to the rule.
 */

const dbUrl = process.env['TEST_DATABASE_URL']
const ownerUrl = process.env['TEST_DATABASE_OWNER_URL'] ?? dbUrl

const suite = dbUrl ? describe : describe.skip
if (!dbUrl) console.warn('\n  [skipped] recurrence expansion — run: bash scripts/test-db.sh up\n')

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const omitTenancy = <T,>(data: T) => data as any

let client: Db
let orgId: string
let userId: string
let workspaceId: string
let accountId: string

suite('expanding recurring schedules', () => {
  beforeAll(async () => {
    client = createTestClient(ownerUrl!)
    const stamp = Date.now()

    await withSystemScope('recurrence fixture', async () => {
      const org = await client.organization.create({
        data: { name: 'Recur Org', slug: `recur-${stamp}` },
      })
      orgId = org.id
      const user = await client.user.create({
        data: { email: `recur-${stamp}@example.com`, passwordHash: 'x', name: 'Recur' },
      })
      userId = user.id
    })

    await withOrganization(
      orgId,
      async (tx) => {
        const ws = await tx.workspace.create({
          data: omitTenancy({ name: 'Recur WS', slug: `recur-${stamp}` }),
        })
        workspaceId = ws.id
        await tx.membership.create({ data: omitTenancy({ userId, workspaceId, role: 'OWNER' }) })
      },
      client
    )

    await withTenant(
      workspaceId,
      async (tx) => {
        const account = await tx.socialAccount.create({
          data: omitTenancy({
            organizationId: orgId,
            provider: 'mock',
            providerAccountId: `recur-${stamp}`,
            handle: '@recur',
            displayName: 'Recur',
            surfaces: ['feed'],
            status: 'ACTIVE',
          }),
          select: { id: true },
        })
        accountId = account.id
      },
      client
    )
  }, 60_000)

  beforeEach(async () => {
    process.env['DATABASE_URL'] = ownerUrl!
    await withSystemScope('recurrence reset', async () => {
      // Posts first: they hold the foreign key.
      await client.post.deleteMany({ where: { workspaceId } })
      await client.recurrence.deleteMany({ where: { workspaceId } })

      // Then every OTHER active rule, deployment-wide.
      //
      // expandRecurrences() sweeps the whole deployment — that is what a
      // scheduler does — so `result.rules` is a deployment-wide count and an
      // assertion like `toBe(0)` quietly depends on no rule existing anywhere
      // else. A leftover from a manual session was counted and the test failed
      // for reasons having nothing to do with the code it covers. Same latent
      // flaw as exports.test.ts, which processes one job per call globally.
      await client.recurrence.updateMany({
        where: { workspaceId: { not: workspaceId }, active: true },
        data: { active: false },
      })
    })
  })

  afterAll(async () => {
    await withSystemScope('recurrence teardown', async () => {
      await client.organization.delete({ where: { id: orgId } })
      await client.user.delete({ where: { id: userId } })
    })
    await client.$disconnect()
  }, 30_000)

  // -------------------------------------------------------------------------

  /** A daily 09:00 rule, starting today in the given zone. */
  async function createRule(
    over: Record<string, unknown> = {},
    timezone = 'Europe/Berlin'
  ): Promise<string> {
    return withTenant(
      workspaceId,
      async (tx) => {
        const rule = await tx.recurrence.create({
          data: omitTenancy({
            organizationId: orgId,
            name: 'Daily nine',
            freq: 'DAILY',
            interval: 1,
            byWeekday: [],
            hour: 9,
            minute: 0,
            timezone,
            startsOn: new Date().toISOString().slice(0, 10),
            content: 'Good morning.',
            accountIds: [accountId],
            createdById: userId,
            active: true,
            ...over,
          }),
          select: { id: true },
        })
        return rule.id
      },
      client
    )
  }

  const posts = () =>
    withTenant(
      workspaceId,
      async (tx) =>
        tx.post.findMany({
          where: { recurrenceId: { not: null } },
          orderBy: { occurrenceAt: 'asc' },
          select: {
            id: true,
            baseContent: true,
            status: true,
            scheduledAt: true,
            occurrenceAt: true,
            timezone: true,
            variants: { select: { id: true, socialAccountId: true } },
          },
        }),
      client
    )

  describe('materialising', () => {
    it('creates a scheduled post per occurrence, with variants', async () => {
      await createRule()
      const { expandRecurrences } = await import('./recurrence.js')

      const result = await expandRecurrences()
      expect(result.created).toBeGreaterThan(50)

      const created = await posts()
      expect(created[0]!.status).toBe('SCHEDULED')
      expect(created[0]!.baseContent).toBe('Good morning.')
      // A variant per account, so the scanner has something to publish. A post
      // with no variants would sit SCHEDULED forever and never go anywhere.
      expect(created[0]!.variants).toHaveLength(1)
      expect(created[0]!.variants[0]!.socialAccountId).toBe(accountId)
    })

    it('keeps the rule’s zone on the post, so the calendar can render it back', async () => {
      await createRule({}, 'Asia/Kolkata')
      const { expandRecurrences } = await import('./recurrence.js')
      await expandRecurrences()

      const created = await posts()
      expect(created[0]!.timezone).toBe('Asia/Kolkata')
    })

    it('stops at the horizon rather than expanding an endless rule forever', async () => {
      // "Every day, no end date" is infinite. Sixty days is far enough that the
      // calendar looks populated and near enough that editing the rule does not
      // orphan a year of stale copies.
      await createRule()
      const { expandRecurrences } = await import('./recurrence.js')
      await expandRecurrences()

      const created = await posts()
      const furthest = created.at(-1)!.occurrenceAt!
      const daysAhead = (furthest.getTime() - Date.now()) / 86_400_000

      expect(daysAhead).toBeLessThanOrEqual(61)
      expect(created.length).toBeLessThanOrEqual(62)
    })

    it('does NOT back-fill the past', async () => {
      // A schedule that started last month should not invent four weeks of
      // posts whose time has already passed — the scanner would mark every one
      // of them MISSED on the next tick.
      const lastMonth = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10)
      await createRule({ startsOn: lastMonth })

      const { expandRecurrences } = await import('./recurrence.js')
      await expandRecurrences()

      const created = await posts()
      const earliest = created[0]!.occurrenceAt!
      expect(earliest.getTime()).toBeGreaterThanOrEqual(Date.now() - 60_000)
    })
  })

  describe('idempotency', () => {
    it('produces one post per occurrence however many times it runs', async () => {
      // The property that matters most: this runs twice a minute, forever,
      // against deliberately overlapping windows.
      await createRule()
      const { expandRecurrences } = await import('./recurrence.js')

      const first = await expandRecurrences()
      const countAfterFirst = (await posts()).length

      const second = await expandRecurrences()
      const countAfterSecond = (await posts()).length

      expect(countAfterSecond).toBe(countAfterFirst)
      expect(first.created).toBeGreaterThan(0)
      // The second pass finds the rule already expanded past the horizon and
      // does no work at all — the steady state.
      expect(second.created).toBe(0)
    })

    it('is safe even when the saved position is thrown away', async () => {
      // Simulates a crash between creating posts and recording expandedUntil.
      // Re-running the window must be free rather than duplicating everything.
      const ruleId = await createRule()
      const { expandRecurrences } = await import('./recurrence.js')

      await expandRecurrences()
      const before = (await posts()).length

      await withSystemScope('forget the saved position', async () => {
        await client.recurrence.update({ where: { id: ruleId }, data: { expandedUntil: null } })
      })

      const again = await expandRecurrences()
      expect((await posts()).length).toBe(before)
      // Every occurrence collided with the unique index rather than being made
      // a second time.
      expect(again.skipped).toBeGreaterThan(0)
      expect(again.created).toBe(0)
    })
  })

  describe('what expansion does not touch', () => {
    it('leaves an EDITED post alone', async () => {
      // Generated posts are real rows, not a projection. Somebody rewording
      // next Tuesday's copy must not have it silently reverted on the next tick.
      await createRule()
      const { expandRecurrences } = await import('./recurrence.js')
      await expandRecurrences()

      const [first] = await posts()
      await withTenant(
        workspaceId,
        async (tx) => {
          await tx.post.update({
            where: { id: first!.id },
            data: { baseContent: 'Edited by a person.' },
          })
        },
        client
      )

      await expandRecurrences()

      const after = await posts()
      expect(after.find((p) => p.id === first!.id)!.baseContent).toBe('Edited by a person.')
    })

    it('ignores a paused schedule', async () => {
      await createRule({ active: false })
      const { expandRecurrences } = await import('./recurrence.js')
      const result = await expandRecurrences()

      expect(result.rules).toBe(0)
      expect(await posts()).toEqual([])
    })

    it('ignores a deleted schedule', async () => {
      await createRule({ deletedAt: new Date() })
      const { expandRecurrences } = await import('./recurrence.js')
      await expandRecurrences()
      expect(await posts()).toEqual([])
    })
  })

  describe('accounts', () => {
    it('re-reads accounts at expansion, skipping one that has been disconnected', async () => {
      // The rule was written when the account worked. A variant pointing at a
      // dead account fails at publish time — weeks later, for a post nobody has
      // looked at — so it is checked when the post is made instead.
      await withTenant(
        workspaceId,
        async (tx) => {
          await tx.socialAccount.update({
            where: { id: accountId },
            data: { status: 'DISCONNECTED' },
          })
        },
        client
      )

      await createRule()
      const { expandRecurrences } = await import('./recurrence.js')
      await expandRecurrences()

      const created = await posts()
      expect(created.length).toBeGreaterThan(0)
      // The post exists — the schedule is still valid and the author can fix
      // the account — but it carries no variant for the dead one.
      expect(created[0]!.variants).toEqual([])

      await withTenant(
        workspaceId,
        async (tx) => {
          await tx.socialAccount.update({ where: { id: accountId }, data: { status: 'ACTIVE' } })
        },
        client
      )
    })
  })

  describe('failures', () => {
    it('one broken rule does not stop the others', async () => {
      // A zone that no longer exists in the tz database throws inside Intl.
      // Without isolation it would take every other schedule down with it.
      await createRule({ name: 'Broken', timezone: 'Mars/Olympus_Mons' })
      await createRule({ name: 'Fine' })

      const { expandRecurrences } = await import('./recurrence.js')
      const result = await expandRecurrences()

      expect(result.failed).toBe(1)
      expect(result.created).toBeGreaterThan(0)
    })
  })
})
