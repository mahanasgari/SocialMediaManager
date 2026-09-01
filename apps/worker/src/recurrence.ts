import { occurrencesBetween, type RecurrenceRule } from '@smm/content'
import { withScheduler, withTenant } from '@smm/database'
import { log } from '@smm/observability'

/**
 * Materialising recurring schedules into real scheduled posts.
 *
 * A rule is not a post. Nothing publishes a rule — the scanner only ever sees
 * `Post` rows with a `scheduledAt`, and that is deliberate: it means recurrence
 * adds one job to the system and changes nothing about publishing, retries,
 * reconciliation or the calendar. A generated post is an ordinary post that
 * happens to remember where it came from.
 *
 * The consequence people actually feel is that a generated post can be EDITED.
 * Change the wording of next Tuesday's copy, or drag it an hour later, and it
 * stays changed — because it is a real row, not a projection recomputed on
 * every read. Expansion only ever fills gaps.
 *
 * A ROLLING HORIZON rather than expanding a rule to its end. "Every weekday at
 * 09:00" with no end date is infinite, and even a bounded rule running for two
 * years is seven hundred rows nobody has looked at. Sixty days is far enough
 * ahead that the calendar looks populated and near enough that editing the rule
 * does not orphan a year of stale copies.
 */

/** How far ahead to materialise. The plan's figure, and it reads well on a calendar. */
const HORIZON_DAYS = 60

/** Rules per pass. Expansion must never own the tick. */
const BATCH = 25

/** Occurrences per rule per pass, as a guard against an absurd rule. */
const MAX_PER_RULE = 200

export type ExpansionResult = {
  rules: number
  created: number
  /** Occurrences already covered by an existing post. The steady state. */
  skipped: number
  failed: number
}

const expansionLog = log.child({ service: 'worker', job: 'recurrence' })

export async function expandRecurrences(now: Date = new Date()): Promise<ExpansionResult> {
  const result: ExpansionResult = { rules: 0, created: 0, skipped: 0, failed: 0 }
  const horizon = new Date(now.getTime() + HORIZON_DAYS * 86_400_000)

  // Cross-workspace by definition — one worker serves every tenant, and a
  // schedule does not know it is waiting. Discovery only: everything that
  // writes a post below runs under withTenant().
  const due = await withScheduler(async (tx) =>
    tx.recurrence.findMany({
      where: {
        active: true,
        deletedAt: null,
        // Already materialised past the horizon: nothing to do until time moves.
        OR: [{ expandedUntil: null }, { expandedUntil: { lt: horizon } }],
      },
      orderBy: [{ expandedUntil: { sort: 'asc', nulls: 'first' } }, { createdAt: 'asc' }],
      take: BATCH,
      select: {
        id: true,
        workspaceId: true,
        organizationId: true,
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
        createdById: true,
        expandedUntil: true,
      },
    })
  )

  result.rules = due.length

  for (const rule of due) {
    try {
      const outcome = await expandOne(rule, now, horizon)
      result.created += outcome.created
      result.skipped += outcome.skipped
    } catch (err) {
      // One bad rule must not stop the rest. A rule naming a zone that no longer
      // exists in the tz database, say, throws in Intl and would otherwise take
      // every other schedule down with it.
      result.failed += 1
      expansionLog.error('a schedule could not be expanded', {
        recurrenceId: rule.id,
        name: rule.name,
        err,
      })
    }
  }

  return result
}

type DueRule = {
  id: string
  workspaceId: string
  organizationId: string
  name: string
  freq: string
  interval: number
  byWeekday: number[]
  byMonthDay: number | null
  hour: number
  minute: number
  timezone: string
  startsOn: string
  endsOn: string | null
  content: string
  accountIds: string[]
  createdById: string | null
  expandedUntil: Date | null
}

