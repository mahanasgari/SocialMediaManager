import { Body, Controller, Delete, Get, Param, Post, Query, Res } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import type { FastifyReply } from 'fastify'
import { loadEnv } from '@smm/config'
import { registry } from '@smm/providers'
import { z } from 'zod'
import { errors } from '../common/errors.js'
import { CurrentUser } from '../auth/current-user.js'
import { Public } from '../auth/auth-mode.guard.js'
import type { SessionPrincipal } from '../auth/session.service.js'
import { MembershipService } from '../tenancy/membership.service.js'
import { ConnectionsService } from './connections.service.js'
import {
  createPkce,
  redirectUriFor,
  safeReturnTo,
  signState,
  verifyState,
} from './oauth-state.js'
import { authorize } from '@smm/auth'

const connectSchema = z.object({
  /**
   * Values the provider declared it needs before a connection can start.
   *
   * Mastodon registers its app per instance, so there is literally no URL to
   * redirect to until someone has named one.
   */
  fields: z.record(z.string().min(1).max(500)).optional(),
  workspaceId: z.string().uuid(),
  returnTo: z.string().optional(),
})

/**
 * Connecting a social account.
 *
 * Every step that touches a credential runs inside a workspace scope, and the
 * callback re-derives the workspace from the SIGNED state rather than from a
 * query parameter — the callback arrives from the provider, not from our UI, so
 * nothing in the request may be trusted to say which tenant it belongs to.
 */
@ApiTags('social-accounts')
@Controller('social-accounts')
export class SocialAccountsController {
  constructor(
    private readonly memberships: MembershipService,
    private readonly connections: ConnectionsService
  ) {}

  @Get()
  @ApiOperation({ summary: 'Connected accounts in a workspace' })
  async list(
    @Query('workspaceId') workspaceId: string,
    @CurrentUser() principal: SessionPrincipal | undefined
  ) {
    if (!principal) throw errors.unauthenticated()
    if (!workspaceId) throw errors.validation('workspaceId is required.', 'workspaceId')
    await this.memberships.requireAccess(principal.userId, workspaceId)
    return this.connections.list(workspaceId)
  }

  @Post('connect/:provider')
  @ApiOperation({ summary: 'Begin an OAuth connection' })
  async connect(
    @Param('provider') providerId: string,
    @Body() body: unknown,
    @CurrentUser() principal: SessionPrincipal | undefined
  ) {
    if (!principal) throw errors.unauthenticated()
    const input = connectSchema.parse(body)

    const access = await this.memberships.requireAccess(principal.userId, input.workspaceId)
    this.require(principal.userId, access.role)

    const provider = registry.get(providerId as never)
    if (!provider) throw errors.notFound('provider')

    // A skeleton is visible but disabled. Refusing here as well as in the UI
    // means a hand-crafted request cannot start a flow that cannot complete.
    if (provider.state === 'skeleton') {
      throw errors.unprocessable(
        'provider_not_implemented',
        `${provider.label} is not implemented yet, so it cannot be connected.`
      )
    }
    if (!provider.isConfigured()) {
      throw errors.unprocessable(
        'provider_not_configured',
        `${provider.label} has not been configured by your administrator, so it cannot be connected.`
      )
    }

    // A credentials provider has no URL to redirect to. Saying so explicitly
    // beats returning a broken redirect, and points the caller at the endpoint
    // that does work.
    if ((provider.authStyle ?? 'oauth') === 'credentials') {
      throw errors.unprocessable(
        'provider_uses_credentials',
        `${provider.label} connects with credentials rather than a redirect. ` +
          `Submit them to /api/v1/social-accounts/connect/${providerId}/credentials instead.`
      )
    }

    const env = loadEnv()
    const pkce = createPkce()
    const state = signState(
      {
        userId: principal.userId,
        workspaceId: input.workspaceId,
        provider: providerId,
        returnTo: safeReturnTo(input.returnTo),
      },
      env.SESSION_SECRET
    )

    // Only fields the provider declared. An unexpected key is dropped rather
    // than forwarded, so the connect form cannot smuggle arbitrary parameters
    // into an adapter.
    const supplied: Record<string, string> = {}
    for (const field of provider.connectFields ?? []) {
      const value = input.fields?.[field.name]
      if (!value?.trim()) {
        throw errors.validation(`${field.label} is required to connect ${provider.label}.`, field.name)
      }
      supplied[field.name] = value.trim()
    }

    const redirect = await provider.getAuthUrl({
      redirectUri: redirectUriFor(env.PUBLIC_URL, providerId),
      state,
      // Passed through by name. `instanceUrl` is the only one any provider
      // declares today, and AuthContext carries it explicitly for that reason.
      ...(supplied['instanceUrl'] ? { instanceUrl: supplied['instanceUrl'] } : {}),
      codeVerifier: pkce.verifier,
    })

    // The verifier is returned to OUR client, never to the provider — only its
    // hash goes out. The client hands it back on the callback exchange.
    return { url: redirect.url, state, codeVerifier: pkce.verifier }
  }

