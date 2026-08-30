import { Injectable, SetMetadata } from '@nestjs/common'
import type { CanActivate, ExecutionContext } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { resolveAuthMode, type AuthMode } from '@smm/auth'
import { cookiePolicy, loadEnv } from '@smm/config'
import { errors } from '../common/errors.js'

/**
 * Marks a route as reachable without authentication.
 *
 * Applied to login, registration, and — importantly — the inbound webhook
 * receiver, which has no user and no workspace at the point of arrival. That
 * route is exempt from session auth and the tenancy guard, but NEVER from
 * signature verification. See SECURITY.md section 5.
 */
export const PUBLIC_ROUTE = 'smm:publicRoute'
export const Public = () => SetMetadata(PUBLIC_ROUTE, true)

export type RequestAuth = {
  mode: AuthMode
}

/**
 * Resolves which credential a request presents, and rejects ambiguity.
 *
 * This guard does not authenticate — it decides WHICH authentication applies.
 * The separation matters because the dangerous case is not a bad credential, it
 * is two credentials at once.
 */
@Injectable()
export class AuthModeGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_ROUTE, [
      context.getHandler(),
      context.getClass(),
    ])

    const request = context.switchToHttp().getRequest<{
      headers: Record<string, string | string[] | undefined>
      cookies?: Record<string, string>
      auth?: RequestAuth
    }>()

    const cookieName = cookiePolicy(loadEnv()).name
    const authorization = request.headers['authorization']

    const mode = resolveAuthMode({
      sessionCookie: request.cookies?.[cookieName],
      authorizationHeader: Array.isArray(authorization) ? authorization[0] : authorization,
    })

    // Rejected outright rather than resolved by precedence. If we picked one, an
    // attacker able to set either credential would choose which authority
    // applies — a confused deputy, and the usual way products that expose both a
    // web app and a public API get owned. One error path removes the class.
    if (mode.kind === 'conflict') throw errors.authModeConflict()

    request.auth = { mode }

    if (isPublic) return true
    if (mode.kind === 'anonymous') throw errors.unauthenticated()

    return true
  }
}
