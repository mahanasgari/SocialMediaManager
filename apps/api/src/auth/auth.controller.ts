import { Body, Controller, Delete, Get, HttpCode, Param, Post, Req, Res } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { cookiePolicy, loadEnv } from '@smm/config'
import { z } from 'zod'
import { errors } from '../common/errors.js'
import { Public } from './auth-mode.guard.js'
import { CurrentUser } from './current-user.js'
import { AuthService } from './auth.service.js'
import { SessionService, type SessionPrincipal } from './session.service.js'
import { AttemptLimiter, DEFAULT_ACCOUNT_POLICY, DEFAULT_IP_POLICY } from '@smm/ratelimit'

const registerSchema = z.object({
  email: z.string().email(),
  // 12 characters, no composition rules. Length dominates entropy, and
  // composition rules push people toward predictable substitutions.
  password: z.string().min(12).max(200),
  name: z.string().min(1).max(120),
  inviteToken: z.string().min(1).optional(),
})

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(200),
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

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
    private readonly attempts: AttemptLimiter
  ) {}

  @Public()
  @Post('register')
  @ApiOperation({ summary: 'Create an account, honouring AUTH_REGISTRATION' })
  async register(
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply
  ) {
    const input = parse(registerSchema, body)
    const { userId } = await this.auth.register(input)
    await this.startSession(userId, request, reply)
    return { userId }
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  @ApiOperation({ summary: 'Exchange credentials for a session cookie' })
  async login(
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply
  ) {
    const input = parse(loginSchema, body)
    const ip = clientIp(request)

    // Checked BEFORE the password is verified.
    //
    // Argon2id makes each guess expensive, which is the point — but that also
    // means a few hundred concurrent attempts saturate the CPU and take the
    // application down as a side effect. Rejecting here, before any hashing
    // happens, is what prevents the guessing AND the denial of service.
    const account = await this.attempts.consume('login', input.email, DEFAULT_ACCOUNT_POLICY)
    if (!account.allowed) throw errors.tooManyAttempts(account.retryAfterSeconds)

    const source = await this.attempts.consume('login-ip', ip, DEFAULT_IP_POLICY)
    if (!source.allowed) throw errors.tooManyAttempts(source.retryAfterSeconds)

    const result = await this.auth.verifyCredentials(input)

    if (!result) {
      // Nothing to record: the attempt was already consumed above. Counting on
      // the way IN rather than on failure is what makes the limit hold under
      // concurrent requests — see AttemptLimiter.
      //
      // One message for both "no such account" and "wrong password", and the
      // SAME message whether or not attempts remain. Saying "3 tries left"
      // would confirm the address exists, turning the lockout into the
      // enumeration oracle the shared message exists to prevent.
      throw errors.unauthenticated('That email address and password do not match.')
    }

    // Cleared on success, so someone who mistypes twice a day is not eventually
    // locked out by an accumulation of failures they already recovered from.
    await this.attempts.succeed('login', input.email)

    await this.startSession(result.userId, request, reply)
    return { userId: result.userId }
  }

  @Post('logout')
  @HttpCode(204)
  @ApiOperation({ summary: 'Revoke the current session' })
  async logout(
    @CurrentUser() principal: SessionPrincipal | undefined,
    @Res({ passthrough: true }) reply: FastifyReply
  ): Promise<void> {
    if (principal) await this.sessions.revoke(principal.sessionId, principal.userId)

    // Cleared regardless, so a client holding an already-revoked token is not
    // left carrying a cookie that can never work.
    const policy = cookiePolicy(loadEnv())
    void reply.clearCookie(policy.name, { path: '/' })
  }

  @Get('me')
  @ApiOperation({ summary: 'The signed-in user' })
  me(@CurrentUser() principal: SessionPrincipal | undefined) {
    if (!principal) throw errors.unauthenticated()
    return { id: principal.userId, email: principal.email, name: principal.name }
  }

  @Get('sessions')
  @ApiOperation({ summary: 'Active sessions for the signed-in user' })
  async listSessions(@CurrentUser() principal: SessionPrincipal | undefined) {
    if (!principal) throw errors.unauthenticated()
    const sessions = await this.sessions.list(principal.userId)
    return sessions.map((s) => ({ ...s, current: s.id === principal.sessionId }))
  }

  @Delete('sessions/:id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Revoke one session' })
  async revokeSession(
    @Param('id') id: string,
    @CurrentUser() principal: SessionPrincipal | undefined
  ): Promise<void> {
    if (!principal) throw errors.unauthenticated()
    // Scoped to the caller's own sessions inside the service, so an id belonging
    // to another user is a silent no-op rather than a cross-account revocation.
    await this.sessions.revoke(id, principal.userId)
  }

  private async startSession(
    userId: string,
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> {
    const { token, expiresAt } = await this.sessions.create({
      userId,
      ip: request.ip,
      userAgent: request.headers['user-agent'],
    })

    const policy = cookiePolicy(loadEnv())
    void reply.setCookie(policy.name, token, {
      httpOnly: true,
      secure: policy.secure,
      // Lax is sufficient BECAUSE apps/web proxies /api/* and the browser sees a
      // single origin. If that invariant is ever broken this must be revisited
      // alongside the CSRF posture in SECURITY.md.
      sameSite: 'lax',
      path: '/',
      expires: expiresAt,
    })
  }
}

/**
 * The client address, for rate limiting.
 *
 * Fastify is configured with trustProxy, so `request.ip` already resolves
 * X-Forwarded-For against the trusted hop rather than taking the header at face
 * value. Reading the raw header here instead would let anyone set their own
 * rate-limit key and bypass the limit entirely by varying it.
 */
function clientIp(request: FastifyRequest): string {
  return request.ip || 'unknown'
}