async function expandOne(
  rule: DueRule,
  now: Date,
  horizon: Date
): Promise<{ created: number; skipped: number }> {
  // From where the last pass finished, never from now.
  //
  // Starting at `now` every time would skip an occurrence that fell between two
  // ticks — thirty seconds is enough on a rule that fires on the minute. The
  // window is half-open and picks up exactly where the previous one ended, so
  // consecutive passes neither repeat nor lose anything.
  //
  // Clamped to `now` on first expansion so a rule created today does not
  // back-fill last month, and clamped forward if the worker has been down long
  // enough that the saved position is stale: a post whose time has passed
  // should be MISSED by the scanner, not created retroactively into the past.
  const from = rule.expandedUntil && rule.expandedUntil > now ? rule.expandedUntil : now

  const spec: RecurrenceRule = {
    freq: rule.freq as RecurrenceRule['freq'],
    interval: rule.interval,
    byWeekday: rule.byWeekday as RecurrenceRule['byWeekday'],
    ...(rule.byMonthDay !== null ? { byMonthDay: rule.byMonthDay } : {}),
    hour: rule.hour,
    minute: rule.minute,
    timezone: rule.timezone,
    startsOn: rule.startsOn,
    ...(rule.endsOn ? { endsOn: rule.endsOn } : {}),
  }

  const occurrences = occurrencesBetween(spec, from, horizon, MAX_PER_RULE)

  let created = 0
  let skipped = 0

  for (const occurrenceAt of occurrences) {
    const made = await createOccurrence(rule, occurrenceAt)
    if (made) created += 1
    else skipped += 1
  }

  // Recorded AFTER the posts, so a crash mid-expansion re-runs the window
  // rather than skipping it. Re-running is free — the unique index turns every
  // already-created occurrence into a skip — whereas skipping loses posts
  // silently, which is the failure nobody notices until the day they were due.
  await withScheduler(async (tx) => {
    await tx.recurrence.update({ where: { id: rule.id }, data: { expandedUntil: horizon } })
  })

  return { created, skipped }
}

/**
 * Creates one scheduled post for an occurrence, or reports that it exists.
 *
 * Idempotency is enforced by the database, not by checking first. A check-then-
 * insert is a race between two workers, and this runs on every tick in a system
 * that may have several — so the unique index on (recurrenceId, occurrenceAt)
 * is what actually guarantees one post per occurrence. A collision here is the
 * normal steady state, not an error.
 */
async function createOccurrence(rule: DueRule, occurrenceAt: Date): Promise<boolean> {
  try {
    await withTenant(rule.workspaceId, async (tx) => {
      // Accounts are re-read at expansion rather than trusted from the rule.
      // One may have been disconnected since the schedule was written, and a
      // variant pointing at a dead account fails at publish time — weeks later,
      // for a post nobody has looked at.
      const accounts = await tx.socialAccount.findMany({
        where: { id: { in: rule.accountIds }, status: 'ACTIVE', deletedAt: null },
        select: { id: true, surfaces: true },
      })

      const post = await tx.post.create({
        data: {
          organizationId: rule.organizationId,
          authorId: rule.createdById,
          baseContent: rule.content,
          status: 'SCHEDULED',
          scheduledAt: occurrenceAt,
          // The zone the author chose, kept so the calendar can render the time
          // back in the terms they meant rather than in the viewer's zone.
          timezone: rule.timezone,
          recurrenceId: rule.id,
          occurrenceAt,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
        select: { id: true },
      })

      for (const account of accounts) {
        await tx.postVariant.create({
          data: {
            organizationId: rule.organizationId,
            postId: post.id,
            socialAccountId: account.id,
            surface: account.surfaces[0] ?? 'feed',
            status: 'SCHEDULED',
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } as any,
        })
      }
    })

    return true
  } catch (err) {
    // P2002 is the unique index doing its job: this occurrence already has a
    // post. Every other error is real and belongs to the caller.
    if ((err as { code?: string })?.code === 'P2002') return false
    throw err
  }
}
