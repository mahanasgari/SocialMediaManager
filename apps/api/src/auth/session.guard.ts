import { Injectable } from '@nestjs/common'
import type { CanActivate, ExecutionContext } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import type { AuthMode } from '@smm/auth'
import { errors } from '../common/errors.js'
import { PUBLIC_ROUTE } from './auth-mode.guard.js'
import { SessionService, type SessionPrincipal } from './session.service.js'
import { ApiKeyService, type ApiPrincipal } from './api-key.service.js'

/**
 * Turns a resolved credential into a principal.
 *
 * Deliberately separate from AuthModeGuard, which decides WHICH credential
 * applies and rejects ambiguity. Keeping "which credential" apart from "who is
 * this" means the dual-auth rejection is provable in isolation, without a
 * database.
 *
 * Runs after AuthModeGuard, so request.auth is already populated.
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
    private readonly apiKeys: ApiKeyService
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_ROUTE, [
      context.getHandler(),
      context.getClass(),
    ])

    const request = context.switchToHttp().getRequest<{
      auth?: { mode: AuthMode }
      principal?: SessionPrincipal
      apiPrincipal?: ApiPrincipal
    }>()

    const mode = request.auth?.mode
    if (!mode || mode.kind === 'anonymous') return Boolean(isPublic)

    if (mode.kind === 'session') {
      const principal = await this.sessions.resolve(mode.token)
      // A revoked, expired, or unknown token is indistinguishable to the caller.
      // Saying which would confirm that a token was once valid.
      if (!principal) {
        if (isPublic) return true
        throw errors.unauthenticated('Your session has ended. Sign in again.')
      }
      request.principal = principal
      return true
    }

    if (mode.kind === 'apiKey') {
      const api = await this.apiKeys.resolve(mode.token)
      // Revoked, expired and unknown are indistinguishable to the caller.
      // Saying which would confirm that a key was once valid.
      if (!api) {
        if (isPublic) return true
        throw errors.unauthenticated('That API key is not valid.')
      }
      request.apiPrincipal = api
      return true
    }

    return Boolean(isPublic)
  }
}
