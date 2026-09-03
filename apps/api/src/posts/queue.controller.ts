import { Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import { withTenant, type Db } from '@smm/database'
import { SUGGESTED_SLOTS, nextFreeSlots, type Slot } from '@smm/content'
import { z } from 'zod'
import { CurrentUser } from '../auth/current-user.js'
import type { SessionPrincipal } from '../auth/session.service.js'
import { errors } from '../common/errors.js'
import { MembershipService } from '../tenancy/membership.service.js'

const slotSchema = z.object({
  workspaceId: z.string().uuid(),
  dayOfWeek: z.number().int().min(0).max(6),
  hour: z.number().int().min(0).max(23),
  minute: z.number().int().min(0).max(59),
})

function parse<S extends z.ZodTypeAny>(schema: S, body: unknown): z.output<S> {
  const result = schema.safeParse(body)
  if (result.success) return result.data
  const issue = result.error.issues[0]
  throw errors.validation(
    issue ? `${issue.path.join('.') || 'body'}: ${issue.message}` : 'The request body is invalid.',
    issue?.path.join('.')
  )
}

/**
 * The posting queue.
 *
 * A workspace says WHEN it posts and new posts take the next free one. The
 * alternative — picking a datetime for every post — is the thing anyone posting
 * on a rhythm does forty times a week and resents by the tenth.
 *
 * Slots are a wall-clock day and time in the workspace's own zone, never
 * instants. See packages/content/src/queue.ts for why that distinction is the
 * whole design rather than a detail.
 */
@ApiTags('posts')
@Controller('posting-slots')
export class QueueController {
  constructor(private readonly memberships: MembershipService) {}

  /** How far ahead the preview looks. Enough to see the rhythm, not a calendar. */
  private static readonly PREVIEW = 5

  @Get()
  @ApiOperation({ summary: 'The workspace posting queue, and the next times it will use' })
  async list(
    @Query('workspaceId') workspaceId: string,
    @CurrentUser() principal: SessionPrincipal | undefined
  ) {
    const access = await this.access(principal, workspaceId)

    return withTenant(workspaceId, async (tx) => {
      const [slots, workspace] = await Promise.all([
        tx.postingSlot.findMany({
          orderBy: [{ dayOfWeek: 'asc' }, { hour: 'asc' }, { minute: 'asc' }],
          select: { id: true, dayOfWeek: true, hour: true, minute: true },
        }),
        tx.workspace.findUniqueOrThrow({
          where: { id: workspaceId },
          select: { timezone: true },
        }),
      ])

      return {
        timezone: workspace.timezone,
        slots,
        // What the next few posts would actually get. A list of "Tue 09:00"
        // rows does not answer "so when does my next post go out?", and that is
        // the only question anyone has when looking at this screen.
        upcoming: (await this.upcoming(tx, workspaceId, slots, workspace.timezone)).map((d) =>
          d.toISOString()
        ),
        canManage: access.role !== 'VIEWER' && access.role !== 'CLIENT',
        suggested: SUGGESTED_SLOTS,
      }
    })
  }

  @Get('next')
  @ApiOperation({ summary: 'The next free slot instant, for queueing a post' })
  async next(
    @Query('workspaceId') workspaceId: string,
    @Query('count') count: string | undefined,
    @CurrentUser() principal: SessionPrincipal | undefined
  ) {
    await this.access(principal, workspaceId)
    const wanted = Math.min(Math.max(Number(count ?? 1) || 1, 1), 20)

    return withTenant(workspaceId, async (tx) => {
      const [slots, workspace] = await Promise.all([
        tx.postingSlot.findMany({ select: { dayOfWeek: true, hour: true, minute: true } }),
        tx.workspace.findUniqueOrThrow({
          where: { id: workspaceId },
          select: { timezone: true },
        }),
      ])

      if (slots.length === 0) {
        // An empty queue is a state, not a failure. The composer offers to set
        // one up rather than reporting an error for something nobody has done
        // yet.
        return { slots: [], empty: true, timezone: workspace.timezone }
      }

      const found = await this.upcoming(tx, workspaceId, slots, workspace.timezone, wanted)
      return {
        slots: found.map((d) => d.toISOString()),
        empty: false,
        // True when the queue could not supply as many as asked for within the
        // horizon — more queued posts than slots. Saying so beats scheduling
        // some and silently dropping the rest.
        exhausted: found.length < wanted,
        timezone: workspace.timezone,
      }
    })
  }

  @Post()
  @ApiOperation({ summary: 'Add a time to the queue' })
  async create(@Body() body: unknown, @CurrentUser() principal: SessionPrincipal | undefined) {
    const input = parse(slotSchema, body)
    const access = await this.access(principal, input.workspaceId)
    this.requireManage(access.role)

    return withTenant(input.workspaceId, async (tx) => {
      const existing = await tx.postingSlot.findFirst({
        where: { dayOfWeek: input.dayOfWeek, hour: input.hour, minute: input.minute },
        select: { id: true },
      })
      if (existing) {
        // Two slots at one moment would hand the same instant to two posts.
        // The database refuses it as well; this is the readable version.
        throw errors.validation('That time is already in the queue.', 'hour')
      }

      return tx.postingSlot.create({
        data: {
          workspaceId: input.workspaceId,
          organizationId: access.organizationId,
          dayOfWeek: input.dayOfWeek,
          hour: input.hour,
          minute: input.minute,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
        select: { id: true, dayOfWeek: true, hour: true, minute: true },
      })
    })
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Remove a time from the queue' })
  async remove(
    @Param('id') id: string,
    @Query('workspaceId') workspaceId: string,
    @CurrentUser() principal: SessionPrincipal | undefined
  ) {
    const access = await this.access(principal, workspaceId)
    this.requireManage(access.role)

    await withTenant(workspaceId, async (tx) => {
      await tx.postingSlot.deleteMany({ where: { id } })
    })

    // Posts already scheduled into this slot keep their time. They are on the
    // calendar and somebody planned around them; removing a slot means "stop
    // using this in future", not "cancel what it produced".
    return { id, removed: true }
  }

  /**
   * The next free instants, skipping anything already scheduled.
   *
   * The "taken" set is read from the posts themselves rather than tracked
   * separately, so a post moved by hand on the calendar frees its slot without
   * anything having to notice.
   */
  private async upcoming(
    tx: Db,
    _workspaceId: string,
    slots: readonly Slot[],
    timezone: string,
    count = QueueController.PREVIEW
  ): Promise<Date[]> {
    if (slots.length === 0) return []

    const from = new Date()
    const horizon = new Date(from.getTime() + 130 * 86_400_000)

    const scheduled = await tx.post.findMany({
      where: {
        scheduledAt: { gte: from, lte: horizon },
        status: { in: ['SCHEDULED', 'PENDING_APPROVAL', 'APPROVED', 'DRAFT'] },
      },
      select: { scheduledAt: true },
    })

    return nextFreeSlots({
      slots,
      timezone,
      taken: scheduled.map((p) => p.scheduledAt).filter((d): d is Date => d !== null),
      from,
      count,
    })
  }

  private async access(principal: SessionPrincipal | undefined, workspaceId: string) {
    if (!principal) throw errors.unauthenticated()
    if (!workspaceId) throw errors.validation('workspaceId is required.', 'workspaceId')
    return this.memberships.requireAccess(principal.userId, workspaceId)
  }

  private requireManage(role: string): void {
    // Reading the queue is harmless; changing it moves everyone's posts.
    if (role === 'VIEWER' || role === 'CLIENT' || role === 'ANALYST') {
      throw errors.forbidden('You cannot change the posting queue.')
    }
  }
}