  /**
   * Connects a provider that takes credentials directly.
   *
   * Bluesky app passwords, Telegram bot tokens, WordPress application
   * passwords: there is no redirect, so the OAuth path cannot serve them and a
   * UI that only knows how to start an OAuth flow would leave a fully
   * implemented connector unreachable.
   *
   * The submitted secret is verified against the provider BEFORE anything is
   * stored — `handleCallback` performs a real authenticated call — so a typo
   * fails here with a usable message rather than becoming an account that looks
   * connected and fails at publish time.
   */
  @Post('connect/:provider/credentials')
  @ApiOperation({ summary: 'Connect a provider that takes credentials directly' })
  async connectWithCredentials(
    @Param('provider') providerId: string,
    @Body() body: unknown,
    @CurrentUser() principal: SessionPrincipal | undefined
  ) {
    if (!principal) throw errors.unauthenticated()

    const input = z
      .object({
        workspaceId: z.string().uuid(),
        // Values are provider-specific and validated by the adapter, which is
        // the only thing that knows what a valid one looks like. Bounded here
        // so an oversized body cannot be used as a memory pressure lever.
        credentials: z.record(z.string().min(1).max(2000)),
      })
      .parse(body)

    const access = await this.memberships.requireAccess(principal.userId, input.workspaceId)
    this.require(principal.userId, access.role)

    const provider = registry.get(providerId as never)
    if (!provider) throw errors.notFound('provider')

    if (provider.state === 'skeleton') {
      throw errors.unprocessable(
        'provider_not_implemented',
        `${provider.label} is not implemented yet, so it cannot be connected.`
      )
    }
    if ((provider.authStyle ?? 'oauth') !== 'credentials') {
      throw errors.unprocessable(
        'provider_uses_oauth',
        `${provider.label} connects through a redirect, not by pasting credentials.`
      )
    }

    // Only the fields the provider declared. An unexpected key is dropped
    // rather than forwarded, so the connect form cannot be used to smuggle
    // arbitrary parameters into an adapter.
    const params: Record<string, string> = {}
    for (const field of provider.connectFields ?? []) {
      const value = input.credentials[field.name]
      if (!value?.trim()) {
        throw errors.validation(`${field.label} is required.`, field.name)
      }
      params[field.name] = value.trim()
    }

    const env = loadEnv()
    const discovered = await provider.handleCallback(
      { redirectUri: redirectUriFor(env.PUBLIC_URL, providerId), state: 'credentials' },
      params
    )

    await this.connections.connect(
      input.workspaceId,
      access.organizationId,
      providerId,
      discovered,
      principal.userId
    )

    return {
      connected: true,
      accounts: discovered.map((d) => ({ handle: d.handle, displayName: d.displayName })),
    }
  }

  @Public()
  @Get('callback/:provider')
  @ApiOperation({ summary: 'OAuth callback — arrives from the provider' })
  async callback(
    @Param('provider') providerId: string,
    @Query() query: Record<string, string>,
    @Res({ passthrough: true }) reply: FastifyReply
  ) {
    const env = loadEnv()

    // Public because the provider redirects a browser here with no session
    // guarantee — but the SIGNED state is what establishes identity and tenancy,
    // and it is not optional.
    const payload = verifyState(query['state'] ?? '', env.SESSION_SECRET)

    if (payload.provider !== providerId) {
      throw errors.validation('This connection link does not match the provider being connected.')
    }

    const provider = registry.get(providerId as never)
    if (!provider) throw errors.notFound('provider')

    const discovered = await provider.handleCallback(
      { redirectUri: redirectUriFor(env.PUBLIC_URL, providerId), state: payload.jti },
      query
    )

    const access = await this.memberships.requireAccess(payload.userId, payload.workspaceId)

    await this.connections.connect(
      payload.workspaceId,
      access.organizationId,
      providerId,
      discovered,
      payload.userId
    )

    // returnTo was allowlisted when the state was signed. An open redirect here
    // would be a credential-stealing primitive, so it is validated again rather
    // than trusted because it was checked once.
    void reply.redirect(safeReturnTo(payload.returnTo), 302)
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Disconnect an account' })
  async disconnect(
    @Param('id') id: string,
    @Query('workspaceId') workspaceId: string,
    @CurrentUser() principal: SessionPrincipal | undefined
  ) {
    if (!principal) throw errors.unauthenticated()
    if (!workspaceId) throw errors.validation('workspaceId is required.', 'workspaceId')

    const access = await this.memberships.requireAccess(principal.userId, workspaceId)
    this.require(principal.userId, access.role)

    const result = await this.connections.disconnect(workspaceId, id, principal.userId)
    return {
      disconnected: true,
      ...result,
      // Said plainly, because the alternative is someone discovering it by
      // noticing nothing was posted.
      message:
        result.cancelledScheduled > 0
          ? `Disconnected. ${result.cancelledScheduled} scheduled post(s) targeting this account were cancelled.`
          : 'Disconnected. Published history and past metrics are kept.',
    }
  }

  private require(userId: string, role: Parameters<typeof authorize>[0]['role']): void {
    const result = authorize({ userId, role }, 'accounts.connect')
    if (!result.allowed) {
      throw errors.forbidden('Your role does not permit connecting or disconnecting accounts.', {
        required: 'accounts.connect',
      })
    }
  }
}
