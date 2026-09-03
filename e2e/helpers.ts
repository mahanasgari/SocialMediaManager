import { expect, type Page, type APIRequestContext } from '@playwright/test'

/**
 * The demo account created by `pnpm db:seed`.
 *
 * Fixed and published on purpose — a demo login nobody can type from memory is
 * a demo nobody uses. Never enable DEMO_MODE on a reachable deployment; the
 * preflight blocks it.
 */
export const DEMO = { email: 'owner@demo.local', password: 'demo1234' }

/**
 * Signs in through the actual form.
 *
 * Not by posting to the API and injecting a cookie. The form IS the thing under
 * test — the bug that made every sign-in land on a 404 lived in the redirect
 * after a successful POST, which an API-only login would never have executed.
 */
export async function signIn(page: Page, credentials = DEMO): Promise<void> {
  // Already signed in? Land on the workspace and stop.
  //
  // The suite reuses one session (see auth.setup.ts), so calling this per test
  // would submit the form thirty-four times from one address and trip the
  // product's IP limiter — which is working correctly and should not be
  // loosened to accommodate a test suite. Kept as a call rather than deleted
  // from every spec because a test that opts out of the saved state, as
  // auth.spec.ts does, still needs the real form.
  await page.goto('/')
  if (/\/w\/[0-9a-f-]+\//.test(page.url())) {
    await page.waitForURL(/\/w\/[0-9a-f-]+\//, { timeout: 30_000 })
    return
  }

  await page.goto('/login')
  await page.getByLabel('Email').fill(credentials.email)
  await page.getByLabel('Password').fill(credentials.password)
  await page.getByRole('button', { name: 'Sign in' }).click()

  // Landing on a real workspace URL is the assertion. Waiting for
  // networkidle would pass just as happily on the 404 page.
  await page.waitForURL(/\/w\/[0-9a-f-]+\/dashboard/, { timeout: 30_000 })
}

/** The workspace id from the current URL. */
export function workspaceIdFrom(page: Page): string {
  const match = /\/w\/([0-9a-f-]+)\//.exec(page.url())
  if (!match?.[1]) throw new Error(`No workspace id in URL: ${page.url()}`)
  return match[1]
}

/**
 * Clears the sign-in rate limiter.
 *
 * The suite signs in repeatedly and would otherwise lock the demo account out
 * partway through — a failure that looks like broken auth and is actually the
 * brute-force defence working correctly.
 */
export async function clearLoginLimits(request: APIRequestContext): Promise<void> {
  // Best effort: only available when the test stack exposes it. Nothing here
  // depends on it succeeding.
  await request.post('/api/v1/test/reset-rate-limits').catch(() => undefined)
}

/** Asserts a page rendered rather than 404-ing or erroring. */
export async function expectPage(page: Page, heading: string | RegExp): Promise<void> {
  await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible()
  await expect(page.getByText('This page could not be found')).toHaveCount(0)
}
