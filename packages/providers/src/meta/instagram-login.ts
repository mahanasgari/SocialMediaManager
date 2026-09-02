import { ProviderError } from '../errors.js'
import { providerSetting } from '../settings.js'
import type { ProviderId } from '../capabilities/index.js'
import { mapGraphError } from './graph.js'

/**
 * Instagram Login — Meta's newer OAuth flow, which does not involve Facebook.
 *
 * A SEPARATE module from meta/graph.ts rather than a widening of it, and the
 * separation is the point. Facebook Pages still needs the old flow and will
 * keep needing it, so the two must coexist; and almost nothing is shared
 * anyway. Different authorization host, different token exchange host,
 * different API host, different app credentials, different token type,
 * different refresh story. Putting both behind one helper would produce a
 * function whose every branch asks which flow it is in.
 *
 * The differences that actually matter:
 *
 *   1. NO FACEBOOK PAGE. The old flow reaches Instagram by walking a person's
 *      Pages and keeping the ones with a linked Instagram account. Here the
 *      person signs in to Instagram directly and authorises one professional
 *      account. That removes the single most common reason connecting failed.
 *
 *   2. THE TOKEN EXPIRES, AND CAN BE REFRESHED. A Page token has no expiry and
 *      no refresh — the old adapter's refreshToken() throws, saying reconnect.
 *      An Instagram User token lives 60 days and renews for another 60 without
 *      the person being present, so a connection can survive unattended.
 *
 *   3. THE APP CREDENTIALS ARE DIFFERENT. The Instagram App ID and Secret live
 *      under Products > Instagram > API setup, and are NOT the Facebook App ID.
 *      Using META_APP_ID here fails at token exchange with an error that blames
 *      the code rather than the credential, which is why these are separate
 *      settings keys rather than a reuse.
 */

/** Where the person is sent to authorise. */
const AUTHORIZE = 'https://www.instagram.com/oauth/authorize'

/** Where the authorization code is redeemed. NOT the graph host. */
const TOKEN = 'https://api.instagram.com/oauth/access_token'

/**
 * Everything after the token exchange.
 *
 * [V] "all endpoints are accessed via the graph.instagram.com host"
 *     https://developers.facebook.com/docs/instagram-platform/overview
 *     retrieved 2026-09-02
 */
export const IG_BASE = 'https://graph.instagram.com'

/** Operator-supplied Instagram app credentials. Absent means unconfigured. */
export function instagramApp(): { appId: string; appSecret: string } | null {
  const appId = providerSetting('INSTAGRAM_APP_ID')
  const appSecret = providerSetting('INSTAGRAM_APP_SECRET')
  if (!appId || !appSecret) return null
  return { appId, appSecret }
}

/**
 * The authorization URL.
 *
 * Scopes are COMMA-separated. Meta's docs allow comma or URL-encoded space, and
 * real traffic from other clients uses commas — a space-separated list arrives
 * as one unrecognised scope and the consent screen simply shows nothing.
 *
 * [V] Authorization URL, parameters and comma-separated scope format
 *     https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/business-login
 *     retrieved 2026-09-02
 */
export function igAuthorizeUrl(options: {
  appId: string
  redirectUri: string
  state: string
  scopes: readonly string[]
}): string {
  const url = new URL(AUTHORIZE)
  url.searchParams.set('client_id', options.appId)
  url.searchParams.set('redirect_uri', options.redirectUri)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('state', options.state)
  url.searchParams.set('scope', options.scopes.join(','))
  return url.toString()
}

/**
 * The authorization code, redeemed for a short-lived token.
 *
 * Meta appends `#_` to the redirect and the fragment is not part of the code.
 * A browser never sends a fragment to the server so this is usually moot, but
 * anything that reconstructs the URL — a proxy, a paste into a form, a test
 * fixture — carries it through, and the exchange then fails with an invalid
 * code error that names nothing useful. Stripping it costs one line.
 *
 * [V] "The #_ appended to the end of the redirect URI is not part of the code
 *     itself, so strip it out."
 *     https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/business-login
 *     retrieved 2026-09-02
 */
