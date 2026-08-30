import { decrypt, keyProvider, withScheduler } from '@smm/database'
// Shared with the API, which signs test deliveries. If these diverged, a
// customer would verify our tests and not our real events — a failure that
// only shows up in production, on somebody else's system.
import { sign } from '@smm/integrations'

/**
 * Outbound webhook delivery.
 *
 * DELIVERY IS AT-LEAST-ONCE. A dispatcher can crash after the HTTP call and
 * before recording the result, and the only safe response is to send again — so
 * every consumer must be idempotent, and `X-SMM-Delivery` is the id they should
 * key on.
 *
 * Not to be confused with the INBOUND receiver (Phase 6). They share a word and
 * nothing else: not auth, not retry semantics, not failure modes.
 */

/** 1m, 5m, 15m, 1h, 6h. Then the endpoint is left disabled. */
const BACKOFF_MINUTES = [1, 5, 15, 60, 360] as const

/** Consecutive failures before an endpoint is switched off. */
const DISABLE_AFTER = 20

const TIMEOUT_MS = 10_000

export type DeliveryResult = { sent: number; failed: number; disabled: number }

/**
 * Signs the payload.
 *
 * The signature covers `timestamp.body` rather than the body alone, so a
 * captured request cannot be replayed later — the receiver rejects a timestamp
 * older than its tolerance, and altering it invalidates the signature.
 */
export async function dispatchWebhooks(now: Date = new Date()): Promise<DeliveryResult> {
  const result: DeliveryResult = { sent: 0, failed: 0, disabled: 0 }

  const due = await withScheduler(async (tx) =>
    tx.webhookDelivery.findMany({
      where: {
        deliveredAt: null,
        OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: now } }],
      },
      select: {
        id: true,
        workspaceId: true,
        webhookId: true,
        eventType: true,
        payload: true,
        attempt: true,
        webhook: {
          select: { url: true, signingSecret: true, enabled: true, consecutiveFailures: true },
        },
      },
      orderBy: { createdAt: 'asc' },
      take: 50,
    })
  )

  for (const delivery of due) {
    if (!delivery.webhook.enabled) continue

    const body = JSON.stringify({
      id: delivery.id,
      type: delivery.eventType,
      createdAt: now.toISOString(),
      data: delivery.payload,
    })

    const secret = decrypt(delivery.webhook.signingSecret, keyProvider())
    const timestamp = Math.floor(now.getTime() / 1000)

    let status: number | null = null
    let responseBody = ''

    try {
      // A slow endpoint must not stall the queue behind it. Ten seconds is
      // generous for a webhook and short enough that fifty of them cannot
      // occupy a tick indefinitely.
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

      const response = await fetch(delivery.webhook.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-smm-signature': sign(body, secret, timestamp),
          'x-smm-event': delivery.eventType,
          'x-smm-delivery': delivery.id,
        },
        body,
        signal: controller.signal,
      })
      clearTimeout(timer)

      status = response.status
      // Bounded: an endpoint returning a megabyte of HTML should not put a
      // megabyte of HTML in our database on every retry.
      responseBody = (await response.text().catch(() => '')).slice(0, 2000)
    } catch (err) {
      responseBody = err instanceof Error ? err.message.slice(0, 500) : 'request failed'
    }

    const ok = status !== null && status >= 200 && status < 300
    await recordAttempt(delivery, ok, status, responseBody, now, result)
  }

  return result
}

async function recordAttempt(
  delivery: { id: string; webhookId: string; attempt: number; webhook: { consecutiveFailures: number } },
  ok: boolean,
  status: number | null,
  responseBody: string,
  now: Date,
  result: DeliveryResult
): Promise<void> {
  await withScheduler(async (tx) => {
    if (ok) {
      await tx.webhookDelivery.update({
        where: { id: delivery.id },
        data: { deliveredAt: now, responseStatus: status, responseBody, nextRetryAt: null },
      })
      // A success clears the failure streak; otherwise an endpoint that was
      // briefly down would eventually be disabled despite working again.
      await tx.webhook.update({
        where: { id: delivery.webhookId },
        data: { consecutiveFailures: 0 },
      })
      result.sent++
      return
    }

    const attempt = delivery.attempt + 1
    const exhausted = attempt > BACKOFF_MINUTES.length
    const minutes = BACKOFF_MINUTES[Math.min(delivery.attempt - 1, BACKOFF_MINUTES.length - 1)] ?? 360

    await tx.webhookDelivery.update({
      where: { id: delivery.id },
      data: {
        attempt,
        responseStatus: status,
        responseBody,
        // Exhausted deliveries stay undelivered with no retry scheduled, rather
        // than being deleted. "Why did my endpoint never fire?" is unanswerable
        // without the record of what we tried.
        nextRetryAt: exhausted ? null : new Date(now.getTime() + minutes * 60_000),
      },
    })

    const failures = delivery.webhook.consecutiveFailures + 1
    const shouldDisable = failures >= DISABLE_AFTER

    await tx.webhook.update({
      where: { id: delivery.webhookId },
      data: {
        consecutiveFailures: failures,
        ...(shouldDisable ? { enabled: false, disabledAt: now } : {}),
      },
    })

    result.failed++
    if (shouldDisable) result.disabled++
  })
}

/**
 * Queues an event for every endpoint subscribed to it.
 *
 * Called from the publishing pipeline and elsewhere. Writing rows rather than
 * calling out directly is what makes delivery survivable: the HTTP call happens
 * later, outside whatever transaction produced the event.
 */
export async function enqueueEvent(
  workspaceId: string,
  eventType: string,
  payload: Record<string, unknown>
): Promise<number> {
  return withScheduler(async (tx) => {
    const hooks = await tx.webhook.findMany({
      where: { workspaceId, enabled: true, events: { has: eventType } },
      select: { id: true },
    })

    for (const hook of hooks) {
      await tx.webhookDelivery.create({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        data: { workspaceId, webhookId: hook.id, eventType, payload: payload as object } as any,
      })
    }

    return hooks.length
  })
}
