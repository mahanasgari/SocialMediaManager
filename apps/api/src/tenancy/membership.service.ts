import { Injectable } from '@nestjs/common'
import { withOrganization, withUser } from '@smm/database'
import type { Role } from '@smm/auth'
import { errors } from '../common/errors.js'

/**
 * Resolves what a user may reach.
 *
 * Membership lookup is the one query that legitimately spans workspaces — it is
 * how we discover which workspaces a person can see at all — so it runs under a
 * system scope with a stated reason. Everything derived from it is then properly
 * scoped.
 */

export type WorkspaceAccess = {
  workspaceId: string
  organizationId: string
  role: Role
  name: string
  slug: string
  timezone: string
}

@Injectable()
export class MembershipService {
  /** Every workspace this user can reach, across every organization. */
  async listForUser(userId: string): Promise<WorkspaceAccess[]> {
    // Runs under a per-user RLS context rather than a tenant one. Discovering
    // which workspaces someone belongs to is the query that PRECEDES tenancy —
    // there is no workspace to scope by yet. The database has SELECT-only
    // policies for exactly this, so it is expressed as policy rather than as a
    // bypass.
    const rows = await withUser(
      userId,
      'membership discovery precedes any tenant scope',
      async (tx) =>
        tx.membership.findMany({
          where: { userId, deletedAt: null, workspaceId: { not: null } },
          select: {
            role: true,
            workspaceId: true,
            organizationId: true,
            workspace: { select: { name: true, slug: true, timezone: true, deletedAt: true } },
          },
          orderBy: { createdAt: 'asc' },
        })
    )

    return rows
      .filter((r) => r.workspace && !r.workspace.deletedAt)
      .map((r) => ({
        workspaceId: r.workspaceId!,
        organizationId: r.organizationId,
        role: r.role as Role,
        name: r.workspace!.name,
        slug: r.workspace!.slug,
        timezone: r.workspace!.timezone,
      }))
  }

  /**
   * Resolves a requested workspace, or refuses.
   *
   * A workspace the user is not a member of yields 404, not 403. A 403 would
   * confirm the workspace exists, which is an enumeration oracle — the same rule
   * the API applies to every other resource.
   */
  async requireAccess(userId: string, workspaceId: string): Promise<WorkspaceAccess> {
    const access = (await this.listForUser(userId)).find((a) => a.workspaceId === workspaceId)
    if (!access) throw errors.notFound('workspace')
    return access
  }

  /** Organization-wide memberships, used for org-level permission checks. */
  async organizationRole(userId: string, organizationId: string): Promise<Role | null> {
    const row = await withUser(
      userId,
      'organization membership lookup precedes establishing an organization scope',
      async (tx) =>
        tx.membership.findFirst({
          where: { userId, organizationId, workspaceId: null, deletedAt: null },
          select: { role: true },
        })
    )
    return (row?.role as Role) ?? null
  }

  /** Members of one workspace. Runs under the organization scope RLS expects. */
  async listMembers(organizationId: string, workspaceId: string) {
    return withOrganization(organizationId, async (tx) => {
      const rows = await tx.membership.findMany({
        where: { workspaceId, deletedAt: null },
        select: {
          id: true,
          role: true,
          createdAt: true,
          user: { select: { id: true, email: true, name: true, avatarUrl: true } },
        },
        orderBy: { createdAt: 'asc' },
      })
      return rows.map((r) => ({
        id: r.id,
        role: r.role,
        joinedAt: r.createdAt,
        user: r.user,
      }))
    })
  }
}
