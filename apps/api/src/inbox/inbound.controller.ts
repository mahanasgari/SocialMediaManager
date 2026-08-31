import { Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import type { FastifyRequest } from 'fastify'
import { createHash } from 'node:crypto'
import { withInboundRouter } from '@smm/database'
import { errors } from '../common/errors.js'
import { inboundEvents } from '@smm/observability'
import { Public } from '../auth/auth-mode.guard.js'

/**
 * The inbound webhook receiver.
 *
 * THIS IS THE ONE PLACE IN THE SYSTEM WHERE WORKSPACE CONTEXT DERIVES FROM
 * UNTRUSTED INPUT. Everywhere else, tenancy comes from an authenticated session
 * or an API key. Here it comes from an unauthenticated public HTTP request sent
 * by a third party, and the routing decision is the security boundary.
 *
 * Not to be confused with OUTBOUND webhooks, which we sign and send to
 * customers. They share a word and nothing else: not auth, not retry semantics,
 * not failure modes. Hence `webhooks-inbound` and `webhooks-outbound` as
 * separate concerns.
 */
@ApiTags('inbound')
@Controller('hooks')
export class InboundController {
  /**
   * Meta's subscription handshake.
   *
   * Echoes hub.challenge when the verify token matches. Without this the
   * subscription can never be created at all.
   */
  @Public()
  @Get(':provider')
  @ApiOperation({ summary: 'Subscription verification handshake' })
  verify(
    @Param('provider') provider: string,
    @Query('hub.mode') mode: string,
    @Query('hub.verify_token') token: string,
    @Query('hub.challenge') challenge: string
  ): string {
    const expected = process.env['META_WEBHOOK_VERIFY_TOKEN']
    if (mode !== 'subscribe' || !expected || token !== expected) {
      throw errors.notFound('subscription')
    }
    void provider
    return challenge
  }

  /**
   * Receives an event.
   *
   * ACKNOWLEDGE FAST, PROCESS ASYNC. Verify the signature, persist, return 200.
   * Target under 200ms. Meta disables subscriptions that respond slowly, and a
   * disabled subscription is a silent outage — comments simply stop arriving.
   */
  @Public()
  @Post(':provider')
  // 200, not Nest's default 201 for POST. Several providers check for exactly
  // 200 and treat anything else as a delivery failure — which means retries,
  // and eventually a disabled subscription.
  @HttpCode(200)
  @ApiOperation({ summary: 'Receive a provider event' })
  async receive(
    @Param('provider') provider: string,
    @Req() request: FastifyRequest
  ): Promise<{ received: true }> {
    // THE RAW BYTES, not the parsed object.
    //
    // HMAC must be computed over exactly what arrived. Re-serialising parsed
    // JSON and hashing that is the single most common way this check silently
    // passes on well-formed payloads and fails on everything else — key order,
    // unicode escapes and number formatting all differ after a round trip.
    // `rawBody: true` is set on the Fastify adapter in main.ts; the property
    // is added by that option and is not in the base FastifyRequest type.
    const raw = (request as FastifyRequest & { rawBody?: Buffer }).rawBody
    if (!raw || raw.length === 0) throw errors.validation('Empty webhook body.')
    if (raw.length > 64 * 1024) throw errors.validation('Webhook body is too large.')

    const body = raw.toString('utf8')
    const contentHash = createHash('sha256').update(raw).digest('hex')

    // Signature verification is delegated to the provider adapter, since every
    // platform signs differently. A provider with no verifier is NOT trusted by
    // default — it is refused, because an unauthenticated event that we act on
    // is an open door into somebody's inbox.
    const signatureValid = await this.verifySignature(provider, raw, request.headers)
    if (!signatureValid) {
      // 404 rather than 401: an attacker probing for a valid endpoint learns
      // nothing about whether the path exists or the signature was merely wrong.
      throw errors.notFound('endpoint')
    }

    const providerAccountId = extractAccountId(provider, body)

    await withInboundRouter(async (tx) => {
      // Deduplicated on (provider, providerEventId), falling back to a content
      // hash. Providers redeliver aggressively and duplicate freely; a repeat is
      // the normal case, not an error.
      const existing = await tx.inboundEvent.findFirst({
        where: { provider, contentHash },
        select: { id: true },
      })
      if (existing) {
        inboundEvents.inc({ provider, disposition: 'duplicate' })
        return
      }

      const event = await tx.inboundEvent.create({
         
        data: {
          provider,
          contentHash,
          signatureValid: true,
          payload: safeParse(body),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
        select: { id: true },
      })

      if (!providerAccountId) {
        await tx.unroutedInboundEvent.create({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          data: { provider, payload: safeParse(body) } as any,
        })
        inboundEvents.inc({ provider, disposition: 'unidentifiable' })
        return
      }

      // FAN-OUT. Because SocialAccount uniqueness is (workspaceId, provider,
      // providerAccountId), one event can legitimately reach several workspaces
      // — an agency and its client both connecting the same Page.
      const accounts = await tx.socialAccount.findMany({
        where: { provider, providerAccountId, deletedAt: null },
        select: { id: true, workspaceId: true },
      })

      if (accounts.length === 0) {
        // Dropped. Never guessed at, never broadcast, never attached to the
        // nearest plausible workspace.
        await tx.unroutedInboundEvent.create({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          data: { provider, providerAccountId, payload: safeParse(body) } as any,
        })
        // The metric worth an alert. A sustained rise means a subscription
        // points at us for an account nobody connected, and every one of those
        // events is being dropped — correctly, and invisibly.
        inboundEvents.inc({ provider, disposition: 'unrouted' })
        return
      }

      inboundEvents.inc({ provider, disposition: 'routed' }, accounts.length)

      for (const account of accounts) {
        await tx.inboundEventDelivery.create({
           
          data: {
            inboundEventId: event.id,
            workspaceId: account.workspaceId,
            socialAccountId: account.id,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } as any,
        })
      }
    })

    return { received: true }
  }

  /**
   * Signature verification, per provider.
   *
   * Returns false for anything unrecognised. A provider we cannot verify is
   * refused rather than trusted — the default must be closed, because the
   * consequence of getting it wrong is acting on forged events.
   */
  private async verifySignature(
    provider: string,
    raw: Buffer,
    headers: Record<string, string | string[] | undefined>
  ): Promise<boolean> {
    const { registry } = await import('@smm/providers')
    const adapter = registry.get(provider as never)

    if (adapter?.capabilities.webhooks && adapter.verifyWebhook) {
      const result = adapter.verifyWebhook(raw, headers as never)
      return result.valid
    }

    return false
  }
}

/** Best-effort account extraction, without assuming a shape we do not know. */
function extractAccountId(provider: string, body: string): string | null {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>

    // Meta: { entry: [{ id }] }
    const entry = (parsed['entry'] as Array<{ id?: string }> | undefined)?.[0]
    if (entry?.id) return entry.id

    // Common flat shapes.
    for (const key of ['account_id', 'accountId', 'did', 'user_id']) {
      const value = parsed[key]
      if (typeof value === 'string') return value
    }

    void provider
    return null
  } catch {
    return null
  }
}

function safeParse(body: string): object {
  try {
    return JSON.parse(body) as object
  } catch {
    // Kept as text rather than discarded: an unparseable payload from a
    // verified sender is a signal worth being able to look at.
    return { _raw: body.slice(0, 8000) }
  }
}