export async function igExchangeCode(
  provider: ProviderId,
  code: string,
  redirectUri: string
): Promise<{ accessToken: string; userId: string }> {
  const app = instagramApp()
  if (!app) {
    throw new ProviderError(provider, 'PermanentFailure', 'Instagram is not configured.')
  }

  const body = new URLSearchParams({
    client_id: app.appId,
    client_secret: app.appSecret,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
    code: code.replace(/#_$/, ''),
  })

  // Form-encoded POST, unlike the Facebook flow's GET with query parameters.
  const response = await fetch(TOKEN, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  })

  const json = (await response.json().catch(() => ({}))) as {
    access_token?: string
    user_id?: number | string
    error_message?: string
    error_type?: string
  }

  if (!response.ok || !json.access_token) {
    throw new ProviderError(
      provider,
      response.status === 400 ? 'PermissionRevoked' : 'ProviderDown',
      json.error_message ??
        'Instagram would not exchange the authorization code. Try connecting again.'
    )
  }

  return { accessToken: json.access_token, userId: String(json.user_id ?? '') }
}

/**
 * Short-lived (one hour) to long-lived (sixty days).
 *
 * Must happen during the connect flow. The short-lived token is useless an hour
 * later, and there is no path back to a long-lived one without the person
 * authorising again.
 *
 * [V] grant_type=ig_exchange_token, 60-day lifetime
 *     https://developers.facebook.com/docs/instagram-platform/overview
 *     retrieved 2026-09-02
 */
export async function igExchangeForLongLivedToken(
  provider: ProviderId,
  shortLivedToken: string
): Promise<{ accessToken: string; expiresAt: Date | null }> {
  const app = instagramApp()
  if (!app) {
    throw new ProviderError(provider, 'PermanentFailure', 'Instagram is not configured.')
  }

  const url = new URL(`${IG_BASE}/access_token`)
  url.searchParams.set('grant_type', 'ig_exchange_token')
  url.searchParams.set('client_secret', app.appSecret)
  url.searchParams.set('access_token', shortLivedToken)

  const response = await fetch(url)
  const json = (await response.json().catch(() => ({}))) as {
    access_token?: string
    expires_in?: number
    error?: { message?: string; code?: number }
  }

  if (!response.ok || !json.access_token) {
    throw mapGraphError(provider, response.status, json)
  }

  return {
    accessToken: json.access_token,
    expiresAt: json.expires_in ? new Date(Date.now() + json.expires_in * 1000) : null,
  }
}

/**
 * Renews a long-lived token for another sixty days.
 *
 * The token must be at least 24 hours old and not yet expired. Both bounds are
 * real: refreshing a fresh token is rejected, and an expired one cannot be
 * recovered at all — the person has to reconnect. The refresher must therefore
 * run well before day sixty rather than on the day.
 *
 * [V] GET /refresh_access_token, grant_type=ig_refresh_token, "at least 24
 *     hours old but has not expired"
 *     https://developers.facebook.com/docs/instagram-platform/reference/refresh_access_token/
 *     retrieved 2026-09-02
 */
export async function igRefreshToken(
  provider: ProviderId,
  accessToken: string
): Promise<{ accessToken: string; expiresAt: Date | null }> {
  const url = new URL(`${IG_BASE}/refresh_access_token`)
  url.searchParams.set('grant_type', 'ig_refresh_token')
  url.searchParams.set('access_token', accessToken)

  const response = await fetch(url)
  const json = (await response.json().catch(() => ({}))) as {
    access_token?: string
    expires_in?: number
    error?: { message?: string; code?: number }
  }

  if (!response.ok || !json.access_token) {
    throw mapGraphError(provider, response.status, json)
  }

  return {
    accessToken: json.access_token,
    expiresAt: json.expires_in ? new Date(Date.now() + json.expires_in * 1000) : null,
  }
}

/**
 * A call against graph.instagram.com.
 *
 * Deliberately the same shape as meta/graph.ts's `graph()` so the adapter reads
 * the same, and deliberately a different function so the host cannot be got
 * wrong by accident.
 */
export async function igGraph<T>(
  provider: ProviderId,
  path: string,
  options: {
    accessToken: string
    method?: 'GET' | 'POST' | 'DELETE'
    query?: Record<string, string | undefined>
    body?: Record<string, string>
  }
): Promise<T> {
  const url = new URL(path.startsWith('http') ? path : `${IG_BASE}${path}`)
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, value)
  }

  const method = options.method ?? 'GET'
  const init: RequestInit = {
    method,
    headers: { authorization: `Bearer ${options.accessToken}` },
  }

  if (options.body) {
    init.headers = {
      ...init.headers,
      'content-type': 'application/x-www-form-urlencoded',
    }
    init.body = new URLSearchParams(options.body)
  }

  const response = await fetch(url, init)
  const json = (await response.json().catch(() => ({}))) as T & {
    error?: { message?: string; code?: number; error_subcode?: number }
  }

  if (!response.ok) throw mapGraphError(provider, response.status, json)
  return json
}
