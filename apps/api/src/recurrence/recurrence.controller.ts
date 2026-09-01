import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import { withTenant } from '@smm/database'
import { describeRule, nextOccurrences, type RecurrenceRule } from '@smm/content'
import { z } from 'zod'
import { errors } from '../common/errors.js'
import { Caller, resolveAccess, resolveRead, type Principal } from '../auth/principal.js'
import { MembershipService } from '../tenancy/membership.service.js'

/**
 * Recurring schedules.
 *
 * A rule here produces nothing on its own — the worker materialises it into
 * ordinary scheduled posts on a rolling sixty-day horizon. That separation is
 * what keeps recurrence from touching publishing at all: the scanner never
 * learns a rule exists.
 *
 * The preview endpoint matters more than it looks. A recurrence rule is a small
 * program somebody writes in a form, and the only honest way to show what it
 * means is to run it. "Every 2 weeks on Monday and Thursday" is easy to get
 * wrong in ways nobody notices until the wrong week.
 */

const DATE = /^\d{4}-\d{2}-\d{2}$/

const ruleShape = {
  freq: z.enum(['DAILY', 'WEEKLY', 'MONTHLY']),
  interval: z.number().int().min(1).max(52).default(1),
  byWeekday: z.array(z.number().int().min(0).max(6)).max(7).default([]),
  // -1 means the last day of the month, which every month has. 1-31 otherwise,
  // and a day the month lacks is skipped rather than clamped.
  byMonthDay: z.number().int().min(-1).max(31).optional(),
  hour: z.number().int().min(0).max(23),
  minute: z.number().int().min(0).max(59),
  timezone: z.string().min(1).max(64),
  startsOn: z.string().regex(DATE, 'Use YYYY-MM-DD.'),
  endsOn: z.string().regex(DATE, 'Use YYYY-MM-DD.').optional(),
}

const createSchema = z.object({
  workspaceId: z.string().uuid(),
  name: z.string().min(1).max(120),
  content: z.string().min(1).max(20_000),
  accountIds: z.array(z.string().uuid()).min(1, 'Choose at least one account to post to.'),
  ...ruleShape,
})

const previewSchema = z.object({
  workspaceId: z.string().uuid(),
  count: z.number().int().min(1).max(20).default(5),
  ...ruleShape,
})

/**
 * Generic over the SCHEMA, not over one type parameter.
 *
 * `z.ZodType<T>` fixes input and output to the same T, and these schemas use
 * `.default()` — so the two genuinely differ, and the shared form of this
 * helper collapses them into an input type where every defaulted field is still
 * optional. `z.output<S>` asks for what parsing actually returns.
 */
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
 * Refuses a zone the platform does not know.
 *
 * Checked here rather than left to the worker, because a bad zone throws inside
 * Intl at expansion time — in a background job, hours later, where the only
 * symptom is a schedule that quietly produces nothing.
 */
function assertZone(timezone: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone })
  } catch {
    throw errors.validation(
      `"${timezone}" is not a time zone this system recognises. Use an IANA name like Europe/Berlin.`,
      'timezone'
    )
  }
}

/**
 * Just the rule fields, shared by create, preview and list.
 *
 * Named separately from any one schema so `toRule` accepts all three. Typing it
 * against the preview schema pulled `count` in as required, which is a property
 * of the request rather than of the rule.
 */
type RuleInput = {
  freq: RecurrenceRule['freq']
  interval: number
  byWeekday: number[]
  byMonthDay?: number | undefined
  hour: number
  minute: number
  timezone: string
  startsOn: string
  endsOn?: string | undefined
}

function toRule(input: RuleInput): RecurrenceRule {
  return {
    freq: input.freq,
    interval: input.interval,
    byWeekday: input.byWeekday as RecurrenceRule['byWeekday'],
    ...(input.byMonthDay !== undefined ? { byMonthDay: input.byMonthDay } : {}),
    hour: input.hour,
    minute: input.minute,
    timezone: input.timezone,
    startsOn: input.startsOn,
    ...(input.endsOn ? { endsOn: input.endsOn } : {}),
  }
}

