import { loadEnv } from '@smm/config'
import { outbox, withScheduler } from '@smm/database'

/**
 * The scheduler scanner.
 *
 * POSTGRES IS THE SOURCE OF TRUTH; Redis is only transport. Every 30 seconds
 * this sweeps variants whose time has come and hands them to the publisher.
 *
 * The tempting alternative — enqueue a BullMQ delayed job at schedule time —
 * makes Redis the system of record for the content calendar. An eviction, a
 * flush, or a version migration then loses scheduled posts silently, and every
 * edit or reschedule requires job surgery racing a job already moving to active.
 * A sweep costs one indexed query per tick and survives Redis being wiped.
 */

export type DueVariant = {
  id: string
  workspaceId: string
  scheduledAt: Date
  postId: string
}

export type ScanResult = {
  claimed: DueVariant[]
  missed: DueVariant[]
  /** More were due than one tick can take — surfaced, never silently absorbed. */
  backlog: boolean
}

const BATCH = 50

export class ClockWentBackwards extends Error {
  override readonly name = 'ClockWentBackwards'
  constructor(driftMs: number) {
    super(
      `System time moved backwards by ${driftMs}ms since the last tick. Refusing to claim ` +
        `work: re-claiming already-published rows is a duplicate-publish path that the ` +
        `idempotency design does not cover, because it reasons about retries rather than ` +
        `about time travel.`
    )
  }
}

export class Scanner {
  private lastTickAt: number | null = null

  /**
   * Claims due variants.
   *
   * `FOR UPDATE SKIP LOCKED` lets several workers scan concurrently without
   * contending for the same rows and without one blocking another — the same
   * strategy the outbox dispatcher uses.
   */
  async claim(now: Date = new Date()): Promise<ScanResult> {
    this.guardClock(now)

    const catchUpMs = loadEnv().CATCHUP_WINDOW_MINUTES * 60_000
    const cutoff = new Date(now.getTime() - catchUpMs)

    return withScheduler(async (tx) => {
      const rows = await tx.$queryRaw<
        Array<{ id: string; workspaceId: string; scheduledAt: Date; postId: string }>
      >`
        SELECT v."id", v."workspaceId", p."scheduledAt", v."postId"
        FROM "PostVariant" v
        JOIN "Post" p ON p."id" = v."postId"
        WHERE v."status" IN ('SCHEDULED', 'QUEUED')
          AND p."scheduledAt" IS NOT NULL
          AND p."scheduledAt" <= ${now}
          AND p."deletedAt" IS NULL
        ORDER BY p."scheduledAt" ASC
        LIMIT ${BATCH + 1}
        FOR UPDATE OF v SKIP LOCKED
      `

      const backlog = rows.length > BATCH
      const batch = rows.slice(0, BATCH)

      const claimed: DueVariant[] = []
      const missed: DueVariant[] = []

      for (const row of batch) {
        // Oldest first, so recovery from downtime drains in the order things
        // were meant to go out rather than in whatever order the index returns.
        if (row.scheduledAt < cutoff) missed.push(row)
        else claimed.push(row)
      }

      if (missed.length > 0) await this.markMissed(tx, missed)
      if (claimed.length > 0) await this.markQueued(tx, claimed)

      return { claimed, missed, backlog }
    })
  }

  /**
   * Refuses to run if the clock jumped backwards.
   *
   * NTP corrections are routine on self-hosted machines. A backwards jump would
   * re-claim rows that already published — and that path sits entirely outside
   * the idempotency design, which reasons about retries, not about time moving.
   */
  private guardClock(now: Date): void {
    const current = now.getTime()
    if (this.lastTickAt !== null) {
      const drift = this.lastTickAt - current
      if (drift > 5_000) throw new ClockWentBackwards(drift)
    }
    this.lastTickAt = current
  }

  /**
   * Overdue beyond the catch-up window.
   *
   * NOT published. Publishing four hours of backdated content in one burst is
   * the worst available outcome: it dumps stale posts on a live audience at
   * once, at maximum rate against providers we have just budgeted for. The
   * correct choice — publish now, or reschedule — is editorial, so it waits for
   * a human.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async markMissed(tx: any, variants: DueVariant[]): Promise<void> {
    await tx.postVariant.updateMany({
      where: { id: { in: variants.map((v) => v.id) } },
      data: {
        status: 'MISSED',
        lastError:
          'This missed its scheduled time by more than the catch-up window, so it was not ' +
          'published automatically. Publish it now or reschedule it.',
        lastErrorCode: 'MISSED',
      },
    })

    // Emitted in the SAME transaction as the status change, so a post cannot be
    // marked MISSED without the notification that says so also being durable.
    //
    // This is the event that most needs to arrive. MISSED is terminal and
    // deliberately never auto-retried — the correct action is editorial — so if
    // nobody is told, a post simply does not go out and nothing anywhere says
    // why. One event per variant rather than one per batch: a subscriber wants
    // to know which post, not that some number of them were missed.
    for (const variant of variants) {
      await outbox.emit(tx, {
        aggregateType: 'PostVariant',
        aggregateId: variant.id,
        eventType: 'post.missed',
        workspaceId: variant.workspaceId,
        payload: { variantId: variant.id, scheduledAt: variant.scheduledAt.toISOString() },
      })
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async markQueued(tx: any, variants: DueVariant[]): Promise<void> {
    await tx.postVariant.updateMany({
      where: { id: { in: variants.map((v) => v.id) }, status: 'SCHEDULED' },
      data: { status: 'QUEUED' },
    })
  }

  /** Lateness measured against the intended time, not against the claim. */
  static lateness(scheduledAt: Date, publishedAt: Date): number {
    return Math.max(0, Math.round((publishedAt.getTime() - scheduledAt.getTime()) / 1000))
  }

  /**
   * Whether lateness is worth REPORTING, as opposed to merely recording.
   *
   * These are different questions and conflating them makes the answer useless.
   * A polling scanner can never publish at the exact scheduled second: a post
   * due at 09:00:05 is claimed on the 09:00:30 tick and is "late" by 25
   * seconds — every single time. Flagging that would set publishedLate on
   * essentially every post, and a report where the number is always 100% tells
   * an operator nothing.
   *
   * So `latenessSeconds` is always recorded — it is the real measurement — and
   * `publishedLate` is reserved for delay beyond what the tick rate explains.
   * The tolerance is two ticks: one for the wait, one for a tick spent behind a
   * batch, which is normal operation rather than a problem.
   */
  static readonly LATENESS_TOLERANCE_SECONDS = 60

  static isNotablyLate(seconds: number): boolean {
    return seconds > Scanner.LATENESS_TOLERANCE_SECONDS
  }
}
