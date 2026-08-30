import { Body, Controller, Delete, Get, HttpCode, Param, Post } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import { authorize, permissionsFor, type Permission } from '@smm/auth'
import { loadEnv } from '@smm/config'
import { withOrganization, withTenant } from '@smm/database'
import { z } from 'zod'
import { createHash, randomBytes } from 'node:crypto'
import { errors } from '../common/errors.js'
import { CurrentUser } from '../auth/current-user.js'
import type { SessionPrincipal } from '../auth/session.service.js'
import { MembershipService } from '../tenancy/membership.service.js'

const createWorkspaceSchema = z.object({
  name: z.string().min(1).max(120),
  timezone: z.string().min(1).max(64).default('UTC'),
})

const inviteSchema = z.object({
  email: z.string().email(),
  role: z.enum(['ADMIN', 'MANAGER', 'EDITOR', 'AUTHOR', 'APPROVER', 'ANALYST', 'CLIENT', 'VIEWER']),
})

const INVITE_TTL_DAYS = 14

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body)
  if (result.success) return result.data
  const issue = result.error.issues[0]
  throw errors.validation(
    issue ? `${issue.path.join('.') || 'body'}: ${issue.message}` : 'The request body is invalid.',
    issue?.path.join('.')
  )
}

@ApiTags('workspaces')
@Controller('workspaces')
export class WorkspacesController {
  constructor(private readonly memberships: MembershipService) {}

  @Get()
  @ApiOperation({ summary: 'Workspaces the signed-in user can reach' })
  async list(@CurrentUser() principal: SessionPrincipal | undefined) {
    if (!principal) throw errors.unauthenticated()
    const access = await this.memberships.listForUser(principal.userId)

    return access.map((a) => ({
      id: a.workspaceId,
      organizationId: a.organizationId,
      name: a.name,
      slug: a.slug,
      timezone: a.timezone,
      role: a.role,
      // Sent so the UI can decide what to RENDER. It is never what decides what
      // the user may DO — every mutation re-authorizes server-side.
      permissions: permissionsFor(a.role),
    }))
  }

  @Get(':id')
  @ApiOperation({ summary: 'One workspace' })
  async get(@Param('id') id: string, @CurrentUser() principal: SessionPrincipal | undefined) {
    if (!principal) throw errors.unauthenticated()
    const access = await this.memberships.requireAccess(principal.userId, id)
    return {
      id: access.workspaceId,
      organizationId: access.organizationId,
      name: access.name,
      slug: access.slug,
      timezone: access.timezone,
      role: access.role,
      permissions: permissionsFor(access.role),
    }
  }

