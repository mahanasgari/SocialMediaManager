import { cookies, headers } from 'next/headers'

/**
 * THE ONLY sanctioned way apps/web talks to the API from the server.
 *
 * React Server Components have no ambient cookie jar. A bare `fetch` from a
 * server component sends no credentials, so the API sees an anonymous request —
 * and the symptom is the classic "works in the browser, logged out on refresh"
 * bug, which looks like a session problem and is actually a plumbing one.
 *
 * That failure is invisible in review and obvious only at runtime, so an ESLint
 * rule bans bare `fetch` to the API from apps/web/app/**. A lint rule is the
 * right tool here precisely because the mistake is easy to make and hard to see.
 *
 * Server-to-server traffic goes direct to INTERNAL_API_URL rather than through
 * the Next rewrite, saving a hop. The browser still only ever sees one origin —
 * the single-origin invariant is about the BROWSER, not about us.
 */

const INTERNAL_API_URL = process.env['INTERNAL_API_URL'] ?? 'http://localhost:3001'
const REQUEST_ID_HEADER = 'x-request-id'

export type ServerFetchInit = Omit<RequestInit, 'cache'> & {
  /** Opt in explicitly; the default is no-store, see below. */
  cache?: RequestCache
}

export async function serverFetch(path: string, init: ServerFetchInit = {}): Promise<Response> {
  const cookieStore = await cookies()
  const headerStore = await headers()

  const requestId = headerStore.get(REQUEST_ID_HEADER) ?? crypto.randomUUID()

  return fetch(`${INTERNAL_API_URL}${path}`, {
    ...init,
    headers: {
      ...init.headers,
      cookie: cookieStore.toString(),
      [REQUEST_ID_HEADER]: requestId,
      // Part of the CSRF defence in depth: a cross-site form post cannot set a
      // custom header without triggering preflight.
      'x-smm-client': 'web',
    },
    // Per-user data must never be served from a shared cache. Defaulting to
    // no-store means a caching mistake requires opting in rather than
    // forgetting to opt out — and the failure mode of the opposite default is
    // showing one tenant's data to another.
    cache: init.cache ?? 'no-store',
  })
}

/**
 * Convenience wrapper that parses JSON and surfaces the API's error envelope.
 *
 * Returns a discriminated result rather than throwing, so a page can render a
 * useful empty state instead of an error boundary for the ordinary cases —
 * "no workspaces yet" is not an exception.
 */
export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; code: string; message: string; requestId: string }

export async function apiGet<T>(path: string, init?: ServerFetchInit): Promise<ApiResult<T>> {
  const response = await serverFetch(path, init)

  if (response.ok) {
    return { ok: true, data: (await response.json()) as T }
  }

  try {
    const body = (await response.json()) as {
      error?: { code?: string; message?: string; requestId?: string }
    }
    return {
      ok: false,
      status: response.status,
      code: body.error?.code ?? 'unknown_error',
      message: body.error?.message ?? 'The request failed.',
      requestId: body.error?.requestId ?? 'unknown',
    }
  } catch {
    // A non-JSON body means something upstream of the API answered — a proxy, a
    // gateway, or the service being down. Say so rather than pretending we got
    // a structured error.
    return {
      ok: false,
      status: response.status,
      code: 'unexpected_response',
      message: 'The API returned an unexpected response. It may be starting up or unreachable.',
      requestId: 'unknown',
    }
  }
}
