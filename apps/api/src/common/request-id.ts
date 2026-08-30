import { randomUUID } from 'node:crypto'

/**
 * Request correlation.
 *
 * apps/web forwards this header from the browser request through serverFetch,
 * and the worker carries it onto job context, so one identifier follows a
 * logical operation across all three processes. Without that, "it failed" in a
 * worker log cannot be tied to the request that caused it.
 */
export const REQUEST_ID_HEADER = 'x-request-id'

/** Reuses an inbound id when present so the chain is not broken at our edge. */
export function resolveRequestId(incoming: string | string[] | undefined): string {
  const value = Array.isArray(incoming) ? incoming[0] : incoming
  if (value && value.length > 0 && value.length <= 200) return value
  return randomUUID()
}
