import { Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import { authorize, issueApiKey } from '@smm/auth'
import { withTenant } from '@smm/database'
import { z } from 'zod'
import { errors } from '../common/errors.js'
import { CurrentUser } from '../auth/current-user.js'
import type { SessionPrincipal } from '../auth/session.service.js'
import { MembershipService } from '../tenancy/membership.service.js'

export const SCOPES = [
  'posts:read',
  'posts:write',
  'accounts:read',
  'analytics:read',
  'media:write',
] as const

const createSchema = z.object({
  workspaceId: z.string().uuid(),
  name: z.string().min(1).max(80),
  scopes: z.array(z.enum(SCOPES)).min(1),
  expiresInDays: z.number().int().min(1).max(3650).optional(),
})

@ApiTags('api-keys')
@Controller('api-keys')
export class ApiKeysController {
  constructor(private readonly memberships: MembershipService) {}

  @Get()
  @ApiOperation({ summary: 'API keys in a workspace' })
  async list(
    @Query('workspaceId') workspaceId: string,
    @CurrentUser() principal: SessionPrincipal | undefined
  ) {
    if (!principal) throw errors.unauthenticated()
    if (!workspaceId) throw errors.validation('workspaceId is required.', 'workspaceId')
    const access = await this.memberships.requireAccess(principal.userId, workspaceId)
    this.require(principal.userId, access.role)

    return withTenant(workspaceId, async (tx) =>
      tx.apiKey.findMany({
        // keyHash is never selected. There is no legitimate reason for a listing
        // endpoint to load it, and not selecting it means a future serialisation
        // mistake cannot leak one.
        select: {
          id: true,
          name: true,
          prefix: true,
          scopes: true,
          lastUsedAt: true,
          expiresAt: true,
          revokedAt: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'desc' },
      })
    )
  }

  @Post()
  @ApiOperation({ summary: 'Create an API key — the secret is shown once' })
  async create(@Body() body: unknown, @CurrentUser() principal: SessionPrincipal | undefined) {
    if (!principal) throw errors.unauthenticated()
    const parsed = createSchema.safeParse(body)
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      throw errors.validation(issue?.message ?? 'Invalid request.', issue?.path.join('.'))
    }
    const input = parsed.data

    const access = await this.memberships.requireAccess(principal.userId, input.workspaceId)
    this.require(principal.userId, access.role)

    const key = issueApiKey()

    await withTenant(input.workspaceId, async (tx) => {
      await tx.apiKey.create({
         
        data: {
          name: input.name,
          keyHash: key.hash,
          prefix: key.displayPrefix,
          scopes: input.scopes,
          createdById: principal.userId,
          expiresAt: input.expiresInDays
            ? new Date(Date.now() + input.expiresInDays * 86_400_000)
            : null,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
      })
      await tx.auditLog.create({
         
        data: {
          actorId: principal.userId,
          action: 'apikey.created',
          entityType: 'ApiKey',
          metadata: { name: input.name, scopes: input.scopes },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
      })
    })

    // The ONLY moment the plaintext exists outside the caller's hands.
    return {
      key: key.token,
      prefix: key.displayPrefix,
      warning: 'Copy this now. It is hashed at rest and cannot be shown again.',
    }
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Revoke an API key' })
  async revoke(
    @Param('id') id: string,
    @Query('workspaceId') workspaceId: string,
    @CurrentUser() principal: SessionPrincipal | undefined
  ) {
    if (!principal) throw errors.unauthenticated()
    if (!workspaceId) throw errors.validation('workspaceId is required.', 'workspaceId')
    const access = await this.memberships.requireAccess(principal.userId, workspaceId)
    this.require(principal.userId, access.role)

    await withTenant(workspaceId, async (tx) => {
      // Revoked, not deleted. The audit trail and lastUsedAt stay meaningful,
      // and a revoked key appearing in logs is far easier to explain than a key
      // nobody has any record of ever existing.
      await tx.apiKey.updateMany({
        where: { id, revokedAt: null },
        data: { revokedAt: new Date() },
      })
      await tx.auditLog.create({
         
        data: {
          actorId: principal.userId,
          action: 'apikey.revoked',
          entityType: 'ApiKey',
          entityId: id,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
      })
    })

    return { revoked: true }
  }

  private require(userId: string, role: Parameters<typeof authorize>[0]['role']): void {
    const result = authorize({ userId, role }, 'apikeys.manage')
    if (!result.allowed) {
      throw errors.forbidden('Your role does not permit managing API keys.', {
        required: 'apikeys.manage',
      })
    }
  }
}
