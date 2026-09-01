import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  createTestClient,
  outbox,
  withOrganization,
  withSystemScope,
  withTenant,
  type Db,
} from '@smm/database'

/**
 * The transactional outbox, end to end.
 *
 * Until this work the table existed, the helpers existed, and nothing called
 * any of them — so a workspace could subscribe a webhook to `post.published`,
 * see it listed as enabled, and wait forever. These tests exist to keep that
 * from being true again, and they assert the three properties the design rests
 * on rather than merely that rows appear:
 *
 *   1. The event commits WITH the domain write, or not at all.
 *   2. Delivery is at-least-once, so consumers must be idempotent.
 *   3. A failing event backs off and stays visible instead of vanishing.
 */

const dbUrl = process.env['TEST_DATABASE_URL']
const ownerUrl = process.env['TEST_DATABASE_OWNER_URL'] ?? dbUrl

const suite = dbUrl ? describe : describe.skip
if (!dbUrl) console.warn('\n  [skipped] outbox — run: bash scripts/test-db.sh up\n')

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const omitTenancy = <T,>(data: T) => data as any

let client: Db
let orgId: string
let userId: string
let workspaceId: string
let variantId: string

suite('the transactional outbox', () => {
  beforeAll(async () => {
    client = createTestClient(ownerUrl!)
    const stamp = Date.now()

    await withSystemScope('outbox fixture', async () => {
      const org = await client.organization.create({
        data: { name: 'Outbox Org', slug: `outbox-${stamp}` },
      })
      orgId = org.id
      const user = await client.user.create({
        data: { email: `outbox-${stamp}@example.com`, passwordHash: 'x', name: 'Outbox' },
      })
      userId = user.id
    })

    await withOrganization(
      orgId,
      async (tx) => {
        const ws = await tx.workspace.create({
          data: omitTenancy({ name: 'Outbox WS', slug: `outbox-${stamp}` }),
        })
        workspaceId = ws.id
        // An EDITOR, so the notification consumer has somebody to tell.
        await tx.membership.create({ data: omitTenancy({ userId, workspaceId, role: 'EDITOR' }) })
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
            providerAccountId: `outbox-${stamp}`,
            handle: '@outbox',
            displayName: 'Outbox',
            surfaces: ['feed'],
          }),
          select: { id: true },
        })
        const post = await tx.post.create({
          data: omitTenancy({
            organizationId: orgId,
            authorId: userId,
            baseContent: 'outbox fixture',
            status: 'SCHEDULED',
          }),
          select: { id: true },
        })
        const variant = await tx.postVariant.create({
          data: omitTenancy({
            organizationId: orgId,
            postId: post.id,
            socialAccountId: account.id,
            surface: 'feed',
            status: 'QUEUED',
          }),
          select: { id: true },
        })
        variantId = variant.id
      },
      client
    )
  }, 60_000)

  beforeEach(async () => {
    process.env['DATABASE_URL'] = ownerUrl!
    await withSystemScope('outbox test reset', async () => {
      // EVERY outbox row, not only this workspace's.
      //
      // The dispatcher is global by design — one worker drains the whole
      // deployment — so its result counts are deployment-wide. Leaving another
      // workspace's events pending makes `dispatched` include them and every
      // assertion here approximate.
      await client.outbox.deleteMany({})
      await client.webhookDelivery.deleteMany({ where: { workspaceId } })
      await client.notification.deleteMany({ where: { workspaceId } })
      await client.webhook.deleteMany({ where: { workspaceId } })
    })
  })

  afterAll(async () => {
    await withSystemScope('outbox teardown', async () => {
      await client.organization.delete({ where: { id: orgId } })
      await client.user.delete({ where: { id: userId } })
    })
    await client.$disconnect()
  }, 30_000)

  // -------------------------------------------------------------------------

  async function subscribe(events: string[]): Promise<string> {
    return withTenant(
      workspaceId,
      async (tx) => {
        const hook = await tx.webhook.create({
          data: omitTenancy({
            organizationId: orgId,
            url: 'https://example.test/hook',
            signingSecret: 'shhh',
            events,
            enabled: true,
          }),
          select: { id: true },
        })
        return hook.id
      },
      client
    )
  }

  /**
   * Counts scoped to THIS workspace, explicitly.
   *
   * Outbox is deliberately exempt from the tenancy guard — it is drained by a
   * system principal that must see every workspace, which is the whole point of
   * a dispatcher. So a query against it inside withTenant() is NOT filtered,
   * and counting without naming the workspace counts the entire deployment.
   *
   * Worth stating rather than quietly fixing: the same trap is waiting for any
   * future code that reads this table and assumes tenancy applies.
   */
  const countAll = () =>
    withTenant(
      workspaceId,
      async (tx) => ({
        pending: await tx.outbox.count({ where: { workspaceId, status: 'PENDING' } }),
        dispatched: await tx.outbox.count({ where: { workspaceId, status: 'DISPATCHED' } }),
        deliveries: await tx.webhookDelivery.count(),
        notifications: await tx.notification.count(),
      }),
      client
    )

  describe('emitting', () => {
    it('commits the event WITH the domain write', async () => {
      await withTenant(
        workspaceId,
        async (tx) => {
          await tx.postVariant.update({ where: { id: variantId }, data: { status: 'PUBLISHED' } })
          await outbox.emit(tx, {
            aggregateType: 'PostVariant',
            aggregateId: variantId,
            eventType: 'post.published',
            workspaceId,
            payload: { variantId },
          })
        },
        client
      )

      expect((await countAll()).pending).toBe(1)
    })

    it('discards the event when the domain write ROLLS BACK', async () => {
      // The property the whole mechanism rests on. Emitting after the commit
      // instead would leave a window where the post is live and the event never
      // happened — and the inverse, an event for a write that was undone, is a
      // subscriber told about something that did not occur.
      await expect(
        withTenant(
          workspaceId,
          async (tx) => {
            await outbox.emit(tx, {
              aggregateType: 'PostVariant',
              aggregateId: variantId,
              eventType: 'post.published',
              workspaceId,
              payload: { variantId },
            })
            throw new Error('the domain write failed')
          },
          client
        )
      ).rejects.toThrow('the domain write failed')

      expect((await countAll()).pending).toBe(0)
    })
  })

  describe('dispatching', () => {
    it('writes one delivery per subscribed endpoint, and none for others', async () => {
      await subscribe(['post.published'])
      await subscribe(['post.missed'])

      await withTenant(
        workspaceId,
        async (tx) =>
          outbox.emit(tx, {
            aggregateType: 'PostVariant',
            aggregateId: variantId,
            eventType: 'post.published',
            workspaceId,
            payload: { variantId },
          }),
        client
      )

      const { dispatchOutbox } = await import('./outbox.js')
      const result = await dispatchOutbox()

      expect(result.dispatched).toBe(1)
      // Only the hook that asked for this event. A subscriber that receives
      // events it did not subscribe to learns to ignore the feed.
      expect(result.deliveries).toBe(1)
    })

    it('is IDEMPOTENT: draining the same event twice sends one delivery', async () => {
      // Delivery is at-least-once by design — the dispatcher can crash after
      // writing the row and before marking the event dispatched. Without the
      // dedupe key, that crash sends every subscriber a duplicate.
      await subscribe(['post.published'])

      const emitted = await withTenant(
        workspaceId,
        async (tx) => {
          await outbox.emit(tx, {
            aggregateType: 'PostVariant',
            aggregateId: variantId,
            eventType: 'post.published',
            workspaceId,
            payload: { variantId },
          })
          return tx.outbox.findFirst({ where: { workspaceId }, select: { id: true } })
        },
        client
      )

      const { dispatchOutbox } = await import('./outbox.js')
      await dispatchOutbox()

      // Simulate the crash: the row was delivered but never marked.
      await withSystemScope('simulate a crash before marking dispatched', async () => {
        await client.outbox.update({
          where: { id: emitted!.id },
          data: { status: 'PENDING', dispatchedAt: null },
        })
      })

      await dispatchOutbox()

      expect((await countAll()).deliveries).toBe(1)
    })

    it('notifies people who can ACT on a failure', async () => {
      await withTenant(
        workspaceId,
        async (tx) =>
          outbox.emit(tx, {
            aggregateType: 'PostVariant',
            aggregateId: variantId,
            eventType: 'post.failed',
            workspaceId,
            payload: { variantId, code: 'ContentRejected', message: 'Too long for this network.' },
          }),
        client
      )

      const { dispatchOutbox } = await import('./outbox.js')
      const result = await dispatchOutbox()

      expect(result.notifications).toBe(1)

      const notice = await withTenant(
        workspaceId,
        async (tx) => tx.notification.findFirst({ where: { kind: 'post.failed' } }),
        client
      )
      // The provider's own message, not a code. A person told "ContentRejected"
      // has to go and look it up.
      expect(notice!.body).toContain('Too long for this network.')
    })

    it('stays SILENT on a successful publish', async () => {
      // A notification per publish is a hundred a day on an active workspace,
      // and the ones that matter are lost among them.
      await withTenant(
        workspaceId,
        async (tx) =>
          outbox.emit(tx, {
            aggregateType: 'PostVariant',
            aggregateId: variantId,
            eventType: 'post.published',
            workspaceId,
            payload: { variantId },
          }),
        client
      )

      const { dispatchOutbox } = await import('./outbox.js')
      const result = await dispatchOutbox()

      expect(result.dispatched).toBe(1)
      expect(result.notifications).toBe(0)
    })

    it('marks an event with no consumers dispatched rather than leaving it pending', async () => {
      // Nothing was owed. Leaving it PENDING would make it reappear every tick
      // forever, and a queue that never empties is one nobody can read.
      await withTenant(
        workspaceId,
        async (tx) =>
          outbox.emit(tx, {
            aggregateType: 'PostVariant',
            aggregateId: variantId,
            eventType: 'post.published',
            workspaceId,
            payload: { variantId },
          }),
        client
      )

      const { dispatchOutbox } = await import('./outbox.js')
      await dispatchOutbox()

      const counts = await countAll()
      expect(counts.pending).toBe(0)
      expect(counts.dispatched).toBe(1)
    })
  })

  describe('failure handling', () => {
    it('backs off and keeps the event, rather than dropping it', async () => {
      const emitted = await withTenant(
        workspaceId,
        async (tx) => {
          await outbox.emit(tx, {
            aggregateType: 'PostVariant',
            aggregateId: variantId,
            eventType: 'post.published',
            workspaceId,
            payload: { variantId },
          })
          return tx.outbox.findFirst({ where: { workspaceId }, select: { id: true } })
        },
        client
      )

      await outbox.markFailed(client, emitted!.id, 'the consumer exploded')

      const row = await withSystemScope('read back', async () =>
        client.outbox.findUnique({ where: { id: emitted!.id } })
      )

      expect(row!.attempts).toBe(1)
      expect(row!.status).toBe('PENDING')
      expect(row!.nextRetryAt).toBeInstanceOf(Date)
      // The reason is kept. An event that failed with no recorded cause is one
      // nobody can diagnose.
      expect(row!.lastError).toContain('exploded')
    })

    it('gives up eventually, and leaves the row VISIBLE as FAILED', async () => {
      // Deleting it would destroy the only record that something did not
      // happen — which is exactly what somebody needs when they ask why.
      const emitted = await withTenant(
        workspaceId,
        async (tx) => {
          await outbox.emit(tx, {
            aggregateType: 'PostVariant',
            aggregateId: variantId,
            eventType: 'post.published',
            workspaceId,
            payload: { variantId },
          })
          return tx.outbox.findFirst({ where: { workspaceId }, select: { id: true } })
        },
        client
      )

      for (let i = 0; i < outbox.BACKOFF_MINUTES.length; i += 1) {
        await outbox.markFailed(client, emitted!.id, 'still broken')
      }

      const row = await withSystemScope('read back', async () =>
        client.outbox.findUnique({ where: { id: emitted!.id } })
      )

      expect(row!.status).toBe('FAILED')
      expect(row!.nextRetryAt).toBeNull()
    })

    it('a claim skips events whose retry time has not arrived', async () => {
      await withTenant(
        workspaceId,
        async (tx) =>
          outbox.emit(tx, {
            aggregateType: 'PostVariant',
            aggregateId: variantId,
            eventType: 'post.published',
            workspaceId,
            payload: { variantId },
          }),
        client
      )

      const [row] = await outbox.claimPending(client, 10)
      await outbox.markFailed(client, row!.id, 'not yet')

      // Backoff is a minute; nothing should come back now.
      const again = await outbox.claimPending(client, 10)
      expect(again.some((r) => r.id === row!.id)).toBe(false)

      // But it does once the clock passes the retry time.
      const later = await outbox.claimPending(client, 10, new Date(Date.now() + 120_000))
      expect(later.some((r) => r.id === row!.id)).toBe(true)
    })
  })
})