@ApiTags('recurrence')
@Controller('recurrences')
export class RecurrenceController {
  constructor(private readonly memberships: MembershipService) {}

  @Get()
  @ApiOperation({ summary: 'Recurring schedules in a workspace' })
  async list(@Query('workspaceId') workspaceId: string, @Caller() principal: Principal | undefined) {
    if (!workspaceId) throw errors.validation('workspaceId is required.', 'workspaceId')
    await resolveRead(principal, workspaceId, 'posts:read', (u, w) =>
      this.memberships.requireAccess(u, w)
    )

    return withTenant(workspaceId, async (tx) => {
      const rows = await tx.recurrence.findMany({
        where: { deletedAt: null },
        orderBy: [{ active: 'desc' }, { createdAt: 'desc' }],
        select: {
          id: true,
          name: true,
          freq: true,
          interval: true,
          byWeekday: true,
          byMonthDay: true,
          hour: true,
          minute: true,
          timezone: true,
          startsOn: true,
          endsOn: true,
          content: true,
          accountIds: true,
          active: true,
          expandedUntil: true,
          _count: { select: { posts: true } },
        },
      })

      const now = new Date()
      return rows.map(({ _count, ...rule }) => ({
        ...rule,
        postCount: _count.posts,
        // Computed rather than stored. A stored summary goes stale the moment
        // somebody edits the rule, and a description that disagrees with the
        // schedule is worse than none.
        summary: describeRule(toRule({ ...rule, endsOn: rule.endsOn ?? undefined } as never)),
        // Only for an active rule: showing "next: Tuesday" under a paused
        // schedule says something untrue.
        nextRuns: rule.active
          ? nextOccurrences(toRule({ ...rule, endsOn: rule.endsOn ?? undefined } as never), now, 3)
          : [],
      }))
    })
  }

  /**
   * What a rule would actually do, without saving it.
   *
   * Pure — it reads nothing and writes nothing — so it needs only read access
   * and cannot be used to probe a workspace it is scoped to anyway.
   */
  @Post('preview')
  @ApiOperation({ summary: 'The next few occurrences a rule would produce' })
  async preview(@Body() body: unknown, @Caller() principal: Principal | undefined) {
    const input = parse(previewSchema, body)
    await resolveRead(principal, input.workspaceId, 'posts:read', (u, w) =>
      this.memberships.requireAccess(u, w)
    )
    assertZone(input.timezone)

    const rule = toRule(input)
    const occurrences = nextOccurrences(rule, new Date(), input.count)

    return {
      summary: describeRule(rule),
      occurrences: occurrences.map((d) => d.toISOString()),
      // An empty result is a legitimate answer — a rule whose end date has
      // passed, or a monthly rule on the 31st with no such day ahead — and the
      // UI has to say so rather than showing an empty list that reads as a
      // loading state.
      note:
        occurrences.length === 0
          ? 'This rule produces no posts in the next year. Check the dates and the day of the month.'
          : null,
    }
  }

