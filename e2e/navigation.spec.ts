import { expect, test } from '@playwright/test'
import { signIn, workspaceIdFrom } from './helpers'

/**
 * Every page renders, and the shell agrees with where you are.
 *
 * The second test exists because the nav highlighted "Overview" on every page
 * for the entire life of the project: the section was read from
 * `pathname.split('/')[4]`, which is always undefined for `/w/:id/posts`. No
 * unit test could see it — it needs a real URL and a rendered sidebar.
 */
const SECTIONS = [
  'dashboard',
  'compose',
  'calendar',
  'posts',
  'inbox',
  'approvals',
  'media',
  'analytics',
  'reports',
  'links',
  'accounts',
  'integrations',
  'team',
  'settings',
  'admin',
] as const

test.describe('the application shell', () => {
  test('every section loads without a 404 or an error boundary', async ({ page }) => {
    await signIn(page)
    const workspace = workspaceIdFrom(page)

    for (const section of SECTIONS) {
      const response = await page.goto(`/w/${workspace}/${section}`)

      expect(response?.status(), `${section} returned ${response?.status()}`).toBeLessThan(400)
      await expect(
        page.getByText('This page could not be found'),
        `${section} rendered a 404`
      ).toHaveCount(0)
      await expect(
        page.getByRole('heading', { level: 1 }),
        `${section} rendered no heading`
      ).toBeVisible()
    }
  })

  test('the sidebar marks the section you are actually on', async ({ page }) => {
    await signIn(page)
    const workspace = workspaceIdFrom(page)

    for (const [section, label] of [
      ['posts', 'Posts'],
      ['inbox', 'Inbox'],
      ['analytics', 'Analytics'],
      ['settings', 'Settings'],
    ] as const) {
      await page.goto(`/w/${workspace}/${section}`)

      // aria-current is the assertion rather than a colour: it is what a screen
      // reader announces, and styling that disagrees with it is a bug either way.
      await expect(
        page.getByRole('link', { name: label }),
        `${section} did not mark ${label} as current`
      ).toHaveAttribute('aria-current', 'page')
    }
  })

  test('navigating by clicking works, not just by URL', async ({ page }) => {
    await signIn(page)

    // `exact` matters here, and the reason is worth stating: Playwright matches
    // accessible names as a case-insensitive SUBSTRING by default, so a bare
    // 'Posts' also matches the dashboard's "Open posts" banner — which appears
    // only when something failed, was missed, or is held for review. This test
    // then passed or failed according to whether an earlier run had left a
    // broken post behind, which is not what it is about.
    await page.getByRole('link', { name: 'Posts', exact: true }).click()
    await page.waitForURL(/\/posts$/)
    await expect(page.getByRole('heading', { level: 1, name: 'Posts' })).toBeVisible()

    await page.getByRole('link', { name: 'Social accounts' }).click()
    await page.waitForURL(/\/accounts$/)
  })

  test('a workspace you are not a member of is indistinguishable from one that does not exist', async ({
    page,
  }) => {
    await signIn(page)

    // A well-formed id that is not yours. The layout redirects rather than
    // revealing whether it exists — the API returns 404 for both cases and the
    // UI must not leak the difference by behaving differently.
    await page.goto('/w/00000000-0000-7000-8000-000000000000/dashboard')
    await page.waitForURL(/\/w\/[0-9a-f-]+\/dashboard|\/login/, { timeout: 20_000 })
    expect(page.url()).not.toContain('00000000-0000-7000-8000-000000000000')
  })
})
