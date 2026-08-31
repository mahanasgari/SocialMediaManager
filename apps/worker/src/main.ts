import { loadEnv } from '@smm/config'
import {
  log,
  oldestOverdueSeconds,
  overdueVariants,
  publishLateness,
  tickDuration,
  variantsAwaitingReview,
} from '@smm/observability'
import { db, withScheduler, withTenant } from '@smm/database'
import { Scanner, ClockWentBackwards } from './scanner.js'
import { publishVariant, activePublisher, closePublisher } from './publisher.js'
import { recoverInterrupted } from './recovery.js'
import { ingestMetrics } from './metrics.js'
import { dispatchWebhooks } from './webhooks.js'
import { ingestFeeds } from './rss.js'
import { dispatchInbound } from './inbox.js'
import { runRetention } from './retention.js'
import { runExports } from './exports.js'
import { startMetricsServer } from './metrics-server.js'

/**
 * The worker.
 *
 * A separate process from the API on purpose: a video upload can run for
 * minutes, and that must never occupy a request handler. It also lets the
 * publishing capacity scale independently of the web tier.
 */

const TICK_MS = 30_000

/**
 * Retention runs hourly, not every tick.
 *
 * It is the only job here that DELETES, and none of its deadlines are measured
 * in seconds — a purge due at 09:00 is equally correct at 09:59. Running it on
 * the publish tick would put a destructive sweep on the same schedule as the
 * most latency-sensitive work in the process, for no benefit.
 */
const RETENTION_INTERVAL_MS = 3600_000
let lastRetentionAt = 0

const scanner = new Scanner()
let running = true

/**
 * Every line this process writes carries `service: "worker"`.
 *
 * Worth the two characters because the API and the worker land in one stream
 * once anything aggregates them, and "which process logged this?" is the first
 * question asked of every line and the one plain text cannot answer.
 */
const workerLog = log.child({ service: 'worker' })

/**
 * Times one phase of the tick and never lets it take the tick down.
 *
 * The wrapper exists because the alternative — a try/catch and a stopwatch
 * repeated eight times — is eight chances to forget one, and the phase somebody
 * forgets is the phase that hangs.
 */
async function phase(name: string, run: () => Promise<void>): Promise<void> {
  const end = tickDuration.startTimer({ phase: name })
  try {
    await run()
  } catch (err) {
    workerLog.error(`${name} failed`, { err })
  } finally {
    end()
  }
}

/**
 * The gauges an operator alerts on.
 *
 * Read once per tick rather than derived from what the tick happened to do,
 * because the number that matters is a LEVEL — how many posts are overdue right
 * now — and a level cannot be reconstructed from a stream of events. A worker
 * that has stopped publishing entirely emits no events at all, which is exactly
 * when this needs to be right.
 */
async function readGauges(now: Date): Promise<void> {
  // Under the scheduler actor, because this is the SAME cross-cutting shape as
  // every sweep in this process: "how many posts are overdue across the whole
  // deployment" has no one workspace to scope by.
  //
  // Written first without it, and the tenancy guard threw immediately — which
  // is the design working. The alternative reading of that mistake is a gauge
  // that reports zero overdue posts forever while the scheduler is on fire.
  const [overdue, review, oldest] = await withScheduler(async (tx) =>
    Promise.all([
      tx.postVariant.count({
        where: { status: { in: ['SCHEDULED', 'QUEUED'] }, post: { scheduledAt: { lt: now } } },
      }),
      tx.postVariant.count({ where: { status: 'NEEDS_REVIEW' } }),
      tx.postVariant.findFirst({
        where: { status: { in: ['SCHEDULED', 'QUEUED'] }, post: { scheduledAt: { lt: now } } },
        orderBy: { post: { scheduledAt: 'asc' } },
        select: { post: { select: { scheduledAt: true } } },
      }),
    ])
  )

  overdueVariants.set(overdue)
  variantsAwaitingReview.set(review)
  oldestOverdueSeconds.set(
    oldest?.post.scheduledAt
      ? Math.round((now.getTime() - oldest.post.scheduledAt.getTime()) / 1000)
      : 0
  )
}

