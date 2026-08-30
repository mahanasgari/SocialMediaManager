import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import { authorize } from '@smm/auth'
import { withTenant } from '@smm/database'
import { z } from 'zod'
import { errors } from '../common/errors.js'
import { CurrentUser } from '../auth/current-user.js'
import type { SessionPrincipal } from '../auth/session.service.js'
import { MembershipService } from '../tenancy/membership.service.js'

const submitSchema = z.object({
  workspaceId: z.string().uuid(),
  approverIds: z.array(z.string().uuid()).min(1).max(10),
  mode: z.enum(['ANY', 'ALL']).default('ANY'),
  note: z.string().max(2000).optional(),
})

const decideSchema = z.object({
  workspaceId: z.string().uuid(),
  decision: z.enum(['APPROVED', 'CHANGES_REQUESTED']),
  note: z.string().max(2000).optional(),
})

const commentSchema = z.object({
  workspaceId: z.string().uuid(),
  body: z.string().min(1).max(5000),
  parentId: z.string().uuid().optional(),
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

/**
 * Approvals.
 *
 * `PENDING_APPROVAL` and `APPROVED` have existed in the PostStatus enum since
 * the publishing pipeline was built, deliberately unused. They are editorial
 * gates with no variant counterpart, so the status reducer never derives them —
 * this controller is the only thing that writes them.
 */
@ApiTags('approvals')
@Controller('approvals')
export class ApprovalsController {
  constructor(private readonly memberships: MembershipService) {}

  @Get()
  @ApiOperation({ summary: 'Posts awaiting a decision' })
  async queue(
    @Query('workspaceId') workspaceId: string,
    @CurrentUser() principal: SessionPrincipal | undefined
  ) {
    if (!principal) throw errors.unauthenticated()
    if (!workspaceId) throw errors.validation('workspaceId is required.', 'workspaceId')
    await this.memberships.requireAccess(principal.userId, workspaceId)

    return withTenant(workspaceId, async (tx) => {
      const approvals = await tx.approval.findMany({
        where: { state: 'PENDING' },
        select: {
          id: true,
          mode: true,
          note: true,
          createdAt: true,
          post: { select: { id: true, baseContent: true, scheduledAt: true } },
          steps: {
            select: {
              approverId: true,
              decision: true,
              note: true,
              decidedAt: true,
            },
          },
        },
        orderBy: { createdAt: 'asc' },
      })

      return approvals.map((a) => ({
        ...a,
        // Whether THIS user still owes a decision, so the queue can show what is
        // waiting on them rather than everything waiting on anyone.
        awaitingYou: a.steps.some(
          (s) => s.approverId === principal.userId && s.decision === 'PENDING'
        ),
      }))
    })
  }

  @Post('posts/:postId/submit')
  @ApiOperation({ summary: 'Submit a post for approval' })
  async submit(
    @Param('postId') postId: string,
    @Body() body: unknown,
    @CurrentUser() principal: SessionPrincipal | undefined
  ) {
    if (!principal) throw errors.unauthenticated()
    const input = parse(submitSchema, body)
    const access = await this.memberships.requireAccess(principal.userId, input.workspaceId)
    this.require(principal.userId, access.role, 'content.create')

    return withTenant(input.workspaceId, async (tx) => {
      const post = await tx.post.findUnique({ where: { id: postId }, select: { status: true } })
      if (!post) throw errors.notFound('post')

      if (post.status !== 'DRAFT') {
        throw errors.unprocessable(
          'not_a_draft',
          'Only a draft can be submitted for approval. This post has already moved on.'
        )
      }

      const approval = await tx.approval.create({
         
        data: {
          postId,
          requestedById: principal.userId,
          mode: input.mode,
          note: input.note ?? null,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
        select: { id: true },
      })

      for (const [order, approverId] of input.approverIds.entries()) {
        await tx.approvalStep.create({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          data: { approvalId: approval.id, approverId, order } as any,
        })
        await tx.notification.create({
           
          data: {
            userId: approverId,
            kind: 'approval.requested',
            title: 'A post needs your approval',
            body: input.note ?? null,
            href: `/w/${input.workspaceId}/approvals`,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } as any,
        })
      }

      // The editorial gate. The reducer will not touch this — shouldDerive()
      // refuses to overwrite it — so it stays until somebody decides.
      await tx.post.update({ where: { id: postId }, data: { status: 'PENDING_APPROVAL' } })

      await tx.auditLog.create({
         
        data: {
          actorId: principal.userId,
          action: 'approval.requested',
          entityType: 'Post',
          entityId: postId,
          metadata: { approvers: input.approverIds.length, mode: input.mode },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
      })

      return { approvalId: approval.id, state: 'PENDING' }
    })
  }

  @Post('posts/:postId/decide')
  @ApiOperation({ summary: 'Approve a post, or request changes' })
  async decide(
    @Param('postId') postId: string,
    @Body() body: unknown,
    @CurrentUser() principal: SessionPrincipal | undefined
  ) {
    if (!principal) throw errors.unauthenticated()
    const input = parse(decideSchema, body)
    const access = await this.memberships.requireAccess(principal.userId, input.workspaceId)
    this.require(principal.userId, access.role, 'content.approve')

    return withTenant(input.workspaceId, async (tx) => {
      const approval = await tx.approval.findUnique({
        where: { postId },
        select: { id: true, mode: true, state: true, steps: { select: { approverId: true, decision: true } } },
      })
      if (!approval) throw errors.notFound('approval')
      if (approval.state !== 'PENDING') {
        throw errors.unprocessable('already_decided', 'This approval has already been decided.')
      }

      const isApprover = approval.steps.some((s) => s.approverId === principal.userId)
      if (!isApprover) {
        // 403 rather than 404: the approval is visible to the workspace, so
        // hiding it would be confusing without hiding anything.
        throw errors.forbidden('You were not asked to approve this post.')
      }

      await tx.approvalStep.updateMany({
        where: { approvalId: approval.id, approverId: principal.userId },
        data: { decision: input.decision, note: input.note ?? null, decidedAt: new Date() },
      })

      const steps = await tx.approvalStep.findMany({
        where: { approvalId: approval.id },
        select: { decision: true },
      })

      // CHANGES_REQUESTED from anyone ends it immediately, whatever the mode:
      // once one reviewer wants changes, further approvals are approving
      // something that is about to be edited.
      const rejected = steps.some((s) => s.decision === 'CHANGES_REQUESTED')
      const allApproved = steps.every((s) => s.decision === 'APPROVED')
      const anyApproved = steps.some((s) => s.decision === 'APPROVED')

      const resolved = rejected
        ? 'CHANGES_REQUESTED'
        : approval.mode === 'ALL'
          ? allApproved
            ? 'APPROVED'
            : null
          : anyApproved
            ? 'APPROVED'
            : null

      if (resolved) {
        await tx.approval.update({
          where: { id: approval.id },
          data: { state: resolved, decidedAt: new Date() },
        })
        await tx.post.update({
          where: { id: postId },
          // Rejected goes back to DRAFT so the author can edit and resubmit;
          // leaving it in PENDING_APPROVAL would strand it.
          data: { status: resolved === 'APPROVED' ? 'APPROVED' : 'DRAFT' },
        })
      }

      await tx.auditLog.create({
         
        data: {
          actorId: principal.userId,
          action: `approval.${input.decision.toLowerCase()}`,
          entityType: 'Post',
          entityId: postId,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
      })

      return { state: resolved ?? 'PENDING', yourDecision: input.decision }
    })
  }

  @Get('posts/:postId/comments')
  @ApiOperation({ summary: 'Internal notes on a post' })
  async comments(
    @Param('postId') postId: string,
    @Query('workspaceId') workspaceId: string,
    @CurrentUser() principal: SessionPrincipal | undefined
  ) {
    if (!principal) throw errors.unauthenticated()
    if (!workspaceId) throw errors.validation('workspaceId is required.', 'workspaceId')
    await this.memberships.requireAccess(principal.userId, workspaceId)

    return withTenant(workspaceId, async (tx) =>
      tx.postComment.findMany({
        where: { postId },
        select: {
          id: true,
          body: true,
          parentId: true,
          resolvedAt: true,
          createdAt: true,
          author: { select: { id: true, name: true } },
        },
        orderBy: { createdAt: 'asc' },
      })
    )
  }

  @Post('posts/:postId/comments')
  @ApiOperation({ summary: 'Add an internal note' })
  async comment(
    @Param('postId') postId: string,
    @Body() body: unknown,
    @CurrentUser() principal: SessionPrincipal | undefined
  ) {
    if (!principal) throw errors.unauthenticated()
    const input = parse(commentSchema, body)
    await this.memberships.requireAccess(principal.userId, input.workspaceId)

    // Deliberately NOT permission-gated beyond workspace membership. Anyone who
    // can see a post can comment on it — an internal note is not a mutation of
    // the content, and gating it would make review harder for the roles whose
    // entire job is reviewing.
    return withTenant(input.workspaceId, async (tx) =>
      tx.postComment.create({
         
        data: {
          postId,
          authorId: principal.userId,
          body: input.body,
          parentId: input.parentId ?? null,
          mentions: extractMentions(input.body),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
        select: { id: true, body: true, createdAt: true },
      })
    )
  }

  private require(
    userId: string,
    role: Parameters<typeof authorize>[0]['role'],
    permission: Parameters<typeof authorize>[1]
  ): void {
    const result = authorize({ userId, role }, permission)
    if (!result.allowed) {
      throw errors.forbidden('Your role does not permit this action.', { required: permission })
    }
  }
}

function extractMentions(body: string): string[] {
  return [...new Set((body.match(/@[\w.-]+/g) ?? []).map((m) => m.slice(1)))]
}
