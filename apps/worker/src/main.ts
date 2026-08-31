import { loadEnv } from '@smm/config'
import { db, withTenant } from '@smm/database'
import { Scanner, ClockWentBackwards } from './scanner.js'
import { publishVariant, activePublisher } from './publisher.js'
import { recoverInterrupted } from './recovery.js'
import { ingestMetrics } from './metrics.js'
import { dispatchWebhooks } from './webhooks.js'
import { ingestFeeds } from './rss.js'
import { dispatchInbound } from './inbox.js'
import { runRetention } from './retention.js'

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
      console.warn(
        `recovery: ${recovered.found} interrupted publish(es) — ` +
          `${recovered.republishAvoided} already live (not republished), ` +
          `${recovered.requeued} confirmed absent and requeued, ` +
          `${recovered.needsReview} awaiting a human, ${recovered.skipped} left for the next sweep`
      )
    }
  } catch (err) {
    console.error('recovery sweep failed:', err instanceof Error ? err.message : err)
  }

  let result
  try {
    result = await scanner.claim()
  } catch (err) {
    if (err instanceof ClockWentBackwards) {
      // Loud, and we skip the tick rather than risk re-claiming published rows.
      console.error(err.message)
      return
    }
    throw err
  }

  if (result.backlog) {
    // Silence during recovery is worse than a warning: somebody watching a
    // backlog drain needs to know it is draining.
    console.warn(
      `backlog: more posts are due than one tick can claim. Draining oldest-first at ` +
        `${TICK_MS / 1000}s intervals.`
    )
  }

  for (const variant of result.missed) {
    console.warn(`variant ${variant.id} missed its window and awaits a human decision`)
  }

  for (const variant of result.claimed) {
    try {
      const status = await publishVariant(variant.workspaceId, variant.id)
      console.log(`variant ${variant.id} -> ${status}`)

      if (status === 'PUBLISHED') {
        // latenessSeconds is always recorded; publishedLate only when the
        // delay exceeds what the tick rate itself explains. See
        // Scanner.isNotablyLate.
        const late = Scanner.lateness(variant.scheduledAt, new Date())
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
      console.error(`variant ${variant.id} threw:`, err instanceof Error ? err.message : err)
    }
  }

  // Inbound dispatch runs BEFORE metrics and webhooks. A person waiting on a
  // reply is the most latency-sensitive thing in the tick, and turning stored
  // events into conversations is cheap — the expensive part already happened in
  // the receiver's 200ms budget.
  try {
    const inbox = await dispatchInbound()
    if (inbox.processed + inbox.failed > 0) {
      console.log(
        `inbox: processed ${inbox.processed}, failed ${inbox.failed}, ` +
          `${inbox.messages} new message${inbox.messages === 1 ? '' : 's'}`
      )
    }
  } catch (err) {
    console.error('inbound dispatch failed:', err instanceof Error ? err.message : err)
  }

  // Metrics ingestion shares the tick. It is cheap because the decaying schedule
  // means most passes find nothing due, and it competes for the same provider
  // quota as publishing — so it runs after, never before.
  try {
    const metrics = await ingestMetrics()
    if (metrics.collected > 0) {
      console.log(`metrics: collected ${metrics.collected}, skipped ${metrics.skipped}`)
    }
  } catch (err) {
    console.error('metrics ingestion failed:', err instanceof Error ? err.message : err)
  }

  // Retention, hourly. Last because it is the least urgent thing in the tick
  // and the only one that deletes: if the process is struggling, publishing and
  // inbox delivery should get the time.
  if (Date.now() - lastRetentionAt >= RETENTION_INTERVAL_MS) {
    lastRetentionAt = Date.now()
    try {
      const reaped = await runRetention()
      const touched = Object.values(reaped).reduce((a, b) => a + b, 0)
      if (touched > 0) console.log('retention:', JSON.stringify(reaped))
    } catch (err) {
      console.error('retention sweep failed:', err instanceof Error ? err.message : err)
    }
  }

  // Outbound webhooks last: they are the least time-critical work in the tick,
  // and a slow customer endpoint must never delay a scheduled post.
  try {
    const hooks = await dispatchWebhooks()
    if (hooks.sent + hooks.failed > 0) {
      console.log(`webhooks: sent ${hooks.sent}, failed ${hooks.failed}, disabled ${hooks.disabled}`)
    }
  } catch (err) {
    console.error('webhook dispatch failed:', err instanceof Error ? err.message : err)
  }

  // RSS is rate-limited internally to one fetch per feed per 15 minutes, so
  // running it every tick costs almost nothing on the passes where nothing is due.
  try {
    const feeds = await ingestFeeds()
    if (feeds.created > 0) {
      console.log(`rss: ${feeds.created} new item(s) from ${feeds.feeds} feed(s)`)
    }
  } catch (err) {
    console.error('rss ingestion failed:', err instanceof Error ? err.message : err)
  }
}

async function main(): Promise<void> {
  loadEnv()
  console.log(`worker started; scanning every ${TICK_MS / 1000}s`)

  while (running) {
    const started = Date.now()
    try {
      await tick()
    } catch (err) {
      console.error('tick failed:', err instanceof Error ? err.message : err)
    }
    const elapsed = Date.now() - started
    await sleep(Math.max(0, TICK_MS - elapsed))
  }

  console.log('worker stopped')
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

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    console.log(`${signal} received; finishing the current tick then stopping`)
    running = false
    // Cuts the idle wait short. A tick already in progress still finishes — a
    // publish interrupted mid-flight is exactly what the write-ahead attempt
    // row and reconciliation exist to recover from, but finishing cleanly is
    // better than relying on that.
    wake?.()

    // A publish can legitimately take longer than an orchestrator will wait, so
    // this is a bound rather than a promise. Anything still in flight at this
    // point is left to reconciliation on the next start.
    setTimeout(() => {
      console.warn('did not finish in time; exiting anyway')
      process.exit(0)
    }, 20_000).unref()
  })
}

main()
  .catch((err) => {
    console.error('worker failed to start:', err instanceof Error ? err.message : err)
    process.exit(1)
  })
  .finally(() => db().$disconnect())