async function tick(): Promise<void> {
  // FIRST, before anything new is claimed.
  //
  // A publish that a dead process left in flight is a post that may already be
  // public and is definitely not accounted for. Starting new work while that is
  // unresolved is how a restart during a busy window turns into a duplicate:
  // the human watching a variant stuck in PUBLISHING retries it by hand.
  //
  // It is cheap on the passes where nothing crashed, which is nearly all of
  // them — one indexed query returning no rows.
  try {
    const recovered = await recoverInterrupted(activePublisher())
    if (recovered.found > 0) {
      workerLog.warn('interrupted publishes recovered', {
        found: recovered.found,
        alreadyLive: recovered.republishAvoided,
        requeued: recovered.requeued,
        awaitingHuman: recovered.needsReview,
        deferred: recovered.skipped,
      })
    }
  } catch (err) {
    workerLog.error('recovery sweep failed', { err })
  }

  let result
  try {
    result = await scanner.claim()
  } catch (err) {
    if (err instanceof ClockWentBackwards) {
      // Loud, and we skip the tick rather than risk re-claiming published rows.
      workerLog.error('clock went backwards; skipping this tick', { err })
      return
    }
    throw err
  }

  if (result.backlog) {
    // Silence during recovery is worse than a warning: somebody watching a
    // backlog drain needs to know it is draining.
    workerLog.warn('backlog: more posts are due than one tick can claim', {
      drainIntervalSeconds: TICK_MS / 1000,
    })
  }

  for (const variant of result.missed) {
    workerLog.warn('variant missed its window', { variantId: variant.id })
  }

  for (const variant of result.claimed) {
    try {
      const startedAt = Date.now()
      const status = await publishVariant(variant.workspaceId, variant.id)
      workerLog.info('variant settled', {
        variantId: variant.id,
        status,
        durationMs: Date.now() - startedAt,
      })


      if (status === 'PUBLISHED') {
        // latenessSeconds is always recorded; publishedLate only when the
        // delay exceeds what the tick rate itself explains. See
        // Scanner.isNotablyLate.
        const late = Scanner.lateness(variant.scheduledAt, new Date())
        // Observed for EVERY publish, including on-time ones. A histogram fed
        // only its outliers cannot say what normal looks like, which is the
        // question you actually have during an incident.
        publishLateness.observe(Math.max(0, late))
        if (late > 0) {
          await withTenant(variant.workspaceId, async (tx) => {
            await tx.postVariant.update({
              where: { id: variant.id },
              data: { publishedLate: Scanner.isNotablyLate(late), latenessSeconds: late },
            })
          })
        }
      }
    } catch (err) {
      // One variant failing must never stop the sweep — the other channels in
      // this batch have nothing to do with it.
      workerLog.error('variant threw', { variantId: variant.id, err })
    }
  }

  // Inbound dispatch runs BEFORE metrics and webhooks. A person waiting on a
  // reply is the most latency-sensitive thing in the tick, and turning stored
  // events into conversations is cheap — the expensive part already happened in
  // the receiver's 200ms budget.
  try {
    const inbox = await dispatchInbound()
    if (inbox.processed + inbox.failed > 0) {
      workerLog.info('inbound dispatched', {
        processed: inbox.processed,
        failed: inbox.failed,
        messages: inbox.messages,
      })
    }
  } catch (err) {
    workerLog.error('inbound dispatch failed', { err })
  }

  // Metrics ingestion shares the tick. It is cheap because the decaying schedule
  // means most passes find nothing due, and it competes for the same provider
  // quota as publishing — so it runs after, never before.
  try {
    const metrics = await ingestMetrics()
    if (metrics.collected > 0) {
      workerLog.info('metrics ingested', { collected: metrics.collected, skipped: metrics.skipped })
    }
  } catch (err) {
    workerLog.error('metrics ingestion failed', { err })
  }

  // Retention, hourly. Last because it is the least urgent thing in the tick
  // and the only one that deletes: if the process is struggling, publishing and
  // inbox delivery should get the time.
  if (Date.now() - lastRetentionAt >= RETENTION_INTERVAL_MS) {
    lastRetentionAt = Date.now()
    try {
      const reaped = await runRetention()
      const touched = Object.values(reaped).reduce((a, b) => a + b, 0)
      if (touched > 0) workerLog.info('retention swept', reaped)
    } catch (err) {
      workerLog.error('retention sweep failed', { err })
    }
  }

  // Exports, one job per tick. The least urgent work here and the most
  // expensive: a workspace export reads a year of history in one pass, so it
  // must never sit ahead of a scheduled post in the queue.
  try {
    const exported = await runExports()
    if (exported.built + exported.failed + exported.expired > 0) {
      workerLog.info('exports run', {
        built: exported.built,
        failed: exported.failed,
        expired: exported.expired,
      })
    }
  } catch (err) {
    workerLog.error('export run failed', { err })
  }

  // Outbound webhooks last: they are the least time-critical work in the tick,
  // and a slow customer endpoint must never delay a scheduled post.
  try {
    const hooks = await dispatchWebhooks()
    if (hooks.sent + hooks.failed > 0) {
      workerLog.info('webhooks dispatched', {
        sent: hooks.sent,
        failed: hooks.failed,
        disabled: hooks.disabled,
      })
    }
  } catch (err) {
    workerLog.error('webhook dispatch failed', { err })
  }

  // RSS is rate-limited internally to one fetch per feed per 15 minutes, so
  // running it every tick costs almost nothing on the passes where nothing is due.
  try {
    const feeds = await ingestFeeds()
    if (feeds.created > 0) {
      workerLog.info('rss ingested', { created: feeds.created, feeds: feeds.feeds })
    }
  } catch (err) {
    workerLog.error('rss ingestion failed', { err })
  }

  // Last, so the gauges describe the state the tick LEAVES behind rather than
  // the one it found. An operator reading "12 overdue" wants to know that 12
  // are still overdue after a pass, not that 12 were waiting before it ran.
  await phase('gauges', () => readGauges(new Date()))
}

