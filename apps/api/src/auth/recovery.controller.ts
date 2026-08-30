import { Body, Controller, Get, HttpCode, Post, Query } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import { z } from 'zod'
import { errors } from '../common/errors.js'
import { Public } from './auth-mode.guard.js'
import { CurrentUser } from './current-user.js'
import type { SessionPrincipal } from './session.service.js'
import { RecoveryService } from './recovery.service.js'

/**
 * Account recovery.
 *
 * Split from AuthController because the trust model is different: these routes
 * are reachable WITHOUT a session by design — that is the whole point of a
 * password reset — and grouping them apart keeps that obvious to anyone
 * auditing which endpoints are public.
 */
@ApiTags('auth')
@Controller('auth')
export class RecoveryController {
  constructor(private readonly recovery: RecoveryService) {}

  /**
   * Requests a reset link.
   *
   * ALWAYS 200, whatever happened. Anything else turns this into a membership
   * oracle that reveals which addresses have accounts.
   */
  @Public()
  @Post('forgot-password')
  @HttpCode(200)
  @ApiOperation({ summary: 'Request a password reset link' })
  async forgot(@Body() body: unknown) {
    const input = parse(z.object({ email: z.string().email() }), body)
    const result = await this.recovery.requestPasswordReset(input.email)

    return {
      // Carefully worded: it does not say an email WAS sent, because for an
      // unknown address none was, and claiming otherwise is a lie the user may
      // act on by waiting.
      message:
        'If that address has an account, a reset link is on its way. ' +
        'Check your spam folder before requesting another.',
      ...result,
    }
  }

  @Public()
  @Post('reset-password')
  @HttpCode(200)
  @ApiOperation({ summary: 'Set a new password using a reset link' })
  async reset(@Body() body: unknown) {
    const input = parse(
      z.object({
        token: z.string().min(20),
        // Length only. Composition rules push people towards Password1! and a
        // long passphrase beats a short cryptic one on every axis that matters.
        password: z.string().min(8, 'Use at least 8 characters.').max(200),
      }),
      body
    )

    const result = await this.recovery.completePasswordReset(input.token, input.password)
    if (!result.ok) throw errors.validation(result.reason, 'token')

    return {
      message: 'Password changed. You have been signed out everywhere — sign in again to continue.',
    }
  }

  @Public()
  @Get('verify-email')
  @ApiOperation({ summary: 'Confirm an email address' })
  async verify(@Query('token') token: string) {
    if (!token) throw errors.validation('A confirmation token is required.', 'token')

    const result = await this.recovery.verifyEmail(token)
    if (!result.ok) throw errors.validation(result.reason, 'token')

    return { message: 'Email address confirmed.' }
  }

  @Post('resend-verification')
  @HttpCode(200)
  @ApiOperation({ summary: 'Send another confirmation link' })
  async resend(@CurrentUser() principal: SessionPrincipal | undefined) {
    if (!principal) throw errors.unauthenticated()
    const result = await this.recovery.sendVerification(principal.userId)
    return { message: 'If your address still needs confirming, a link is on its way.', ...result }
  }

  @Post('change-password')
  @HttpCode(200)
  @ApiOperation({ summary: 'Change your password while signed in' })
  async change(@Body() body: unknown, @CurrentUser() principal: SessionPrincipal | undefined) {
    if (!principal) throw errors.unauthenticated()

    const input = parse(
      z.object({
        currentPassword: z.string().min(1),
        newPassword: z.string().min(8, 'Use at least 8 characters.').max(200),
      }),
      body
    )

    const result = await this.recovery.changePassword(
      principal.userId,
      input.currentPassword,
      input.newPassword,
      principal.sessionId
    )
    if (!result.ok) throw errors.validation(result.reason, 'currentPassword')

    return {
      message:
        'Password changed. Your other sessions have been signed out; this one is still active.',
    }
  }

  /**
   * Whether this installation can actually send mail.
   *
   * The sign-in page reads it so it can say "ask your administrator" instead of
   * offering a reset link that will only ever reach a log file.
   */
  @Public()
  @Get('capabilities')
  @ApiOperation({ summary: 'What this installation can do for account recovery' })
  capabilities() {
    return { deliversMail: this.recovery.deliversMail }
  }
}

function parse<S extends z.ZodTypeAny>(schema: S, body: unknown): z.output<S> {
  const result = schema.safeParse(body)
  if (result.success) return result.data
  const issue = result.error.issues[0]
  throw errors.validation(
    issue ? `${issue.path.join('.') || 'body'}: ${issue.message}` : 'The request body is invalid.',
    issue?.path.join('.')
  )
}
