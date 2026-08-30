import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import { decrypt, keyProvider, withTenant } from '@smm/database'
import { RateLimiter } from '@smm/ratelimit'
import { ProviderError, registry, windowMs, withCapability, type AnyProvider } from '@smm/providers'
import { Redis } from 'ioredis'
import { loadEnv } from '@smm/config'
import { z } from 'zod'
import { errors } from '../common/errors.js'
import { Caller, resolveAccess, resolveRead, type Principal } from '../auth/principal.js'
import { MembershipService } from '../tenancy/membership.service.js'

const replySchema = z.object({
  workspaceId: z.string().uuid(),
  body: z.string().min(1).max(4000),
})

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body)
  if (result.success) return result.data
  const issue = result.error.issues[0]
  throw errors.validation(
    issue ? `${issue.path.join('.') || 'body'}: ${issue.message}` : 'The request body is invalid.',
    issue?.path.join('.')
  )
}

@ApiTags('inbox')
@Controller('inbox')
export class InboxController {
  constructor(private readonly memberships: MembershipService) {}

  private cached: RateLimiter | undefined

  /**
   * Lazily built.
   *
   * Constructing it eagerly would open a Redis connection at module load, which
   * makes every unit test that merely imports this controller need a running
   * Redis.
   */
  private limiter(): RateLimiter {
    this.cached ??= new RateLimiter(new Redis(loadEnv().REDIS_URL))
    return this.cached
  }

  @Get('conversations')
  @ApiOperation({ summary: 'Conversations in a workspace' })
  async list(
    @Query('workspaceId') workspaceId: string,
    @Query('status') status: string,
    @Query('kind') kind: string,
    @Query('assignee') assignee: string,
    @Caller() principal: Principal | undefined
  ) {
    if (!workspaceId) throw errors.validation('workspaceId is required.', 'workspaceId')
    await resolveRead(principal, workspaceId, 'inbox:read', (u, w) =>
      this.memberships.requireAccess(u, w)
    )

    return withTenant(workspaceId, async (tx) =>
      tx.conversation.findMany({
        where: {
          // OPEN by default. An inbox that opens showing archived threads is an
          // inbox nobody trusts.
          status: isStatus(status) ? status : 'OPEN',
          ...(isKind(kind) ? { kind } : {}),
          ...(assignee === 'me' && principal?.kind === 'user'
            ? { assigneeId: principal.userId }
            : {}),
          ...(assignee === 'unassigned' ? { assigneeId: null } : {}),
        },
        select: {
          id: true,
          kind: true,
          status: true,
          subjectHandle: true,
          unreadCount: true,
          lastMessageAt: true,
          assigneeId: true,
          socialAccount: { select: { handle: true, provider: true } },
          messages: {
            // Just enough for a preview line. Loading whole threads to render a
            // list is how an inbox becomes unusable at a thousand conversations.
            orderBy: { providerCreatedAt: 'desc' },
            take: 1,
            select: { body: true, direction: true, authorHandle: true },
          },
        },
        orderBy: { lastMessageAt: 'desc' },
        take: 100,
      })
    )
  }

  @Get('conversations/:id')
  @ApiOperation({ summary: 'One conversation with its messages' })
  async detail(
    @Param('id') id: string,
    @Query('workspaceId') workspaceId: string,
    @Caller() principal: Principal | undefined
  ) {
    if (!workspaceId) throw errors.validation('workspaceId is required.', 'workspaceId')
    await resolveRead(principal, workspaceId, 'inbox:read', (u, w) =>
      this.memberships.requireAccess(u, w)
    )

    const conversation = await withTenant(workspaceId, async (tx) => {
      const found = await tx.conversation.findFirst({
        where: { id },
        select: {
          id: true,
          kind: true,
          status: true,
          subjectHandle: true,
          assigneeId: true,
          socialAccount: { select: { id: true, handle: true, provider: true } },
          messages: {
            // ORDERED BY PROVIDER TIME, never by arrival or by id. Out-of-order
            // webhook delivery is routine, and a thread sorted by arrival reads
            // as a conversation nobody is having.
            orderBy: { providerCreatedAt: 'asc' },
            select: {
              id: true,
              direction: true,
              authorHandle: true,
              body: true,
              providerCreatedAt: true,
              parentId: true,
            },
          },
        },
      })
      if (!found) return null

      // Opening a conversation is what marks it read. A separate "mark read"
      // button is a chore nobody performs, and the count then lies permanently.
      await tx.conversation.update({ where: { id: found.id }, data: { unreadCount: 0 } })
      return found
    })

    // 404, not 403 — a conversation in another workspace must be
    // indistinguishable from one that does not exist.
    if (!conversation) throw errors.notFound('conversation')
    return conversation
  }

