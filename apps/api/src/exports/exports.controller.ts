import { Body, Controller, Get, Header, Param, Post, Query, Res } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import type { FastifyReply } from 'fastify'
import { withTenant } from '@smm/database'
import { getObject } from '@smm/storage'
import { z } from 'zod'
import { errors } from '../common/errors.js'
import { Caller, resolveAccess, type Principal } from '../auth/principal.js'
import { MembershipService } from '../tenancy/membership.service.js'

/**
 * Requesting and collecting an export.
 *
 * The request returns immediately with a job; the worker builds the file. That
 * is not an optimisation, it is the only shape that works — a workspace with a
 * year of history and fifty thousand messages is not a request handler's
 * problem, and the two synchronous alternatives both fail on exactly the
 * workspaces most likely to need one.
 *
 * Both endpoints require `reports.export`, which OWNER, ADMIN and ANALYST hold.
 * A subject export in particular is a bundle of one person's private messages,
 * and the roles that cannot see the inbox must not be able to download it in a
 * file instead.
 */

const requestSchema = z
  .object({
    workspaceId: z.string().uuid(),
    kind: z.enum(['WORKSPACE', 'SUBJECT']),
    subjectHandle: z.string().min(1).max(200).optional(),
  })
  .refine((v) => v.kind !== 'SUBJECT' || !!v.subjectHandle, {
    message: 'A subject export needs the handle of the person it is about.',
    path: ['subjectHandle'],
  })

@ApiTags('exports')
@Controller('exports')
export class ExportsController {
  constructor(private readonly memberships: MembershipService) {}

  private authorise(principal: Principal | undefined, workspaceId: string) {
    return resolveAccess(principal, workspaceId, 'reports.export', (u, w) =>
      this.memberships.requireAccess(u, w)
    )
  }

  @Get()
  @ApiOperation({ summary: 'Exports requested in a workspace' })
  async list(
    @Query('workspaceId') workspaceId: string,
    @Caller() principal: Principal | undefined
  ) {
    if (!workspaceId) throw errors.validation('workspaceId is required.', 'workspaceId')
    await this.authorise(principal, workspaceId)

    return withTenant(workspaceId, async (tx) =>
      tx.exportJob.findMany({
        orderBy: { createdAt: 'desc' },
        take: 50,
        select: {
          id: true,
          kind: true,
          subjectHandle: true,
          status: true,
          bytes: true,
          summary: true,
          error: true,
          createdAt: true,
          finishedAt: true,
          expiresAt: true,
          requestedBy: { select: { email: true } },
        },
      })
    )
  }

  @Post()
  @ApiOperation({ summary: 'Request an export' })
  async request(@Body() body: unknown, @Caller() principal: Principal | undefined) {
    const parsed = requestSchema.safeParse(body)
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      throw errors.validation(
        issue?.message ?? 'The request body is invalid.',
        issue?.path.join('.')
      )
    }
    const input = parsed.data

    await this.authorise(principal, input.workspaceId)

    return withTenant(input.workspaceId, async (tx) => {
      // One at a time per workspace. A queue of eight identical workspace
      // exports is somebody clicking a button that did not visibly respond, and
      // each one reads a year of history.
      const running = await tx.exportJob.findFirst({
        where: { status: { in: ['PENDING', 'RUNNING'] } },
        select: { id: true },
      })
      if (running) {
        throw errors.conflict(
          'export_in_progress',
          'An export is already being prepared for this workspace. Wait for it to finish.'
        )
      }

      return tx.exportJob.create({
        data: {
          kind: input.kind,
          ...(input.subjectHandle ? { subjectHandle: input.subjectHandle } : {}),
          ...(principal?.kind === 'user' ? { requestedById: principal.userId } : {}),
        } as never,
        select: { id: true, kind: true, status: true, createdAt: true },
      })
    })
  }

  @Get(':id/download')
  @Header('cache-control', 'no-store')
  @ApiOperation({ summary: 'Download a finished export' })
  async download(
    @Param('id') id: string,
    @Query('workspaceId') workspaceId: string,
    @Caller() principal: Principal | undefined,
    @Res() reply: FastifyReply
  ) {
    if (!workspaceId) throw errors.validation('workspaceId is required.', 'workspaceId')
    await this.authorise(principal, workspaceId)

    const job = await withTenant(workspaceId, async (tx) =>
      tx.exportJob.findUnique({
        where: { id },
        select: { id: true, kind: true, status: true, storageKey: true, subjectHandle: true },
      })
    )
    if (!job) throw errors.notFound('That export does not exist.')

    // Each non-ready state gets its own message. "Not available" for a job that
    // is still building, one that failed, and one whose file has been deleted
    // sends three different people to ask the same question.
    if (job.status === 'PENDING' || job.status === 'RUNNING') {
      throw errors.conflict('export_not_ready', 'That export is still being prepared.')
    }
    if (job.status === 'FAILED') {
      throw errors.conflict('export_failed', 'That export could not be built. Request another.')
    }
    if (job.status === 'EXPIRED' || !job.storageKey) {
      throw errors.conflict(
        'export_expired',
        'That export has expired and its file was deleted. Request another.'
      )
    }

    const object = await getObject(job.storageKey)

    // Streamed through the API rather than handed out as a presigned storage
    // URL. A presigned URL is a bearer token in a query string: it outlives the
    // session, survives being pasted into a chat, and cannot be revoked. For a
    // file that may contain one person's entire message history, the extra hop
    // is worth it.
    const name =
      job.kind === 'SUBJECT'
        ? `export-subject-${(job.subjectHandle ?? 'unknown').replace(/[^a-zA-Z0-9._-]/g, '_')}.json.gz`
        : `export-workspace-${workspaceId}.json.gz`

    return reply
      .header('content-type', 'application/gzip')
      .header('content-disposition', `attachment; filename="${name}"`)
      .send(object.body)
  }
}
