import { expect, test } from '@playwright/test'
import { signIn, workspaceIdFrom } from './helpers'

/**
 * Campaigns, labels, templates and UTM presets, in a real browser.
 *
 * The two previews are what these tests are really for. Both compute something
 * the author is about to publish, and both have a wrong answer that looks
 * plausible — a template rendered with a blank where a name should be, a link
 * carrying `utm_source={{network}}` into someone else's analytics. Neither is
 * visible in a unit test of the page.
 */

/** A name unique per run, so a re-run does not collide with its own leftovers. */
const unique = (prefix: string) => `${prefix} ${Date.now().toString(36)}`

test.describe('organising content', () => {
  test('a campaign is created and appears with its post count', async ({ page }) => {
    await signIn(page)
    const workspace = workspaceIdFrom(page)
    await page.goto(`/w/${workspace}/organise`)

    const name = unique('Campaign')
    await page.getByLabel('Campaign name').fill(name)
    await page.getByRole('button', { name: 'Create campaign' }).click()

    const card = page.locator('[data-card]').filter({ hasText: name })
    await expect(card).toBeVisible({ timeout: 15_000 })
    // Zero posts is shown as "0 posts", not hidden. A new campaign with nothing
    // in it should look empty rather than look broken.
    await expect(card.getByText(/0 posts/)).toBeVisible()
  })

  test('a duplicate campaign name is refused with a message that names it', async ({ page }) => {
    await signIn(page)
    const workspace = workspaceIdFrom(page)
    await page.goto(`/w/${workspace}/organise`)

    const name = unique('Duplicate')
    for (let i = 0; i < 2; i += 1) {
      await page.getByLabel('Campaign name').fill(name)
      await page.getByRole('button', { name: 'Create campaign' }).click()
      await page.waitForTimeout(1500)
    }

    await expect(page.getByRole('alert').filter({ hasText: /already exists/ })).toBeVisible({
      timeout: 15_000,
    })
  })

  test('a template reports what is still unfilled rather than publishing a hole', async ({
    page,
  }) => {
    await signIn(page)
    const workspace = workspaceIdFrom(page)
    await page.goto(`/w/${workspace}/organise`)
    await page.getByRole('tab', { name: 'Templates' }).click()

    const name = unique('Template')
    await page.getByLabel('Template name').fill(name)
    await page.getByLabel('Body').fill('New post: {{title}} at {{url}}')

    // The variables are extracted as you type, before saving.
    await expect(page.getByText('Will ask for: title, url')).toBeVisible()

    await page.getByRole('button', { name: 'Save template' }).click()

    const card = page.locator('[data-card]').filter({ hasText: name })
    await expect(card).toBeVisible({ timeout: 15_000 })

    // Fill only one of the two, then preview.
    await card.getByLabel('title', { exact: true }).fill('Crash recovery')
    await card.getByRole('button', { name: 'Preview' }).click()

    // The missing one is NAMED, and the placeholder is still visible in the
    // output — not blanked, which is the same failure wearing a disguise.
    await expect(card.getByText(/Still needs url/)).toBeVisible({ timeout: 15_000 })
    await expect(card.getByTestId('render-output')).toContainText('{{url}}')
  })

  test('a UTM preset tags links and leaves the author’s own parameters alone', async ({ page }) => {
    await signIn(page)
    const workspace = workspaceIdFrom(page)
    await page.goto(`/w/${workspace}/organise`)
    await page.getByRole('tab', { name: 'UTM presets' }).click()

    const name = unique('Preset')
    await page.getByLabel('Preset name').fill(name)
    await page.getByRole('button', { name: 'Save preset' }).click()

    const card = page.locator('[data-card]').filter({ hasText: name })
    await expect(card).toBeVisible({ timeout: 15_000 })

    await card
      .getByLabel('Try it')
      .fill('One https://example.com/a and two https://example.com/b?utm_source=newsletter')
    await card.getByLabel('network').fill('bluesky')
    await card.getByRole('button', { name: 'Apply' }).click()

    // The first link is tagged with the resolved network name.
    await expect(card.getByTestId('utm-output')).toContainText('utm_source=bluesky', { timeout: 15_000 })
    // The second keeps what the author wrote. A workspace default silently
    // replacing a deliberate choice corrupts attribution quietly.
    await expect(card.getByTestId('utm-output')).toContainText('utm_source=newsletter')
  })

  test('a preset with no value for a variable omits the parameter, and says so', async ({
    page,
  }) => {
    await signIn(page)
    const workspace = workspaceIdFrom(page)
    await page.goto(`/w/${workspace}/organise`)
    await page.getByRole('tab', { name: 'UTM presets' }).click()

    const name = unique('Unresolved')
    await page.getByLabel('Preset name').fill(name)
    await page.getByLabel('utm_campaign').fill('{{campaign}}')
    await page.getByRole('button', { name: 'Save preset' }).click()

    const card = page.locator('[data-card]').filter({ hasText: name })
    await expect(card).toBeVisible({ timeout: 15_000 })

    await card.getByLabel('Try it').fill('See https://example.com/p')
    await card.getByLabel('network').fill('mastodon')
    // `campaign` deliberately left blank.
    await card.getByRole('button', { name: 'Apply' }).click()

    await expect(card.getByText(/No value for campaign/)).toBeVisible({ timeout: 15_000 })
    // The parameter is absent, not written as literal template syntax into
    // somebody else's analytics where we cannot clean it up.
    await expect(card.getByText(/utm_campaign/)).toHaveCount(1) // the preset's own row only
  })

  test('a label is created and shows how many posts carry it', async ({ page }) => {
    await signIn(page)
    const workspace = workspaceIdFrom(page)
    await page.goto(`/w/${workspace}/organise`)
    await page.getByRole('tab', { name: 'Labels' }).click()

    const name = unique('Label')
    await page.getByLabel('Label name').fill(name)
    await page.getByRole('button', { name: 'Add label' }).click()

    const card = page.locator('[data-card]').filter({ hasText: name })
    await expect(card).toBeVisible({ timeout: 15_000 })
    // Zero, shown rather than hidden — a new label with no posts is not broken.
    //
    // exact, because the generated name carries a base-36 suffix that sometimes
    // contains a digit. Without it this passed or failed depending on the
    // clock, which is the worst kind of test: green most of the time.
    await expect(card.getByText('0', { exact: true })).toBeVisible()
  })
})
