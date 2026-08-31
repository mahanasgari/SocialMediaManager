import { assertOutsideTransaction } from '@smm/config'
import { ProviderError } from '../errors.js'
import type { ProviderId } from '../capabilities/index.js'

/**
 * The Meta Graph API, shared by Facebook Pages and Instagram.
 *
 * One module rather than two, because they are one API. Instagram Business
 * accounts are reached THROUGH a Facebook Page: the same Facebook Login, the
 * same app, the same token exchange, the same error envelope. Writing them
 * separately would be two implementations of one OAuth flow, and the second one
 * would drift.
 *
 * What differs between them is only what gets published and how, which is
 * exactly what the two adapters contain and nothing else.
 *
 * [V] Graph API versioned paths, error envelope shape and the page-token flow —
 * https://developers.facebook.com/docs/graph-api/guides/error-handling and
 * https://developers.facebook.com/docs/pages-api/posts, retrieved 2026-08-31.
 */

/**
 * Pinned, not floating.
 *
 * Meta deprecates a version roughly every two years and unversioned calls get
 * whatever is current — so an unpinned client changes behaviour on Meta's
 * schedule rather than ours, in production, with no deploy. Bumping this is a
 * decision somebody makes on purpose.
 */
export const GRAPH_VERSION = 'v21.0'
export const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`

/** Operator-supplied app credentials. Absent means the connector is unconfigured. */
export function metaApp(): { appId: string; appSecret: string } | null {
  const appId = process.env['META_APP_ID']
  const appSecret = process.env['META_APP_SECRET']
  if (!appId || !appSecret) return null
  return { appId, appSecret }
}

/**
 * A Graph API error, as Meta actually returns it.
 *
 * `code` and `error_subcode` are the load-bearing fields. The `message` is
 * prose written for a developer reading a console and is not stable enough to
 * branch on — matching against it is how a connector breaks on a wording change
 * nobody announced.
 */
type GraphErrorBody = {
  error?: {
    message?: string
    type?: string
    code?: number
    error_subcode?: number
    error_user_msg?: string
    fbtrace_id?: string
  }
}

/**
 * Maps a Graph error onto our taxonomy.
 *
 * The mapping is by NUMERIC CODE, and the codes below are the ones that change
 * what we do rather than merely what we say:
 *
 *   190      the token is dead — expired, revoked, or invalidated by a password
 *            change. No amount of retrying fixes it, so it must reach the user
 *            as "reconnect this account" rather than as a failed post.
 *   4, 17,
 *   32, 613  rate limiting, at app, user and page scope respectively. Meta does
 *            not send Retry-After on these, so our own backoff is all there is.
 *   200, 10  permission missing. Usually App Review not granted, or the person
 *            who connected lost admin rights on the Page.
 *   1, 2     transient Meta-side failure. These are the ones worth retrying.
 *   368      the account is temporarily blocked for a policy violation. Not
 *            retryable, and a message saying so beats a generic failure.
 */
export function mapGraphError(
  provider: ProviderId,
  status: number,
  body: unknown
): ProviderError {
  const error = (body as GraphErrorBody)?.error ?? {}
  const code = error.code
  const subcode = error.error_subcode
  // error_user_msg is written for an end user and is the better message when
  // present; `message` is developer prose.
  const detail = error.error_user_msg ?? error.message ?? 'no detail supplied'
  const trace = error.fbtrace_id

  const options = {
    httpStatus: status,
    ...(trace ? { providerRequestId: trace } : {}),
    raw: body,
  }

  if (code === 190) {
    return new ProviderError(
      provider,
      'TokenExpired',
      `Reconnect this account: ${detail}`,
      options
    )
  }

  if (code === 200 || code === 10 || subcode === 1349125) {
    return new ProviderError(
      provider,
      'PermissionRevoked',
      `This app is not permitted to do that: ${detail}`,
      options
    )
  }

  if (code === 4 || code === 17 || code === 32 || code === 613) {
    return new ProviderError(
      provider,
      'RateLimited',
      `Rate limited. ${detail}`,
      options
    )
  }

  if (code === 368) {
    return new ProviderError(
      provider,
      'PermanentFailure',
      `The account is temporarily restricted by Meta: ${detail}`,
      options
    )
  }

  if (code === 1 || code === 2 || status >= 500) {
    return new ProviderError(provider, 'ProviderDown', `Meta had a problem: ${detail}`, options)
  }

  // Anything else that came back 4xx is our request being wrong, and retrying
  // an identical wrong request forever is worse than failing once.
  return new ProviderError(provider, 'ContentRejected', detail, options)
}

export type GraphRequest = {
  method?: 'GET' | 'POST' | 'DELETE'
  /** Query parameters. The access token is added separately. */
  query?: Record<string, string | undefined>
  /** Form body. Graph takes application/x-www-form-urlencoded, not JSON. */
  form?: Record<string, string | undefined>
  accessToken?: string
  timeoutMs?: number
}

/**
 * One Graph call.
 *
 * The token goes in the Authorization header rather than an `access_token`
 * query parameter, even though Graph accepts both. A token in a query string
 * lands in access logs, proxy logs and browser history, and Meta's own tokens
 * are long-lived — so a leak there is a leak that lasts sixty days.
 */
export async function graph<T>(
  provider: ProviderId,
  path: string,
  request: GraphRequest = {}
): Promise<T> {
  // A provider call inside an open transaction pins a Postgres connection for
  // the duration of an HTTP round trip. Under load the pool exhausts and the
  // deployment stalls, presenting as a database problem that is actually this.
  assertOutsideTransaction(`Meta Graph ${path}`)

  const url = new URL(path.startsWith('http') ? path : `${GRAPH_BASE}${path}`)
  for (const [key, value] of Object.entries(request.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, value)
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), request.timeoutMs ?? 30_000)

  let response: Response
  try {
    response = await fetch(url, {
      method: request.method ?? 'GET',
      headers: {
        ...(request.accessToken ? { authorization: `Bearer ${request.accessToken}` } : {}),
        ...(request.form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
      },
      ...(request.form
        ? {
            body: new URLSearchParams(
              Object.entries(request.form).filter(([, v]) => v !== undefined) as [string, string][]
            ).toString(),
          }
        : {}),
      signal: controller.signal,
    })
  } catch (err) {
    // A timeout or a socket error is AMBIGUOUS for a publish — the request may
    // have landed. ProviderDown is the code the pipeline reconciles against
    // rather than retries blindly, which is the difference between recovering
    // and posting twice.
    throw new ProviderError(
      provider,
      'ProviderDown',
      err instanceof Error && err.name === 'AbortError'
        ? 'Meta did not respond in time.'
        : 'Could not reach Meta.',
      { raw: String(err) }
    )
  } finally {
    clearTimeout(timer)
  }

  const text = await response.text()
  let body: unknown
  try {
    body = text ? JSON.parse(text) : {}
  } catch {
    // Graph returns HTML for some gateway failures. Parsing it as JSON and
    // reporting "unexpected token <" tells nobody anything.
    throw new ProviderError(
      provider,
      response.ok ? 'PermanentFailure' : 'ProviderDown',
      `Meta returned a non-JSON response (HTTP ${response.status}).`,
      { httpStatus: response.status, raw: text.slice(0, 500) }
    )
  }

  if (!response.ok) throw mapGraphError(provider, response.status, body)

  return body as T
}

/**
 * Trades a short-lived user token for a long-lived one.
 *
 * Worth doing at connect time and not later: the short-lived token Facebook
 * Login returns lasts about an hour, and a connector that skips this works
 * perfectly in testing and breaks for every user the next morning.
 *
 * [V] https://developers.facebook.com/docs/facebook-login/guides/access-tokens/get-long-lived,
 * retrieved 2026-08-31.
 */
export async function exchangeForLongLivedToken(
  provider: ProviderId,
  shortLived: string
): Promise<{ accessToken: string; expiresInSeconds: number | null }> {
  const app = metaApp()
  if (!app) {
    throw new ProviderError(provider, 'PermanentFailure', 'META_APP_ID and META_APP_SECRET are not set.')
  }

  const body = await graph<{ access_token: string; expires_in?: number }>(
    provider,
    '/oauth/access_token',
    {
      query: {
        grant_type: 'fb_exchange_token',
        client_id: app.appId,
        client_secret: app.appSecret,
        fb_exchange_token: shortLived,
      },
    }
  )

  return {
    accessToken: body.access_token,
    expiresInSeconds: body.expires_in ?? null,
  }
}

export type ManagedPage = {
  id: string
  name: string
  /**
   * The PAGE token, not the user token.
   *
   * Page tokens derived from a long-lived user token do not expire, which is
   * why they are what gets stored. Storing the user token and deriving per
   * publish would add a round trip to every post and a second thing that can
   * fail at the worst moment.
   */
  accessToken: string
  tasks: string[]
  instagramBusinessAccountId?: string
}

/**
 * Every Page this person can post to, with its own token.
 *
 * `tasks` is checked rather than assumed: being able to SEE a Page is not being
 * able to post to it, and connecting one you cannot publish to produces an
 * account that looks connected and fails on the first scheduled post — days
 * later, in front of an audience.
 */
export async function listManagedPages(
  provider: ProviderId,
  userAccessToken: string
): Promise<ManagedPage[]> {
  const body = await graph<{
    data?: Array<{
      id: string
      name: string
      access_token: string
      tasks?: string[]
      instagram_business_account?: { id: string }
    }>
  }>(provider, '/me/accounts', {
    query: { fields: 'id,name,access_token,tasks,instagram_business_account{id}', limit: '100' },
    accessToken: userAccessToken,
  })

  return (body.data ?? []).map((page) => ({
    id: page.id,
    name: page.name,
    accessToken: page.access_token,
    tasks: page.tasks ?? [],
    ...(page.instagram_business_account
      ? { instagramBusinessAccountId: page.instagram_business_account.id }
      : {}),
  }))
}

/** True when this person can actually publish to the Page, not merely read it. */
export function canPublish(page: ManagedPage): boolean {
  return page.tasks.includes('CREATE_CONTENT')
}

/**
 * The authorize URL for Facebook Login.
 *
 * Scopes are the minimum for what each adapter claims, and no more. An app
 * asking for permissions it does not use is an app that fails App Review, and
 * every extra scope is one more thing a user has to agree to hand over.
 */
export function authorizeUrl(options: {
  appId: string
  redirectUri: string
  state: string
  scopes: readonly string[]
}): string {
  const url = new URL(`https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth`)
  url.searchParams.set('client_id', options.appId)
  url.searchParams.set('redirect_uri', options.redirectUri)
  url.searchParams.set('state', options.state)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', options.scopes.join(','))
  return url.toString()
}

/** Exchanges the authorization code for a short-lived user token. */
export async function exchangeCode(
  provider: ProviderId,
  code: string,
  redirectUri: string
): Promise<string> {
  const app = metaApp()
  if (!app) {
    throw new ProviderError(provider, 'PermanentFailure', 'META_APP_ID and META_APP_SECRET are not set.')
  }

  const body = await graph<{ access_token: string }>(provider, '/oauth/access_token', {
    query: {
      client_id: app.appId,
      client_secret: app.appSecret,
      redirect_uri: redirectUri,
      code,
    },
  })

  return body.access_token
}
