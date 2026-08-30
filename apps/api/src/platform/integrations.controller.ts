import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import { randomBytes } from 'node:crypto'
import { decrypt, encrypt, keyProvider, withTenant } from '@smm/database'
import { z } from 'zod'
import { errors } from '../common/errors.js'
import { Caller, resolveAccess, resolveRead, type Principal } from '../auth/principal.js'
import { MembershipService } from '../tenancy/membership.service.js'
import { assertSafeUrl, sign, UnsafeFeedUrl } from '@smm/integrations'

/**
 * Outbound webhooks and RSS ingestion.
 *
 * Both existed as worker subsystems before this controller did — the dispatcher
 * was sending webhooks nobody could create, and the poller was reading feeds
 * nobody could add. A subsystem with no way to reach it is indistinguishable
 * from one that does not work.
 */

const EVENT_TYPES = [
  'post.published',
  'post.failed',
  'post.missed',
  'post.approved',
  'post.rejected',
  'account.disconnected',
  'account.token_expired',
] as const

const webhookSchema = z.object({
  workspaceId: z.string().uuid(),
  url: z.string().url(),
  events: z.array(z.enum(EVENT_TYPES)).min(1, 'Choose at least one event to send.'),
})

const feedSchema = z.object({
  workspaceId: z.string().uuid(),
  url: z.string().url(),
  name: z.string().min(1).max(120),
  targetAccountIds: z.array(z.string().uuid()).default([]),
  template: z.string().min(1).max(500).default('{{title}} {{link}}'),
  autoPublish: z.boolean().default(false),
})

// Typed on the schema's OUTPUT rather than a bare `T`. With
// exactOptionalPropertyTypes, inferring through `ZodType<T>` picks the INPUT
// shape, where a field carrying `.default()` is still optional — so a value zod
// guarantees to be present arrives typed as possibly undefined.
function parse<S extends z.ZodTypeAny>(schema: S, body: unknown): z.output<S> {
  const result = schema.safeParse(body)
  if (result.success) return result.data
  const issue = result.error.issues[0]
  throw errors.validation(
    issue ? `${issue.path.join('.') || 'body'}: ${issue.message}` : 'The request body is invalid.',
    issue?.path.join('.')
  )
}

@ApiTags('integrations')
@Controller()
export class IntegrationsController {
  constructor(private readonly memberships: MembershipService) {}

  // --- Outbound webhooks ----------------------------------------------------