  @Post()
  @ApiOperation({ summary: 'Create a workspace in an organization the user owns' })
  async create(@Body() body: unknown, @CurrentUser() principal: SessionPrincipal | undefined) {
    if (!principal) throw errors.unauthenticated()
    const input = parse(createWorkspaceSchema, body)

    // Creating a workspace is an ORGANIZATION-level act, so the permission is
    // checked against the org-wide membership, not a workspace role.
    const existing = await this.memberships.listForUser(principal.userId)
    const organizationId = existing[0]?.organizationId
    if (!organizationId) throw errors.forbidden('You do not belong to an organization yet.')

    const orgRole = await this.memberships.organizationRole(principal.userId, organizationId)
    if (!orgRole) throw errors.forbidden('You do not belong to that organization.')
    this.require({ userId: principal.userId, role: orgRole }, 'workspace.manage')

    const slug = `${slugify(input.name)}-${randomBytes(2).toString('hex')}`

    return withOrganization(organizationId, async (tx) => {
      const workspace = await tx.workspace.create({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        data: { name: input.name, slug, timezone: input.timezone } as any,
        select: { id: true, name: true, slug: true, timezone: true },
      })
      await tx.membership.create({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        data: { userId: principal.userId, workspaceId: workspace.id, role: 'OWNER' } as any,
      })
      await tx.auditLog.create({
        data: {
          workspaceId: workspace.id,
          actorId: principal.userId,
          action: 'workspace.created',
          entityType: 'Workspace',
          entityId: workspace.id,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
      })
      return { ...workspace, organizationId, role: 'OWNER' }
    })
  }

  /**
   * Schedules a workspace for deletion.
   *
   * Soft-deletes and starts a grace period. Nothing is destroyed yet, and the
   * response names the ACTUAL purge date rather than saying "soon" — a deletion
   * promise with a vague date is one nobody can plan around, and the number has
   * to match what the retention job will actually do.
   */
  @Delete(':id')
  @ApiOperation({ summary: 'Schedule a workspace for deletion' })
  async remove(@Param('id') id: string, @CurrentUser() principal: SessionPrincipal | undefined) {
    if (!principal) throw errors.unauthenticated()

    const access = await this.memberships.requireAccess(principal.userId, id)
    // Deleting a workspace is not an editing act. Only workspace.manage.
    if (!authorize({ userId: principal.userId, role: access.role }, 'workspace.manage').allowed) {
      throw errors.forbidden('Only an owner or admin can delete a workspace.')
    }

    const graceDays = loadEnv().WORKSPACE_PURGE_GRACE_DAYS
    const deletedAt = new Date()
    const purgeAt = new Date(deletedAt.getTime() + graceDays * 86_400_000)

    await withTenant(id, async (tx) => {
      await tx.workspace.update({ where: { id }, data: { deletedAt } })

      await tx.auditLog.create({
         
        data: {
          workspaceId: id,
          organizationId: access.organizationId,
          actorId: principal.userId,
          action: 'workspace.delete_scheduled',
          entityType: 'Workspace',
          entityId: id,
          metadata: { purgeAt: purgeAt.toISOString(), graceDays },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
      })
    })

    return {
      deleted: true,
      purgeAt: purgeAt.toISOString(),
      // Spelled out, because this is the moment someone needs to know both that
      // it is reversible and exactly how long they have.
      message:
        `Scheduled for deletion. Everything in it — posts, media, conversations and connected ` +
        `accounts — is permanently destroyed on ${purgeAt.toDateString()}. ` +
        `Until then an owner or admin can restore it.`,
    }
  }

  /**
   * Cancels a scheduled deletion.
   *
   * The whole point of a grace period is that it can be used. A deletion that
   * cannot be undone before it happens is just a slower permanent delete.
   */
  @Post(':id/restore')
  @HttpCode(200)
  @ApiOperation({ summary: 'Cancel a scheduled deletion' })
  async restore(@Param('id') id: string, @CurrentUser() principal: SessionPrincipal | undefined) {
    if (!principal) throw errors.unauthenticated()

    const access = await this.memberships.requireAccess(principal.userId, id)
    if (!authorize({ userId: principal.userId, role: access.role }, 'workspace.manage').allowed) {
      throw errors.forbidden('Only an owner or admin can restore a workspace.')
    }

    await withTenant(id, async (tx) => {
      await tx.workspace.update({ where: { id }, data: { deletedAt: null } })
      await tx.auditLog.create({
         
        data: {
          workspaceId: id,
          organizationId: access.organizationId,
          actorId: principal.userId,
          action: 'workspace.delete_cancelled',
          entityType: 'Workspace',
          entityId: id,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
      })
    })

    return { restored: true, message: 'Deletion cancelled. Nothing was removed.' }
  }

  @Get(':id/members')
  @ApiOperation({ summary: 'Members of a workspace' })
  async members(@Param('id') id: string, @CurrentUser() principal: SessionPrincipal | undefined) {
    if (!principal) throw errors.unauthenticated()
    const access = await this.memberships.requireAccess(principal.userId, id)
    this.require({ userId: principal.userId, role: access.role }, 'analytics.view')
    return this.memberships.listMembers(access.organizationId, access.workspaceId)
  }

  @Post(':id/invites')
  @HttpCode(201)
  @ApiOperation({ summary: 'Invite someone to a workspace' })
  async invite(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() principal: SessionPrincipal | undefined
  ) {
    if (!principal) throw errors.unauthenticated()
    const input = parse(inviteSchema, body)
    const access = await this.memberships.requireAccess(principal.userId, id)
    this.require({ userId: principal.userId, role: access.role }, 'members.manage')

    // The token is returned ONCE and only its hash is stored, exactly like a
    // session token. A retrievable invite link is a standing credential.
    const token = randomBytes(32).toString('base64url')
    const tokenHash = createHash('sha256').update(token, 'utf8').digest('hex')

    await withOrganization(access.organizationId, async (tx) => {
      await tx.invite.create({
        data: {
          workspaceId: access.workspaceId,
          email: input.email.trim().toLowerCase(),
          role: input.role,
          tokenHash,
          expiresAt: new Date(Date.now() + INVITE_TTL_DAYS * 86_400_000),
          invitedById: principal.userId,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
      })
      await tx.auditLog.create({
        data: {
          workspaceId: access.workspaceId,
          actorId: principal.userId,
          action: 'invite.created',
          entityType: 'Invite',
          metadata: { email: input.email, role: input.role },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
      })
    })

    return { token, expiresInDays: INVITE_TTL_DAYS }
  }

  @Get(':id/invites')
  @ApiOperation({ summary: 'Pending invites for a workspace' })
  async listInvites(
    @Param('id') id: string,
    @CurrentUser() principal: SessionPrincipal | undefined
  ) {
    if (!principal) throw errors.unauthenticated()
    const access = await this.memberships.requireAccess(principal.userId, id)
    this.require({ userId: principal.userId, role: access.role }, 'members.manage')

    return withOrganization(access.organizationId, async (tx) =>
      tx.invite.findMany({
        where: { workspaceId: access.workspaceId, status: 'PENDING' },
        // tokenHash is deliberately absent: an invite link must not be
        // retrievable after creation, only re-issued.
        select: { id: true, email: true, role: true, expiresAt: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
      })
    )
  }

  /** Every mutation goes through this — there are no inline role comparisons. */
  private require(
    principal: { userId: string; role: Parameters<typeof authorize>[0]['role'] },
    permission: Permission
  ): void {
    const result = authorize(principal, permission)
    if (!result.allowed) {
      throw errors.forbidden(
        `Your role does not permit this action.`,
        { required: permission }
      )
    }
  }
}

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'workspace'
  )
}
