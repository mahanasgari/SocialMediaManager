import { db, outbox, withTenant } from '@smm/database'
import { log } from '@smm/observability'

/**
 * Draining the transactional outbox.
 *
 * The piece the architecture specified and nobody wrote. Until now the table
 * existed, the emit and claim helpers existed, and nothing called any of them —
 * so no domain event was ever produced and no subscriber ever heard anything.
 * A workspace could subscribe a webhook to `post.published`, see it listed as
 * enabled, and wait forever. That is worse than an unbuilt feature, because it
 * looks finished.
 *
 * What this does is deliberately small: it turns a committed event row into the
 * side effects that follow from it — webhook deliveries and in-app
 * notifications — and it does nothing else. The HTTP calls happen elsewhere,
 * later, driven by their own rows, because a dispatcher that made network calls
 * would hold a transaction open across the internet.
 *
 * DELIVERY IS AT-LEAST-ONCE, and that is a requirement on every consumer rather
 * than a caveat. This process can crash after writing a delivery row and before
 * marking the event dispatched, and the only safe response is to run it again.
 * Both consumers below are therefore idempotent — see each for how.
 */

/** Per tick. Large enough to drain a burst, small enough not to own the tick. */
const BATCH = 100

export type OutboxResult = {
  claimed: number
  dispatched: number
  failed: number
  /** Webhook delivery rows written. Zero is normal — most workspaces have none. */
  deliveries: number
  notifications: number
}

const dispatcherLog = log.child({ service: 'worker', job: 'outbox' })

export async function dispatchOutbox(): Promise<OutboxResult> {
  const result: OutboxResult = {
    claimed: 0,
    dispatched: 0,
    failed: 0,
    deliveries: 0,
    notifications: 0,
  }

  const pending = await outbox.claimPending(db(), BATCH)
  result.claimed = pending.length
  if (pending.length === 0) return result

  const dispatched: string[] = []

  for (const event of pending) {
    try {
      // An event with no workspace has no consumers here — every side effect
      // below is workspace-scoped. Marking it dispatched rather than failing it
      // is correct: it was recorded, and nothing was owed.
      if (!event.workspaceId) {
        dispatched.push(event.id)
        continue
      }

      const payload = (event.payload ?? {}) as Record<string, unknown>

      const [deliveries, notifications] = await withTenant(event.workspaceId, async (tx) => [
        await fanOutToWebhooks(tx, event.id, event.workspaceId!, event.eventType, payload),
        await notifyPeople(tx, event.id, event.workspaceId!, event.eventType, payload),
      ])

      result.deliveries += deliveries
      result.notifications += notifications
      dispatched.push(event.id)
    } catch (err) {
      // One event failing must not stop the drain — the others have nothing to
      // do with it. This row keeps its backoff and comes round again.
      result.failed += 1
      await outbox.markFailed(db(), event.id, err instanceof Error ? err.message : String(err))
      dispatcherLog.error('outbox event could not be dispatched', {
        outboxId: event.id,
        eventType: event.eventType,
        err,
      })
    }
  }

  await outbox.markDispatched(db(), dispatched)
  result.dispatched = dispatched.length

  return result
}

/**
 * Writes one delivery row per subscribed endpoint.
 *
 * Rows rather than HTTP calls: the request happens later, from its own row,
 * with its own retries — so a slow customer endpoint cannot delay the drain and
 * a failed one is retried without re-deriving the event.
 *
 * IDEMPOTENT by construction. The delivery id is derived from the outbox event
 * and the webhook, so a redelivery after a crash collides with the row already
 * written rather than sending the same event twice.
 */
async function fanOutToWebhooks(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tx: any,
  outboxId: string,
  workspaceId: string,
  eventType: string,
  payload: Record<string, unknown>
): Promise<number> {
  const hooks = await tx.webhook.findMany({
    where: { enabled: true, events: { has: eventType } },
    select: { id: true },
  })

  if (hooks.length === 0) return 0

  const created = await tx.webhookDelivery.createMany({
    data: hooks.map((hook: { id: string }) => ({
      workspaceId,
      webhookId: hook.id,
      eventType,
      payload,
      // The natural key for this delivery. Two drains of the same event produce
      // the same value, and the unique index turns the second into a no-op.
      dedupeKey: `${outboxId}:${hook.id}`,
    })),
    skipDuplicates: true,
  })

  return created.count
}

/**
 * Tells the people who need to know.
 *
 * Only for outcomes a person must ACT on. A notification for every successful
 * publish would be a hundred a day on an active workspace, and the ones that
 * matter would be lost among them — so `post.published` deliberately produces
 * none.
 */
async function notifyPeople(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tx: any,
  outboxId: string,
  workspaceId: string,
  eventType: string,
  payload: Record<string, unknown>
): Promise<number> {
  const notice = noticeFor(eventType, payload)
  if (!notice) return 0

  // Everyone who could do something about it. A CLIENT or ANALYST cannot
  // republish a failed post, so telling them is noise they can only ignore.
  const members = await tx.membership.findMany({
    where: { role: { in: ['OWNER', 'ADMIN', 'MANAGER', 'EDITOR'] } },
    select: { userId: true },
  })

  if (members.length === 0) return 0

  const created = await tx.notification.createMany({
    data: members.map((member: { userId: string }) => ({
      workspaceId,
      userId: member.userId,
      kind: eventType,
      title: notice.title,
      body: notice.body,
      href: `/w/${workspaceId}/posts`,
      dedupeKey: `${outboxId}:${member.userId}`,
    })),
    skipDuplicates: true,
  })

  return created.count
}

function noticeFor(
  eventType: string,
  payload: Record<string, unknown>
): { title: string; body: string } | null {
  switch (eventType) {
    case 'post.missed':
      return {
        title: 'A post missed its scheduled time',
        body:
          'It was not published automatically, because posting hours late is usually worse ' +
          'than not posting. Publish it now or reschedule it.',
      }

    case 'post.failed':
      return {
        title: 'A post could not be published',
        body: String(payload['message'] ?? 'The platform rejected it.'),
      }

    // Published is deliberately silent. See notifyPeople.
    default:
      return null
  }
}
