import { withReconciler } from '@smm/database'
import type { Publisher } from '@smm/publishing'
import { interruptedPublishes, recoveryOutcomes } from '@smm/observability'

/**
 * Recovering publishes that a dead process left in flight.
 *
 * This is the gap between what the pipeline handles and what actually happens
 * in production. The pipeline reconciles when a provider call RETURNS an
 * error — it is holding the attempt, it knows the outcome is ambiguous, and it
 * decides. But a process that is SIGKILLed mid-call returns nothing and decides
 * nothing. It leaves a committed IN_FLIGHT row, a variant sitting in
 * PUBLISHING, and a post that may or may not be visible to the public.
 *
 * Without this sweep that variant stays PUBLISHING forever. Nothing errors,
 * nothing retries, nothing alerts. Someone notices days later that a post never
 * went out — or worse, notices that it did, twice, because they retried it by
 * hand.
 *
 * The pod being OOM-killed, the node being drained, the deploy rolling, the
 * laptop closing: these are not edge cases, they are Tuesday. A publishing
 * system without crash recovery is a publishing system that silently loses
 * posts every time it restarts at the wrong moment.
 */

/**
 * How long an attempt may sit IN_FLIGHT before the sweep considers it.
 *
 * This is NOT the safety mechanism, and reading it as one is the mistake worth
 * warning about. The account lease is what makes reconciliation safe: the sweep
 * skips any account whose lease is still held, so a slow-but-alive publish is
 * never touched no matter how long it takes. The threshold only decides how
 * eagerly we look, and it exceeds the two-minute lease so that in the ordinary
 * case the lease has already lapsed by the time we do.
 */
const STALE_AFTER_MS = 5 * 60_000

/** No more than this many per sweep — recovery must not starve live publishing. */
const BATCH = 25

export type RecoveryResult = {
  found: number
  republishAvoided: number
  requeued: number
  needsReview: number
  skipped: number
}

export async function recoverInterrupted(
  publisher: Publisher,
  now: Date = new Date()
): Promise<RecoveryResult> {
  const cutoff = new Date(now.getTime() - STALE_AFTER_MS)

  // Cross-workspace by definition: one worker serves the whole deployment, and
  // a crash does not respect tenant boundaries. Discovery only — every decision
  // below runs under withTenant() through the same code the live publisher uses.
  const stale = await withReconciler(async (tx) => {
    return tx.publishAttempt.findMany({
      where: { status: 'IN_FLIGHT', startedAt: { lt: cutoff } },
      // Oldest first. An attempt that has been ambiguous for an hour is more
      // urgent than one ambiguous for six minutes, and on a bounded batch the
      // ordering decides who waits another sweep.
      orderBy: { startedAt: 'asc' },
      take: BATCH,
      select: {
        id: true,
        workspaceId: true,
        postVariantId: true,
        idempotencyKey: true,
        startedAt: true,
      },
    })
  })

  // A gauge, not a counter: this is a level that should return to zero, and
  // the alert worth writing is "still above zero after two sweeps" rather than
  // "ever above zero", which is normal.
  interruptedPublishes.set(stale.length)

  const result: RecoveryResult = {
    found: stale.length,
    republishAvoided: 0,
    requeued: 0,
    needsReview: 0,
    skipped: 0,
  }

  for (const attempt of stale) {
    try {
      const status = await publisher.reconcileInterrupted(
        attempt.workspaceId,
        attempt.postVariantId,
        { idempotencyKey: attempt.idempotencyKey, startedAt: attempt.startedAt }
      )

      if (status === null || status === 'PUBLISHING') {
        result.skipped += 1
        recoveryOutcomes.inc({ outcome: 'deferred' })
      } else if (status === 'PUBLISHED') {
        result.republishAvoided += 1
        // The one worth alerting on. Every increment here is a post that was
        // already live and would have been sent twice by a blind retry.
        recoveryOutcomes.inc({ outcome: 'reconciled' })
      } else if (status === 'QUEUED') {
        result.requeued += 1
        recoveryOutcomes.inc({ outcome: 'requeued' })
      } else if (status === 'NEEDS_REVIEW') {
        result.needsReview += 1
        recoveryOutcomes.inc({ outcome: 'needs_review' })
      }
    } catch (err) {
      // One unrecoverable attempt must not stop the sweep. It stays IN_FLIGHT
      // and the next pass tries again, which is the correct outcome: an
      // unanswered question is better left unanswered than answered wrongly.
      result.skipped += 1
      recoveryOutcomes.inc({ outcome: 'error' })
      console.error(
        `recovery: variant ${attempt.postVariantId} could not be reconciled:`,
        err instanceof Error ? err.message : err
      )
    }
  }

  return result
}
