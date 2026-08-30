import type { Db } from './client.js'
import { withSystemScope } from './client.js'

/**
 * Transactional outbox.
 *
 * The problem it solves: a domain write and the queue job that must follow it
 * cannot both be made atomic, because the queue is a different system. Writing
 * the row and then enqueuing leaves a window where the process dies in between —
 * producing a SCHEDULED post that no worker ever picks up, with nothing in the
 * logs to say so.
 *
 * The outbox closes that window by making the enqueue part of the same
 * transaction: the domain row and the outbox row commit together, and a
 * dispatcher moves outbox rows into BullMQ afterwards.
 *
 * DELIVERY IS AT-LEAST-ONCE. This is not a caveat to be buried — it is a
 * requirement placed on every consumer. The dispatcher can crash after handing a
 * job to BullMQ and before marking the row dispatched, and the only safe
 * response is to send it again. Every consumer must therefore be idempotent, and
 * that is a review checklist item for each new one.
 */

export type OutboxEvent = {
  aggregateType: string
  aggregateId: string
  eventType: string
  payload: Record<string, unknown>
  organizationId?: string
  workspaceId?: string
}

/**
 * Records an event inside the CALLER'S transaction.
 *
 * `tx` must be the transactional client from withTenant()/withOrganization().
 * Passing the ambient client would defeat the entire mechanism by committing the
 * outbox row independently of the domain write — the precise failure this exists
 * to prevent.
 */
export async function emit(tx: Db, event: OutboxEvent): Promise<void> {
  await tx.outbox.create({
    data: {
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      eventType: event.eventType,
      payload: event.payload as object,
      organizationId: event.organizationId ?? null,
      workspaceId: event.workspaceId ?? null,
    },
  })
}

export type PendingOutboxRow = {
  id: string
  aggregateType: string
  aggregateId: string
  eventType: string
  payload: unknown
  organizationId: string | null
  workspaceId: string | null
  attempts: number
}

/**
 * Claims a batch of pending events for dispatch.
 *
 * `FOR UPDATE SKIP LOCKED` lets several dispatchers run without contending for
 * the same rows and without one blocking another — the same claiming strategy
 * the publish scanner uses in Phase 4.
 */
export async function claimPending(
  client: Db,
  limit = 100,
  now: Date = new Date()
): Promise<PendingOutboxRow[]> {
  return withSystemScope('outbox dispatcher drains across all workspaces', async () => {
    const rows = await client.$queryRaw<PendingOutboxRow[]>`
      SELECT "id", "aggregateType", "aggregateId", "eventType",
             "payload", "organizationId", "workspaceId", "attempts"
      FROM "Outbox"
      WHERE "status" = 'PENDING'
        AND ("nextRetryAt" IS NULL OR "nextRetryAt" <= ${now})
      ORDER BY "createdAt" ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    `
    return rows
  })
}

export async function markDispatched(client: Db, ids: string[]): Promise<void> {
  if (ids.length === 0) return
  await withSystemScope('outbox dispatcher marks its own claims', async () => {
    await client.outbox.updateMany({
      where: { id: { in: ids } },
      data: { status: 'DISPATCHED', dispatchedAt: new Date() },
    })
  })
}

/** Backoff schedule for a failed dispatch, in minutes. */
const BACKOFF_MINUTES = [1, 5, 15, 60, 360]

export async function markFailed(client: Db, id: string, error: string): Promise<void> {
  await withSystemScope('outbox dispatcher records its own failures', async () => {
    const row = await client.outbox.findUnique({ where: { id }, select: { attempts: true } })
    const attempts = (row?.attempts ?? 0) + 1
    const minutes = BACKOFF_MINUTES[Math.min(attempts - 1, BACKOFF_MINUTES.length - 1)] ?? 360
    const exhausted = attempts >= BACKOFF_MINUTES.length

    await client.outbox.update({
      where: { id },
      data: {
        attempts,
        lastError: error.slice(0, 1000),
        // Exhausted rows stay visible as FAILED rather than being deleted: an
        // event that never reached its consumer is exactly what someone needs to
        // see when they ask why something did not happen.
        status: exhausted ? 'FAILED' : 'PENDING',
        nextRetryAt: exhausted ? null : new Date(Date.now() + minutes * 60_000),
      },
    })
  })
}

export { BACKOFF_MINUTES }
