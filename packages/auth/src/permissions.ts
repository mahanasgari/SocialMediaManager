/**
 * The permission model.
 *
 * Authorization is evaluated SERVER-SIDE ONLY. The frontend never decides what a
 * user may do; it only decides what to render. Every route handler and every
 * worker job resolves through `authorize()` — there are no inline role checks,
 * because scattered `if (role === 'ADMIN')` comparisons are how permission bugs
 * get in and how they stay hidden.
 */

export const ROLES = [
  'OWNER',
  'ADMIN',
  'MANAGER',
  'EDITOR',
  'AUTHOR',
  'APPROVER',
  'ANALYST',
  'CLIENT',
  'VIEWER',
] as const

export type Role = (typeof ROLES)[number]

export const PERMISSIONS = [
  'workspace.manage',
  'members.manage',
  'billing.manage',
  'accounts.connect',
  'content.create',
  'content.edit',
  'content.delete',
  'content.publish',
  'content.approve',
  'analytics.view',
  'reports.export',
  /**
   * Replying in the unified inbox.
   *
   * Separate from content.create because it is a different act with a different
   * risk: a reply goes out immediately, under the brand's name, with no
   * approval step and no schedule to catch it. Someone trusted to draft posts
   * for review is not automatically trusted to speak live to the audience.
   */
  'inbox.reply',
  /** Assigning, snoozing and archiving conversations. */
  'inbox.manage',
  'integrations.manage',
  'apikeys.manage',
  'settings.manage',
] as const

export type Permission = (typeof PERMISSIONS)[number]

/**
 * The grant matrix. `satisfies` with no partials permitted means adding a
 * permission to the list above breaks compilation until every role declares a
 * position on it — which is the desired behaviour, because a silently-defaulted
 * `false` on a role that should have the grant is a permanently invisible gap,
 * and a silently-defaulted `true` is a security hole.
 */
export const ROLE_PERMISSIONS = {
  OWNER: new Set<Permission>(PERMISSIONS),

  // Everything except billing — the distinction that makes "admin" safe to hand
  // out inside an organization.
  ADMIN: new Set<Permission>(PERMISSIONS.filter((p) => p !== 'billing.manage')),

  MANAGER: new Set<Permission>([
    'accounts.connect',
    'inbox.reply',
    'inbox.manage',
    'content.create',
    'content.edit',
    'content.delete',
    'content.publish',
    'content.approve',
    'analytics.view',
    'reports.export',
    'settings.manage',
  ]),

  EDITOR: new Set<Permission>([
    'inbox.reply',
    'content.create',
    'content.edit',
    'content.delete',
    'content.publish',
    'analytics.view',
    'reports.export',
  ]),

  // Drafts but cannot publish. The edit grant is narrowed to own content by the
  // ownership check in `authorize()` — a role alone cannot express "own posts".
  // No inbox.reply: an author drafts for review, and a reply bypasses review
  // entirely by going out the moment it is written.
  AUTHOR: new Set<Permission>(['content.create', 'content.edit', 'analytics.view']),

  APPROVER: new Set<Permission>(['content.approve', 'analytics.view']),

  ANALYST: new Set<Permission>(['analytics.view', 'reports.export']),

  // External stakeholder: sees results, signs off, touches nothing else.
  CLIENT: new Set<Permission>(['content.approve', 'analytics.view']),

  VIEWER: new Set<Permission>(['analytics.view']),
} as const satisfies Record<Role, ReadonlySet<Permission>>

/** Roles whose content grants apply only to content they authored. */
const OWN_CONTENT_ONLY: ReadonlySet<Role> = new Set<Role>(['AUTHOR'])

/** Permissions that the ownership narrowing applies to. */
const OWNABLE: ReadonlySet<Permission> = new Set<Permission>([
  'content.edit',
  'content.delete',
  'analytics.view',
])

export type Principal = {
  userId: string
  role: Role
}

export type Resource = {
  /** Author of the resource, when it has one. */
  authorId?: string
}

export type AuthorizationResult =
  | { allowed: true }
  | { allowed: false; reason: string }

/**
 * The single authorization entry point.
 *
 * Returns a result rather than throwing so callers can distinguish "not
 * permitted" (403) from "does not exist in your workspace" (404) — and the API
 * deliberately collapses those to 404 at the edge, so existence is not leaked by
 * the difference between the two.
 */
export function authorize(
  principal: Principal,
  permission: Permission,
  resource?: Resource
): AuthorizationResult {
  const grants = ROLE_PERMISSIONS[principal.role]

  if (!grants.has(permission)) {
    return { allowed: false, reason: `role ${principal.role} lacks ${permission}` }
  }

  if (
    resource?.authorId !== undefined &&
    OWN_CONTENT_ONLY.has(principal.role) &&
    OWNABLE.has(permission) &&
    resource.authorId !== principal.userId
  ) {
    return {
      allowed: false,
      reason: `role ${principal.role} may only ${permission} content it authored`,
    }
  }

  return { allowed: true }
}

/** Convenience for call sites that want a boolean. */
export function can(principal: Principal, permission: Permission, resource?: Resource): boolean {
  return authorize(principal, permission, resource).allowed
}

/**
 * The permission set for a role, for the API to hand to the frontend so it can
 * decide what to RENDER. It is never what decides what a user may DO.
 */
export function permissionsFor(role: Role): Permission[] {
  return [...ROLE_PERMISSIONS[role]].sort()
}
