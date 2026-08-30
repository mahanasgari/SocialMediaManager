import { withScheduler, withTenant } from '@smm/database'
import { registry, type InboundEventShape } from '@smm/providers'

/**
 * The inbound dispatcher.
 *
 * Turns stored provider events into conversations and messages. It runs
 * SEPARATELY from the receiver on purpose: the receiver's only job is to verify
 * a signature, persist, and return 200 inside 200ms, because Meta disables
 * subscriptions that respond slowly and a disabled subscription is a silent
 * outage — comments simply stop arriving and nothing reports it.
 *
 * Everything expensive therefore happens here, where taking a second is fine.
 */

const BATCH = 50

export type InboxResult = { processed: number; failed: number; messages: number }

export async function dispatchInbound(): Promise<InboxResult> {
  const result: InboxResult = { processed: 0, failed: 0, messages: 0 }

  // Claimed under the scheduler actor because InboundEvent has no workspaceId —
  // an event arrives before we know whose it is, and deciding that is the whole
  // problem. The DELIVERY carries the workspace, and every write below happens
  // under that workspace's tenancy.
  const deliveries = await withScheduler(async (tx) =>
    tx.inboundEventDelivery.findMany({
      where: { status: 'PENDING' },
      select: {
        id: true,
        workspaceId: true,
        socialAccountId: true,
        event: { select: { provider: true, payload: true } },
      },
      orderBy: { createdAt: 'asc' },
      take: BATCH,
    })
  )

  for (const delivery of deliveries) {
    try {
      const provider = registry.get(delivery.event.provider as never)
      if (!provider?.parseWebhook) {
        // Verified but unparseable. Marked SKIPPED rather than FAILED: nothing
        // is wrong, we simply have no normaliser for this provider yet, and
        // burning retries on it would hide the deliveries that are genuinely
        // broken.
        await mark(delivery.id, 'SKIPPED', 'no parser for this provider')
        continue
      }

      const events = provider.parseWebhook(delivery.event.payload)
      const written = await applyEvents(delivery.workspaceId, delivery.socialAccountId, events)

      result.messages += written
      result.processed++
      await mark(delivery.id, 'PROCESSED', null)
    } catch (error) {
      result.failed++
      // One poisoned delivery must not stall the queue behind it. The error is
      // stored on the row so an operator can see WHICH event failed and why,
      // rather than finding a silent gap in a conversation.
      await mark(delivery.id, 'FAILED', error instanceof Error ? error.message : String(error))
    }
  }

  return result
}

async function mark(id: string, status: string, error: string | null): Promise<void> {
  await withScheduler(async (tx) => {
    await tx.inboundEventDelivery.update({
      where: { id },
      data: { status, error, processedAt: new Date() },
    })
  }).catch(() => undefined)
}

/**
 * Writes normalised events into a workspace's inbox.
 *
 * Returns the number of messages actually created — a redelivery writes zero,
 * which is the expected case rather than an error. Providers redeliver
 * aggressively, so "already have it" is normal traffic.
 */
export async function applyEvents(
  workspaceId: string,
  socialAccountId: string,
  events: InboundEventShape[]
): Promise<number> {
  if (events.length === 0) return 0

  return withTenant(workspaceId, async (tx) => {
    let created = 0

    for (const event of events) {
      const conversation = await tx.conversation.upsert({
        where: {
          socialAccountId_providerConversationId: {
            socialAccountId,
            providerConversationId: event.providerConversationId,
          },
        },
        create: {
          workspaceId,
          socialAccountId,
          providerConversationId: event.providerConversationId,
          kind: event.kind,
          subjectHandle: event.authorHandle,
          lastMessageAt: event.providerCreatedAt,
          // ZERO, not one. conversationUpdate below increments for every
          // message including the first, so seeding this at 1 double-counted
          // the opening message and showed "2 new" on a one-message thread.
          unreadCount: 0,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
        update: {},
        select: { id: true, lastMessageAt: true, status: true },
      })

      const existing = await tx.message.findFirst({
        where: { conversationId: conversation.id, providerMessageId: event.providerMessageId },
        select: { id: true },
      })
      // Dedupe on (conversation, providerMessageId). This is the SAME index the
      // polling reconciler writes through, which is what lets webhooks and
      // polling converge on one write path instead of two that disagree.
      if (existing) continue

      await tx.message.create({
         
        data: {
          workspaceId,
          conversationId: conversation.id,
          providerMessageId: event.providerMessageId,
          direction: 'IN',
          authorHandle: event.authorHandle,
          body: event.body,
          mediaUrls: event.mediaUrls ?? [],
          providerCreatedAt: event.providerCreatedAt,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
      })
      created++

      await tx.conversation.update({
        where: { id: conversation.id },
        data: conversationUpdate(conversation, event.providerCreatedAt),
      })
    }

    return created
  })
}

/**
 * What arriving message does to its conversation.
 *
 * Pure, and extracted because it holds the subtlest rule in the dispatcher:
 * lastMessageAt only ever moves FORWARD. Out-of-order delivery is routine
 * rather than exceptional, and since the inbox sorts on this column, letting an
 * older message arriving late write its own timestamp would drag an active
 * thread down the list and make it look like it had gone quiet.
 */
export function conversationUpdate(
  conversation: { lastMessageAt: Date; status: string },
  providerCreatedAt: Date
): {
  lastMessageAt?: Date
  unreadCount: { increment: number }
  status?: 'OPEN'
} {
  return {
    ...(providerCreatedAt > conversation.lastMessageAt
      ? { lastMessageAt: providerCreatedAt }
      : {}),
    // Incremented even for a late-arriving message: it is still unread, whatever
    // order it turned up in.
    unreadCount: { increment: 1 },
    // A new message REOPENS an archived conversation. Someone replying to a
    // thread that was closed is precisely the case where staying archived loses
    // the message. SNOOZED is left alone — snoozing is a deliberate "not now",
    // and undoing it on every arrival makes the button useless.
    ...(conversation.status === 'ARCHIVED' ? { status: 'OPEN' as const } : {}),
  }
}