  @Post()
  @ApiOperation({ summary: 'Create a recurring schedule' })
  async create(@Body() body: unknown, @Caller() principal: Principal | undefined) {
    const input = parse(createSchema, body)
    await resolveAccess(principal, input.workspaceId, 'content.create', (u, w) =>
      this.memberships.requireAccess(u, w)
    )
    assertZone(input.timezone)

    if (input.endsOn && input.endsOn < input.startsOn) {
      throw errors.validation('The end date cannot be before the start date.', 'endsOn')
    }

    return withTenant(input.workspaceId, async (tx) => {
      // The accounts are checked against THIS workspace. Without it a caller
      // could name another tenant's account id, and expansion would then create
      // variants pointing at it — a cross-tenant write reached through a rule.
      const accounts = await tx.socialAccount.findMany({
        where: { id: { in: input.accountIds }, deletedAt: null },
        select: { id: true },
      })
      if (accounts.length !== input.accountIds.length) {
        throw errors.validation(
          'One or more of those accounts do not exist in this workspace.',
          'accountIds'
        )
      }

      const created = await tx.recurrence.create({
        data: {
          name: input.name,
          content: input.content,
          accountIds: accounts.map((a) => a.id),
          freq: input.freq,
          interval: input.interval,
          byWeekday: input.byWeekday,
          ...(input.byMonthDay !== undefined ? { byMonthDay: input.byMonthDay } : {}),
          hour: input.hour,
          minute: input.minute,
          timezone: input.timezone,
          startsOn: input.startsOn,
          ...(input.endsOn ? { endsOn: input.endsOn } : {}),
          ...(principal?.kind === 'user' ? { createdById: principal.userId } : {}),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
        select: { id: true, name: true, active: true },
      })

      return {
        ...created,
        summary: describeRule(toRule(input)),
        // Said plainly, because nothing appears on the calendar for up to a
        // tick and the absence otherwise reads as a failure.
        note: 'Posts appear on the calendar within a minute, as the worker fills the schedule.',
      }
    })
  }

  /**
   * Pausing, renaming, or changing the rule.
   *
   * Changing the pattern deliberately does NOT delete the posts already
   * generated. They are real rows on somebody's calendar, possibly edited by
   * hand, and silently removing them because a rule changed is destroying work
   * nobody asked to lose. Future occurrences follow the new rule; existing
   * posts are the author's to keep or delete.
   */
  @Patch(':id')
  @ApiOperation({ summary: 'Update or pause a schedule' })
  async update(
    @Param('id') id: string,
    @Body() body: unknown,
    @Caller() principal: Principal | undefined
  ) {
    const input = parse(
      z.object({
        workspaceId: z.string().uuid(),
        name: z.string().min(1).max(120).optional(),
        content: z.string().min(1).max(20_000).optional(),
        active: z.boolean().optional(),
      }),
      body
    )
    await resolveAccess(principal, input.workspaceId, 'content.edit', (u, w) =>
      this.memberships.requireAccess(u, w)
    )

    return withTenant(input.workspaceId, async (tx) => {
      const existing = await tx.recurrence.findUnique({ where: { id }, select: { id: true } })
      if (!existing) throw errors.notFound('That schedule does not exist.')

      return tx.recurrence.update({
        where: { id },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.content !== undefined ? { content: input.content } : {}),
          ...(input.active !== undefined ? { active: input.active } : {}),
        },
        select: { id: true, name: true, active: true },
      })
    })
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a schedule, keeping the posts it made' })
  async remove(
    @Param('id') id: string,
    @Query('workspaceId') workspaceId: string,
    @Query('futurePosts') futurePosts: string | undefined,
    @Caller() principal: Principal | undefined
  ) {
    if (!workspaceId) throw errors.validation('workspaceId is required.', 'workspaceId')
    await resolveAccess(principal, workspaceId, 'content.delete', (u, w) =>
      this.memberships.requireAccess(u, w)
    )

    return withTenant(workspaceId, async (tx) => {
      const rule = await tx.recurrence.findUnique({ where: { id }, select: { id: true } })
      if (!rule) throw errors.notFound('That schedule does not exist.')

      // Removing the unpublished posts is OPT-IN and never the default. Most
      // people deleting a schedule mean "stop making new ones", and discovering
      // that it also erased next month's calendar is not a recoverable
      // surprise. Published posts are never touched at all.
      let removed = 0
      if (futurePosts === 'delete') {
        const result = await tx.post.deleteMany({
          where: { recurrenceId: id, status: { in: ['DRAFT', 'SCHEDULED'] } },
        })
        removed = result.count
      }

      await tx.recurrence.delete({ where: { id } })
      return { deleted: true, futurePostsRemoved: removed }
    })
  }
}
