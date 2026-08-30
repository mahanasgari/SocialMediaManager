import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * Cross-cutting execution context.
 *
 * WHY THIS LIVES IN @smm/config
 *
 * The transaction-boundary guard has to be readable from three places that are
 * forbidden to import each other: @smm/database opens transactions,
 * @smm/providers makes the HTTP calls that must not happen inside one, and
 * @smm/storage makes the S3 calls with the same constraint. The import
 * boundaries in eslint.config.js exist precisely to stop providers reaching into
 * database, so the shared state cannot live there.
 *
 * @smm/config is the one package every other package may import, and it has no
 * internal dependencies of its own. That makes it the only correct home for
 * ambient context. It is infrastructure, not configuration — hence its own file.
 */

export type TransactionState = {
  /** True while a database transaction is open on this async execution path. */
  active: boolean
  /** The workspace scope asserted for the current transaction, if any. */
  workspaceId?: string
  /** Correlates API, worker and job logs for one logical operation. */
  requestId?: string
}

export const transactionContext = new AsyncLocalStorage<TransactionState>()

/**
 * Thrown when I/O is attempted inside an open database transaction.
 *
 * This is not a style rule. `SET LOCAL app.current_workspace` is transaction
 * scoped, so the tempting fix — wrap the whole request in a transaction so the
 * setting persists — means any provider HTTP call inside it pins a Postgres
 * connection for the call's entire duration. A provider with a 30-second
 * timeout holds a connection for 30 seconds; under load the pool exhausts and
 * the deployment stalls, presenting as a database problem that is actually an
 * HTTP problem.
 *
 * Failing loudly in the first test that makes the mistake is much cheaper than
 * diagnosing it in production.
 */
export class TransactionBoundaryViolation extends Error {
  override readonly name = 'TransactionBoundaryViolation'

  constructor(operation: string, detail?: string) {
    super(
      `${operation} attempted inside an open database transaction. ` +
        `Commit first, then perform I/O; use the transactional outbox for ` +
        `side effects that must happen exactly once after a commit.` +
        (detail ? ` (${detail})` : '')
    )
  }
}

/**
 * Guard for any I/O that must not run inside a transaction. Call at the top of
 * provider HTTP clients, S3 clients, and non-transactional queue enqueues.
 */
export function assertOutsideTransaction(operation: string, detail?: string): void {
  if (transactionContext.getStore()?.active) {
    throw new TransactionBoundaryViolation(operation, detail)
  }
}

/** True when a database transaction is open on this execution path. */
export function inTransaction(): boolean {
  return transactionContext.getStore()?.active === true
}

/** The workspace scope asserted for the current transaction, if any. */
export function currentWorkspaceId(): string | undefined {
  return transactionContext.getStore()?.workspaceId
}

/**
 * Runs `fn` with transaction state marked active. Intended for @smm/database's
 * transaction helper; application code should not call this directly.
 */
export function runInTransactionContext<T>(state: TransactionState, fn: () => Promise<T>): Promise<T> {
  return transactionContext.run(state, fn)
}
