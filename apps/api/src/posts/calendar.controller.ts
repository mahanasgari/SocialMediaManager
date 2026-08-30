import { Controller, Get, Patch, Body, Query, Param } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import { authorize } from '@smm/auth'
import { withTenant } from '@smm/database'
import { describeStatus } from '@smm/publishing'
import { z } from 'zod'
import { errors } from '../common/errors.js'
import { CurrentUser } from '../auth/current-user.js'
import type { SessionPrincipal } from '../auth/session.service.js'
import { MembershipService } from '../tenancy/membership.service.js'

const rescheduleSchema = z.object({
  workspaceId: z.string().uuid(),
  /** Absolute ISO instant. The client converts from the viewer's zone. */
  scheduledAt: z.string().datetime(),
})

@ApiTags('calendar')
@Controller('calendar')
export class CalendarController {
  constructor(private readonly memberships: MembershipService) {}

  @Get()
  @ApiOperation({ summary: 'Scheduled and published posts in a date range' })
  async range(
    @Query('workspaceId') workspaceId: string,
    @Query('from') from: string,
    @Query('to') to: string,
    @CurrentUser() principal: SessionPrincipal | undefined
  ) {
    if (!principal) throw errors.unauthenticated()
    if (!workspaceId) throw errors.validation('workspaceId is required.', 'workspaceId')
    await this.memberships.requireAccess(principal.userId, workspaceId)

    const start = from ? new Date(from) : new Date()
    const end = to ? new Date(to) : new Date(start.getTime() + 31 * 86_400_000)
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      throw errors.validation('from and to must be ISO dates.', 'from')
    }

    return withTenant(workspaceId, async (tx) => {
      // Range-bounded, because a calendar must never load every post a
      // workspace has ever made just to render one month.
      const posts = await tx.post.findMany({
        where: {
          OR: [
            { scheduledAt: { gte: start, lte: end } },
            { publishedAt: { gte: start, lte: end } },
          ],
        },
        select: {
          id: true,
          status: true,
          baseContent: true,
          scheduledAt: true,
          publishedAt: true,
          timezone: true,
          variants: {
            select: {
              id: true,
              status: true,
              socialAccount: { select: { handle: true, provider: true } },
            },
          },
        },
        orderBy: { scheduledAt: 'asc' },
      })

      return posts.map((p) => ({
        id: p.id,
        status: p.status,
        excerpt: p.baseContent.slice(0, 120),
        at: (p.scheduledAt ?? p.publishedAt)?.toISOString() ?? null,
        timezone: p.timezone,
        channels: p.variants.map((v) => v.socialAccount.handle),
        summary: describeStatus(p.status, {
          published: p.variants.filter((v) => v.status === 'PUBLISHED').length,
          total: p.variants.length,
        }),
      }))
    })
  }

  @Patch(':id/reschedule')
  @ApiOperation({ summary: 'Move a post to a different time' })
  async reschedule(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() principal: SessionPrincipal | undefined
  ) {
    if (!principal) throw errors.unauthenticated()
    const input = rescheduleSchema.parse(body)
    const access = await this.memberships.requireAccess(principal.userId, input.workspaceId)

    const allowed = authorize({ userId: principal.userId, role: access.role }, 'content.edit')
    if (!allowed.allowed) {
      throw errors.forbidden('Your role does not permit rescheduling.', { required: 'content.edit' })
    }

    const when = new Date(input.scheduledAt)

    return withTenant(input.workspaceId, async (tx) => {
      const post = await tx.post.findUnique({
        where: { id },
        select: { id: true, status: true },
      })
      if (!post) throw errors.notFound('post')

      // A published post cannot be moved — the thing it refers to already
      // exists on the network, and pretending otherwise would make the calendar
      // lie about reality.
      if (post.status === 'PUBLISHED' || post.status === 'PARTIALLY_PUBLISHED') {
        throw errors.unprocessable(
          'already_published',
          'This post has already gone out, so it cannot be rescheduled.'
        )
      }

      await tx.post.update({
        where: { id },
        data: { scheduledAt: when, status: 'SCHEDULED' },
      })
      // Variants follow the post, but only those not already terminal — a
      // failed channel should not silently become scheduled again.
      await tx.postVariant.updateMany({
        where: { postId: id, status: { in: ['DRAFT', 'SCHEDULED', 'QUEUED', 'MISSED'] } },
        data: { status: 'SCHEDULED' },
      })

      return { id, scheduledAt: when.toISOString() }
    })
  }
}