  /**
   * Replies.
   *
   * Persists the outgoing message ONLY after the provider accepts it. Writing
   * it first would show the operator a reply in the thread that was never
   * delivered — and in an inbox, believing you answered someone when you did
   * not is worse than an error.
   */
  @Post('conversations/:id/reply')
  @ApiOperation({ summary: 'Reply in a conversation' })
  async reply(
    @Param('id') id: string,
    @Body() body: unknown,
    @Caller() principal: Principal | undefined
  ) {
    const input = parse(replySchema, body)
    await resolveAccess(principal, input.workspaceId, 'inbox.reply', (u, w) =>
      this.memberships.requireAccess(u, w)
    )

    const conversation = await withTenant(input.workspaceId, async (tx) =>
      tx.conversation.findFirst({
        where: { id },
        select: {
          id: true,
          providerConversationId: true,
          kind: true,
          socialAccount: { select: { id: true, provider: true } },
        },
      })
    )
    if (!conversation) throw errors.notFound('conversation')

    // Annotated explicitly: an assertion signature cannot be applied to a name
    // whose type was inferred, so `const provider = registry.get(...)` alone
    // makes withCapability a compile error rather than a guard.
    const provider: AnyProvider | undefined = registry.get(
      conversation.socialAccount.provider as never
    )
    if (!provider) throw errors.notFound('provider')

    // Runtime narrowing rather than a type assertion: this call site holds the
    // widened union, where the conditional intersections have collapsed.
    const capability: 'dm' | 'replies' = conversation.kind === 'DM' ? 'dm' : 'replies'
    try {
      withCapability(provider, capability)
    } catch {
      throw errors.validation(
        `${provider.label} does not support replying from here. Open the conversation on ${provider.label} instead.`
      )
    }

    // The credential is read and DECRYPTED in its own short transaction, then
    // the transaction closes before the provider is called. The boundary guard
    // would throw otherwise, and holding a Postgres connection across a 30s
    // provider timeout is how a pool exhausts under load.
    const credential = await withTenant(input.workspaceId, async (tx) => {
      const account = await tx.socialAccount.findFirst({
        where: { id: conversation.socialAccount.id },
        select: {
          id: true,
          providerAccountId: true,
          handle: true,
          displayName: true,
          platformMeta: true,
          credential: { select: { accessToken: true, scopes: true } },
        },
      })
      if (!account?.credential) return null
      return {
        account: {
          id: account.id,
          providerAccountId: account.providerAccountId,
          handle: account.handle,
          displayName: account.displayName,
          platformMeta: (account.platformMeta ?? {}) as Record<string, unknown>,
        },
        credential: {
          accessToken: decrypt(account.credential.accessToken, keyProvider()),
          scopes: account.credential.scopes,
        },
      }
    })

    if (!credential) {
      throw errors.validation(
        'That account is disconnected, so replies cannot be sent. Reconnect it to continue the conversation.'
      )
    }

    // Budget is acquired before the call, exactly as publishing does. A reply
    // spends the same provider quota a post does, and an inbox that ignores the
    // budget is how an account gets rate limited mid-conversation.
    const budget = provider.limits.write ?? provider.limits.publish
    if (budget) {
      const decision = await this.limiter().acquire({
        provider: provider.id,
        accountId: credential.account.id,
        operation: 'write',
        cost: budget.cost,
        capacity: budget.budget,
        windowMs: windowMs(budget.window),
        scope: provider.limits.scope,
      })
      if (!decision.granted) {
        const seconds = Math.ceil(decision.waitMs / 1000)
        throw errors.providerRateLimited(
          `${provider.label} is rate limiting this account. Try again in ${seconds} seconds.`
        )
      }
    }

    let sent: { remoteId: string }
    try {
      sent =
        capability === 'dm'
          ? await sendDirect(provider, credential, conversation.providerConversationId, input.body)
          : await sendReply(provider, credential, conversation.providerConversationId, input.body)
    } catch (error) {
      // The message is NOT persisted. Showing a reply in the thread that was
      // never delivered is worse than an error, because the operator believes
      // they answered someone and stops thinking about it.
      throw toHttpError(error, provider.label)
    }

    return withTenant(input.workspaceId, async (tx) => {
      const message = await tx.message.create({
         
        data: {
          workspaceId: input.workspaceId,
          conversationId: conversation.id,
          providerMessageId: sent.remoteId,
          direction: 'OUT',
          authorHandle: 'you',
          body: input.body,
          providerCreatedAt: new Date(),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
        select: { id: true, body: true, providerCreatedAt: true },
      })

      await tx.conversation.update({
        where: { id: conversation.id },
        data: { lastMessageAt: new Date(), unreadCount: 0 },
      })

      return message
    })
  }

  @Patch('conversations/:id')
  @ApiOperation({ summary: 'Assign, snooze or archive a conversation' })
  async update(
    @Param('id') id: string,
    @Body() body: unknown,
    @Caller() principal: Principal | undefined
  ) {
    const input = parse(
      z.object({
        workspaceId: z.string().uuid(),
        status: z.enum(['OPEN', 'SNOOZED', 'ARCHIVED']).optional(),
        assigneeId: z.string().uuid().nullable().optional(),
      }),
      body
    )
    await resolveAccess(principal, input.workspaceId, 'inbox.manage', (u, w) =>
      this.memberships.requireAccess(u, w)
    )

    return withTenant(input.workspaceId, async (tx) =>
      tx.conversation.update({
        where: { id },
        data: {
          ...(input.status ? { status: input.status } : {}),
          ...(input.assigneeId !== undefined ? { assigneeId: input.assigneeId } : {}),
        },
        select: { id: true, status: true, assigneeId: true },
      })
    )
  }

  @Get('counts')
  @ApiOperation({ summary: 'Unread and open counts for the inbox badge' })
  async counts(
    @Query('workspaceId') workspaceId: string,
    @Caller() principal: Principal | undefined
  ) {
    if (!workspaceId) throw errors.validation('workspaceId is required.', 'workspaceId')
    await resolveRead(principal, workspaceId, 'inbox:read', (u, w) =>
      this.memberships.requireAccess(u, w)
    )

    return withTenant(workspaceId, async (tx) => {
      const [open, unread] = await Promise.all([
        tx.conversation.count({ where: { status: 'OPEN' } }),
        tx.conversation.count({ where: { status: 'OPEN', unreadCount: { gt: 0 } } }),
      ])
      return { open, unread }
    })
  }

}

function isStatus(value: string): value is 'OPEN' | 'SNOOZED' | 'ARCHIVED' {
  return value === 'OPEN' || value === 'SNOOZED' || value === 'ARCHIVED'
}

function isKind(value: string): value is 'COMMENT_THREAD' | 'DM' | 'MENTION' {
  return value === 'COMMENT_THREAD' || value === 'DM' || value === 'MENTION'
}

type Resolved = {
  account: {
    id: string
    providerAccountId: string
    handle: string
    displayName: string
    platformMeta: Record<string, unknown>
  }
  credential: { accessToken: string; scopes: string[] }
}

/**
 * Sends a direct message.
 *
 * Split from sendReply because they are different provider methods with
 * different permissions — a token that can reply to a public comment frequently
 * cannot open a DM, and merging them would surface that as a confusing generic
 * failure rather than a specific one.
 */
async function sendDirect(
  provider: AnyProvider,
  resolved: Resolved,
  conversationId: string,
  body: string
): Promise<{ remoteId: string }> {
  const sent = (await provider.sendMessage!(
    resolved.account,
    resolved.credential,
    conversationId,
    body
  )) as { id?: string; message_id?: number; remoteId?: string }

  return { remoteId: String(sent.remoteId ?? sent.id ?? sent.message_id ?? Date.now()) }
}

async function sendReply(
  provider: AnyProvider,
  resolved: Resolved,
  conversationId: string,
  body: string
): Promise<{ remoteId: string }> {
  const sent = (await provider.replyToComment!(
    resolved.account,
    resolved.credential,
    conversationId,
    body
  )) as { id?: string; message_id?: number; remoteId?: string }

  return { remoteId: String(sent.remoteId ?? sent.id ?? sent.message_id ?? Date.now()) }
}

/**
 * Turns a provider failure into an HTTP response a person can act on.
 *
 * The provider's own message is preserved — it is the only part that says WHY —
 * and never replaced with a status code. "LinkedIn rejected this" with no
 * reason is a dead end for whoever has to fix it.
 */
function toHttpError(error: unknown, label: string): Error {
  if (error instanceof ProviderError) {
    if (error.code === 'RateLimited') return errors.providerRateLimited(error.message)
    if (error.code === 'TokenExpired' || error.code === 'PermissionRevoked') {
      return errors.validation(error.message)
    }
    return errors.validation(error.message)
  }
  return errors.validation(
    `${label} did not accept that reply. ${error instanceof Error ? error.message : ''}`.trim()
  )
}
