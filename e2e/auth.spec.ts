import { expect, test } from '@playwright/test'
import { DEMO, expectPage, signIn } from './helpers'

/**
 * Sign-in, and the guards around it.
 *
 * The first test here exists because of a real bug: the form pushed
 * `/dashboard`, which is not a route — every successful sign-in landed on a
 * 404. 1034 unit tests missed it, because the redirect only runs in a browser.
 */
test.describe('signing in', () => {
  test('lands on a real workspace, not a 404', async ({ page }) => {
    await signIn(page)

    expect(page.url()).toMatch(/\/w\/[0-9a-f-]+\/dashboard/)
    await expect(page.getByText('This page could not be found')).toHaveCount(0)
    await expectPage(page, /.+/)
  })

  test('rejects a wrong password without saying whether the account exists', async ({ page }) => {
    await page.goto('/login')
    await page.getByLabel('Email').fill(DEMO.email)
    await page.getByLabel('Password').fill('definitely-not-the-password')
    await page.getByRole('button', { name: 'Sign in' }).click()

    // Filtered, because Next's route announcer is also role="alert" and an
    // unfiltered locator matches two elements on every page.
    const message = page.getByRole('alert').filter({ hasText: /do not match/i })
    await expect(message).toBeVisible()
    // The same wording for a wrong password and an unknown address. Anything
    // that distinguishes them turns login into an enumeration oracle.
    await expect(message).toContainText(/do not match/i)
    expect(page.url()).toContain('/login')
  })

  test('rejects an unknown address with the SAME message', async ({ page }) => {
    await page.goto('/login')
    await page.getByLabel('Email').fill('nobody-at-all@demo.local')
    await page.getByLabel('Password').fill('whatever')
    await page.getByRole('button', { name: 'Sign in' }).click()

    await expect(page.getByRole('alert').filter({ hasText: /do not match/i })).toBeVisible()
  })

  test('an anonymous visitor is sent to sign in, not shown the app', async ({ page }) => {
    await page.goto('/')
    await page.waitForURL(/\/login/, { timeout: 20_000 })
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible()
  })

  test('the reset link is reachable and honest about mail delivery', async ({ page }) => {
    await page.goto('/login')
    await page.getByRole('link', { name: /forgot your password/i }).click()
    await page.waitForURL(/\/forgot-password/)

    // With no SMTP configured the page must say so BEFORE the form. Letting
    // someone submit into a void and then wait is the worst ordering.
    await expect(page.getByRole('button', { name: /send reset link/i })).toBeVisible()
  })

  test('signing out actually ends the session', async ({ page }) => {
    await signIn(page)
    await page.getByRole('button', { name: /sign out/i }).click()
    await page.waitForURL(/\/login/, { timeout: 20_000 })

    // Going back must not resurrect the session from cache.
    await page.goto('/')
    await page.waitForURL(/\/login/, { timeout: 20_000 })
  })
})
