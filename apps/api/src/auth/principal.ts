import { createParamDecorator } from '@nestjs/common'
import type { ExecutionContext } from '@nestjs/common'
import { authorize, type Permission, type Role } from '@smm/auth'
import { errors } from '../common/errors.js'
import type { SessionPrincipal } from './session.service.js'
import type { ApiPrincipal } from './api-key.service.js'

/**
 * One principal type for both authentication modes.
 *
 * Handlers should never branch on "is this a session or a key?" — that is how a
 * permission check ends up implemented twice and diverging. They ask one
 * question: may this principal do X in workspace Y.
 */
export type Principal =
  | ({ kind: 'user' } & SessionPrincipal)
  | ApiPrincipal

export const Caller = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): Principal | undefined => {
    const request = ctx.switchToHttp().getRequest<{
      principal?: SessionPrincipal
      apiPrincipal?: ApiPrincipal
    }>()
    if (request.principal) return { kind: 'user', ...request.principal }
    return request.apiPrincipal
  }
)

/**
 * Permission to scope mapping.
 *
 * A key is NOT a person. It has no role and inherits none — a key created by an
 * owner is not an owner. It can do exactly what its scopes list, so a leaked key
 * is bounded by what it was issued for rather than by who issued it.
 */
const SCOPE_FOR: Partial<Record<Permission, string>> = {
  'content.create': 'posts:write',
  'content.edit': 'posts:write',
  'content.delete': 'posts:write',
  'content.publish': 'posts:write',
  'analytics.view': 'analytics:read',
  'accounts.connect': 'accounts:read',
}

/** Read-only permissions a `posts:read` scope satisfies. */
const READ_SCOPES: Partial<Record<Permission, string>> = {
  'analytics.view': 'analytics:read',
}

export type Access = {
  workspaceId: string
  organizationId: string
  /** Present only for a human caller. */
  userId?: string
  role?: Role
}

export type MembershipLookup = (
  userId: string,
  workspaceId: string
) => Promise<{ workspaceId: string; organizationId: string; role: Role }>

/**
 * Resolves access for either principal kind.
 *
 * The two paths differ in what they check but agree on what they return, so a
 * handler downstream cannot accidentally treat one as the other.
 */
export async function resolveAccess(
  principal: Principal | undefined,
  workspaceId: string,
  permission: Permission,
  lookup: MembershipLookup
): Promise<Access> {
  if (!principal) throw errors.unauthenticated()

  if (principal.kind === 'user') {
    const access = await lookup(principal.userId, workspaceId)
    const allowed = authorize({ userId: principal.userId, role: access.role }, permission)
    if (!allowed.allowed) {
      throw errors.forbidden('Your role does not permit this action.', { required: permission })
    }
    return { ...access, userId: principal.userId }
  }

  // A key is bound to ONE workspace at issue time. Presenting it for another is
  // a 404, not a 403 — the same rule every other resource follows, so the key
  // cannot be used to discover which workspaces exist.
  if (principal.workspaceId !== workspaceId) throw errors.notFound('workspace')

  const required = SCOPE_FOR[permission] ?? READ_SCOPES[permission]
  if (required && !principal.scopes.includes(required)) {
    throw errors.forbidden(
      `This API key does not have the "${required}" scope, which this operation requires.`,
      { required }
    )
  }

  return { workspaceId: principal.workspaceId, organizationId: principal.organizationId }
}

/** Reads need a scope too, but no role — used for plain list endpoints. */
export async function resolveRead(
  principal: Principal | undefined,
  workspaceId: string,
  scope: string,
  lookup: MembershipLookup
): Promise<Access> {
  if (!principal) throw errors.unauthenticated()

  if (principal.kind === 'user') {
    const access = await lookup(principal.userId, workspaceId)
    return { ...access, userId: principal.userId }
  }

  if (principal.workspaceId !== workspaceId) throw errors.notFound('workspace')
  if (!principal.scopes.includes(scope)) {
    throw errors.forbidden(`This API key does not have the "${scope}" scope.`, { required: scope })
  }

  return { workspaceId: principal.workspaceId, organizationId: principal.organizationId }
}
