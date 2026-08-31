import { publishVariant, closePublisher } from './publisher.js'

/**
 * A worker that publishes one variant and is meant to be killed.
 *
 * A real, separate process, because that is the only way to test the failure
 * that matters. Mocking a crash inside the test process cannot: `process.exit`
 * takes the test runner with it, a thrown error still unwinds `finally` blocks
 * and closes connections cleanly, and a faked one leaves the pipeline free to
 * tidy up after itself. None of that is what an OOM kill does.
 *
 * SIGKILL to a child is the real thing. No handlers run, no `finally` executes,
 * the Redis lease is left dangling, and the committed IN_FLIGHT row is all that
 * survives — which is exactly the state the reconciler has to be correct about.
 *
 * The parent decides when to kill by watching the DATABASE for the IN_FLIGHT
 * row to appear, not by any signal from here. What the reconciler will see is
 * therefore what triggers the kill, rather than something this process claims
 * about itself.
 */
const [workspaceId, variantId] = process.argv.slice(2)

if (!workspaceId || !variantId) {
  console.error('usage: fault-child <workspaceId> <variantId>')
  process.exit(2)
}

publishVariant(workspaceId, variantId)
  .then(async (status) => {
    // Only reached when the parent did NOT kill us — the hang elapsed on its
    // own. The harness treats this as a failed setup rather than a pass.
    console.log(`SETTLED ${status}`)
    await closePublisher()
    process.exit(0)
  })
  .catch(async (err) => {
    console.error('THREW', err instanceof Error ? err.message : err)
    await closePublisher()
    process.exit(1)
  })