async function main(): Promise<void> {
  loadEnv()
  const metricsServer = startMetricsServer()
  const metricsPort = Number(process.env['WORKER_METRICS_PORT'] ?? 9464)
  workerLog.info('worker started', { tickSeconds: TICK_MS / 1000, metricsPort })

  while (running) {
    const started = Date.now()
    try {
      await tick()
    } catch (err) {
      workerLog.error('tick failed', { err })
    }
    const elapsed = Date.now() - started
    await sleep(Math.max(0, TICK_MS - elapsed))
  }

  // Closed explicitly rather than left to unref(). A scrape arriving during
  // the drain would answer with numbers from a process that has stopped working,
  // which is the one moment those numbers are actively misleading.
  metricsServer.close()
  workerLog.info('worker stopped')
}

/**
 * An interruptible wait.
 *
 * A plain setTimeout would leave the process idling for up to a full tick after
 * SIGTERM before it noticed. An orchestrator SIGKILLs at 30 seconds, so a 30
 * second tick means a shutdown that is almost always a hard kill — even though
 * the worker had nothing to do and could have exited immediately.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms)
    wake = finish

    function finish() {
      clearTimeout(timer)
      wake = null
      resolve()
    }
  })
}

let wake: (() => void) | null = null

/**
 * The deadline that fires if a tick will not end.
 *
 * Held at module scope so a clean shutdown can CANCEL it. Left uncancelled it
 * fired on every ordinary stop — the loop had already exited and the process
 * was simply waiting on an open Redis socket, so every restart took the full
 * twenty seconds and logged "did not finish in time" about work that had
 * finished. A warning that fires when nothing is wrong is a warning people stop
 * reading.
 */
let forceExit: NodeJS.Timeout | null = null

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    workerLog.info('shutdown signal received; finishing the current tick', { signal })
    running = false
    // Cuts the idle wait short. A tick already in progress still finishes — a
    // publish interrupted mid-flight is exactly what the write-ahead attempt
    // row and reconciliation exist to recover from, but finishing cleanly is
    // better than relying on that.
    wake?.()

    // A publish can legitimately take longer than an orchestrator will wait, so
    // this is a bound rather than a promise. Anything still in flight at this
    // point is left to reconciliation on the next start.
    forceExit = setTimeout(() => {
      workerLog.warn('a tick did not finish in time; exiting anyway', {
        note: 'anything still in flight is recovered by the reconciler on the next start',
      })
      process.exit(0)
    }, 20_000)
    forceExit.unref()
  })
}

main()
  .then(async () => {
    // Every long-lived handle, explicitly. The Redis connection inside the
    // Publisher is the one that mattered: nothing closed it, so the event loop
    // stayed alive after the tick loop ended and the process sat there until
    // the forced-exit deadline. On a rolling deploy that is twenty wasted
    // seconds per worker, every time.
    if (forceExit) clearTimeout(forceExit)
    await closePublisher()
    await db().$disconnect()
    workerLog.info('shutdown complete')
    process.exit(0)
  })
  .catch(async (err) => {
    workerLog.fatal('worker failed', { err })
    await db().$disconnect().catch(() => undefined)
    process.exit(1)
  })
