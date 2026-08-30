import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * Opt-in visibility of soft-deleted rows.
 *
 * Soft delete is applied by the tenancy extension from Phase 1 rather than
 * arriving with the purge job in Phase 9. Once `deletedAt` exists, EVERY
 * tenant-scoped query must filter on it — introducing that later would mean
 * auditing every query written before it existed, and a retrofit like that
 * misses cases. Cheaper to have it from the first migration.
 */
export const includeDeletedStorage = new AsyncLocalStorage<boolean>()

/**
 * Runs `fn` with soft-deleted rows visible. Needed by the purge job, restore
 * flows, and admin views. Deliberately explicit: an ambient "show everything"
 * default is how deleted data leaks back into a UI.
 */
export function withDeleted<T>(fn: () => Promise<T>): Promise<T> {
  return includeDeletedStorage.run(true, fn)
}

export function deletedIncluded(): boolean {
  return includeDeletedStorage.getStore() === true
}