  @Get('webhooks')
  @ApiOperation({ summary: 'Webhooks in a workspace' })
  async listWebhooks(
    @Query('workspaceId') workspaceId: string,
    @Caller() principal: Principal | undefined
  ) {
    if (!workspaceId) throw errors.validation('workspaceId is required.', 'workspaceId')
    await resolveRead(principal, workspaceId, 'integrations:read', (u, w) =>
      this.memberships.requireAccess(u, w)
    )

    return withTenant(workspaceId, async (tx) => {
      const hooks = await tx.webhook.findMany({
        select: {
          id: true,
          url: true,
          events: true,
          enabled: true,
          consecutiveFailures: true,
          disabledAt: true,
          createdAt: true,
          deliveries: {
            orderBy: { createdAt: 'desc' },
            take: 5,
            select: {
              id: true,
              eventType: true,
              attempt: true,
              responseStatus: true,
              deliveredAt: true,
              createdAt: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
      })

      // The signing secret is NEVER returned, not even to the person who made
      // it. It is shown exactly once, at creation, and after that the only
      // recovery is to rotate — which is the property that makes it a secret
      // rather than a value stored in a UI someone can screenshot.
      return hooks
    })
  }

  @Post('webhooks')
  @ApiOperation({ summary: 'Create a webhook' })
  async createWebhook(@Body() body: unknown, @Caller() principal: Principal | undefined) {
    const input = parse(webhookSchema, body)
    const access = await resolveAccess(principal, input.workspaceId, 'integrations.manage', (u, w) =>
      this.memberships.requireAccess(u, w)
    )

    // The destination is checked for the same SSRF reasons as an RSS feed: it
    // is a user-supplied URL that our server will request. A webhook pointed at
    // 169.254.169.254 would deliver our own cloud metadata to whoever asked.
    assertDestination(input.url)

    const secret = `whsec_${randomBytes(24).toString('base64url')}`

    const created = await withTenant(input.workspaceId, async (tx) =>
      tx.webhook.create({
        data: {
          workspaceId: input.workspaceId,
          organizationId: access.organizationId,
          url: input.url,
          events: input.events,
          signingSecret: encrypt(secret, keyProvider()),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
        select: { id: true, url: true, events: true },
      })
    )

    return {
      ...created,
      // Returned ONCE. Said plainly, because a secret shown without warning is
      // a secret somebody navigates away from and then cannot use.
      signingSecret: secret,
      notice:
        'Copy this signing secret now — it is not shown again. Verify deliveries by ' +
        'recomputing HMAC-SHA256 over `${timestamp}.${rawBody}` using it.',
    }
  }

  @Patch('webhooks/:id')
  @ApiOperation({ summary: 'Enable, disable, or rotate a webhook secret' })
  async updateWebhook(
    @Param('id') id: string,
    @Body() body: unknown,
    @Caller() principal: Principal | undefined
  ) {
    const input = parse(
      z.object({
        workspaceId: z.string().uuid(),
        enabled: z.boolean().optional(),
        rotateSecret: z.boolean().optional(),
      }),
      body
    )
    await resolveAccess(principal, input.workspaceId, 'integrations.manage', (u, w) =>
      this.memberships.requireAccess(u, w)
    )

    const secret = input.rotateSecret ? `whsec_${randomBytes(24).toString('base64url')}` : null

    const updated = await withTenant(input.workspaceId, async (tx) =>
      tx.webhook.update({
        where: { id },
        data: {
          ...(input.enabled !== undefined
            ? {
                enabled: input.enabled,
                // Re-enabling CLEARS the failure count and the disabled stamp.
                // Leaving them would let a hook that failed five times a month
                // ago be auto-disabled again on its very next hiccup.
                ...(input.enabled ? { consecutiveFailures: 0, disabledAt: null } : {}),
              }
            : {}),
          ...(secret ? { signingSecret: encrypt(secret, keyProvider()) } : {}),
        },
        select: { id: true, enabled: true, events: true, url: true },
      })
    )

    return { ...updated, ...(secret ? { signingSecret: secret } : {}) }
  }

  @Delete('webhooks/:id')
  @ApiOperation({ summary: 'Delete a webhook' })
  async deleteWebhook(
    @Param('id') id: string,
    @Query('workspaceId') workspaceId: string,
    @Caller() principal: Principal | undefined
  ) {
    if (!workspaceId) throw errors.validation('workspaceId is required.', 'workspaceId')
    await resolveAccess(principal, workspaceId, 'integrations.manage', (u, w) =>
      this.memberships.requireAccess(u, w)
    )
    await withTenant(workspaceId, async (tx) => tx.webhook.deleteMany({ where: { id } }))
    return { deleted: true }
  }

  /**
   * Sends a test delivery.
   *
   * Exists because the alternative is publishing a real post to find out whether
   * the endpoint works, and discovering it does not.
   */
  @Post('webhooks/:id/test')
  @ApiOperation({ summary: 'Send a test delivery' })
  async testWebhook(
    @Param('id') id: string,
    @Body() body: unknown,
    @Caller() principal: Principal | undefined
  ) {
    const input = parse(z.object({ workspaceId: z.string().uuid() }), body)
    await resolveAccess(principal, input.workspaceId, 'integrations.manage', (u, w) =>
      this.memberships.requireAccess(u, w)
    )

    const hook = await withTenant(input.workspaceId, async (tx) =>
      tx.webhook.findFirst({
        where: { id },
        select: { id: true, url: true, signingSecret: true },
      })
    )
    if (!hook) throw errors.notFound('webhook')

    const payload = JSON.stringify({
      id: `evt_test_${Date.now()}`,
      type: 'webhook.test',
      workspaceId: input.workspaceId,
      createdAt: new Date().toISOString(),
      data: { message: 'This is a test delivery.' },
    })
    const timestamp = Math.floor(Date.now() / 1000)
    const secret = decrypt(hook.signingSecret, keyProvider())

    // Outside any transaction — the boundary guard would throw otherwise, and
    // holding a connection across a slow customer endpoint is exactly the
    // pool-exhaustion path the guard exists to prevent.
    try {
      const response = await fetch(hook.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-smm-signature': sign(payload, secret, timestamp),
          'x-smm-event': 'webhook.test',
        },
        body: payload,
        signal: AbortSignal.timeout(10_000),
      })

      return {
        delivered: response.ok,
        status: response.status,
        message: response.ok
          ? `Your endpoint responded ${response.status}.`
          : `Your endpoint responded ${response.status}. Deliveries are retried, but ` +
            `repeated failures disable the webhook.`,
      }
    } catch (error) {
      return {
        delivered: false,
        status: null,
        // The transport error itself, not a generic one: a DNS failure, a TLS
        // failure and a timeout need three different fixes.
        message: `Could not reach that endpoint: ${error instanceof Error ? error.message : 'unknown error'}.`,
      }
    }
  }

  // --- RSS ingestion --------------------------------------------------------

  @Get('rss-feeds')
  @ApiOperation({ summary: 'RSS feeds in a workspace' })
  async listFeeds(
    @Query('workspaceId') workspaceId: string,
    @Caller() principal: Principal | undefined
  ) {
    if (!workspaceId) throw errors.validation('workspaceId is required.', 'workspaceId')
    await resolveRead(principal, workspaceId, 'integrations:read', (u, w) =>
      this.memberships.requireAccess(u, w)
    )

    return withTenant(workspaceId, async (tx) =>
      tx.rSSFeed.findMany({
        where: { deletedAt: null },
        select: {
          id: true,
          url: true,
          name: true,
          template: true,
          targetAccountIds: true,
          autoPublish: true,
          lastFetchedAt: true,
          pausedAt: true,
          items: {
            orderBy: { createdAt: 'desc' },
            take: 5,
            select: { id: true, title: true, link: true, postId: true, createdAt: true },
          },
        },
        orderBy: { createdAt: 'desc' },
      })
    )
  }

  @Post('rss-feeds')
  @ApiOperation({ summary: 'Add an RSS feed' })
  async createFeed(@Body() body: unknown, @Caller() principal: Principal | undefined) {
    const input = parse(feedSchema, body)
    const access = await resolveAccess(principal, input.workspaceId, 'integrations.manage', (u, w) =>
      this.memberships.requireAccess(u, w)
    )

    // Checked HERE as well as in the worker. The worker re-checks after every
    // redirect, but rejecting at creation means the person who typed the address
    // finds out immediately rather than through a feed that silently never
    // fetches.
    assertDestination(input.url)

    if (input.autoPublish && input.targetAccountIds.length === 0) {
      throw errors.validation(
        'Choose at least one account before turning on auto-publish, or items have nowhere to go.',
        'targetAccountIds'
      )
    }

    return withTenant(input.workspaceId, async (tx) =>
      tx.rSSFeed.create({
        data: {
          workspaceId: input.workspaceId,
          organizationId: access.organizationId,
          url: input.url,
          name: input.name,
          template: input.template,
          targetAccountIds: input.targetAccountIds,
          autoPublish: input.autoPublish,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
        select: { id: true, name: true, url: true, autoPublish: true },
      })
    )
  }

  @Patch('rss-feeds/:id')
  @ApiOperation({ summary: 'Pause, resume, or reconfigure a feed' })
  async updateFeed(
    @Param('id') id: string,
    @Body() body: unknown,
    @Caller() principal: Principal | undefined
  ) {
    const input = parse(
      z.object({
        workspaceId: z.string().uuid(),
        paused: z.boolean().optional(),
        autoPublish: z.boolean().optional(),
        template: z.string().min(1).max(500).optional(),
        targetAccountIds: z.array(z.string().uuid()).optional(),
      }),
      body
    )
    await resolveAccess(principal, input.workspaceId, 'integrations.manage', (u, w) =>
      this.memberships.requireAccess(u, w)
    )

    return withTenant(input.workspaceId, async (tx) =>
      tx.rSSFeed.update({
        where: { id },
        data: {
          ...(input.paused !== undefined ? { pausedAt: input.paused ? new Date() : null } : {}),
          ...(input.autoPublish !== undefined ? { autoPublish: input.autoPublish } : {}),
          ...(input.template ? { template: input.template } : {}),
          ...(input.targetAccountIds ? { targetAccountIds: input.targetAccountIds } : {}),
        },
        select: { id: true, name: true, pausedAt: true, autoPublish: true },
      })
    )
  }

  @Delete('rss-feeds/:id')
  @ApiOperation({ summary: 'Remove a feed' })
  async deleteFeed(
    @Param('id') id: string,
    @Query('workspaceId') workspaceId: string,
    @Caller() principal: Principal | undefined
  ) {
    if (!workspaceId) throw errors.validation('workspaceId is required.', 'workspaceId')
    await resolveAccess(principal, workspaceId, 'integrations.manage', (u, w) =>
      this.memberships.requireAccess(u, w)
    )

    // Soft-deleted, so drafts already created from it keep a coherent origin.
    // Hard-deleting would cascade the items and leave those posts pointing at
    // nothing.
    await withTenant(workspaceId, async (tx) =>
      tx.rSSFeed.updateMany({ where: { id }, data: { deletedAt: new Date() } })
    )
    return { deleted: true }
  }

  @Get('integrations/event-types')
  @ApiOperation({ summary: 'Events a webhook can subscribe to' })
  eventTypes() {
    return EVENT_TYPES.map((type) => ({ type, description: describeEvent(type) }))
  }
}

/**
 * Rejects a destination our server should never be made to request.
 *
 * Both webhooks and RSS feeds take a URL from a user and cause a server-side
 * request to it, which is the definition of an SSRF surface. The check is the
 * same in both places because the risk is.
 */
function assertDestination(url: string): void {
  try {
    assertSafeUrl(url)
  } catch (error) {
    if (error instanceof UnsafeFeedUrl) throw errors.validation(error.message, 'url')
    throw error
  }
}

function describeEvent(type: (typeof EVENT_TYPES)[number]): string {
  switch (type) {
    case 'post.published':
      return 'A post went live on at least one channel.'
    case 'post.failed':
      return 'A post could not be published and will not retry.'
    case 'post.missed':
      return 'A post passed its catch-up window and needs a human decision.'
    case 'post.approved':
      return 'A post cleared its approval steps.'
    case 'post.rejected':
      return 'A reviewer requested changes.'
    case 'account.disconnected':
      return 'A social account was disconnected.'
    case 'account.token_expired':
      return 'A social account needs reconnecting before it can publish again.'
  }
}
