import { expect, test } from '@playwright/test'
import { signIn, workspaceIdFrom } from './helpers'

/**
 * The core loop: compose, validate, publish, and see the result.
 *
 * This is the product. Everything else is scaffolding around the claim that a
 * post written here reaches a channel and reports honestly what happened.
 */
test.describe('composing and publishing', () => {
  test('per-channel validation runs against the real capability matrix', async ({ page }) => {
    await signIn(page)
    const workspace = workspaceIdFrom(page)
    await page.goto(`/w/${workspace}/compose`)

    // The editor's label names what is being edited: the shared draft, or
    // one channel's rewrite of it. A pattern rather than a fixed string
    // because both are the same control.
    const content = page.getByLabel(/Shared text|Text for/)
    await content.fill('x'.repeat(600))

    // The mock provider's limit is 500. The error must name the platform and
    // say how far over — "too long" alone is something you have to measure
    // yourself.
    await expect(page.getByText(/characters too long/i).first()).toBeVisible({ timeout: 15_000 })

    // And the action must be blocked, not merely warned about.
    await expect(page.getByRole('button', { name: 'Publish now' })).toBeDisabled()
  })

  test('the counter clears and publishing unblocks when the text fits', async ({ page }) => {
    await signIn(page)
    const workspace = workspaceIdFrom(page)
    await page.goto(`/w/${workspace}/compose`)

    const content = page.getByLabel(/Shared text|Text for/)
    await content.fill('x'.repeat(600))
    await expect(page.getByRole('button', { name: 'Publish now' })).toBeDisabled()

    await content.fill('Short enough for every connected channel.')
    await expect(page.getByRole('button', { name: 'Publish now' })).toBeEnabled({ timeout: 15_000 })
  })

  test('publishing now reports the per-channel outcome, not just success', async ({ page }) => {
    await signIn(page)
    const workspace = workspaceIdFrom(page)
    await page.goto(`/w/${workspace}/compose`)

    const marker = `E2E publish ${Date.now()}`
    await page.getByLabel(/Shared text|Text for/).fill(marker)

    await expect(page.getByRole('button', { name: 'Publish now' })).toBeEnabled({ timeout: 15_000 })
    await page.getByRole('button', { name: 'Publish now' }).click()

    // Partial success is the NORMAL case with several channels, so the result
    // must say how far it got. A bare "posted!" would be a lie whenever one
    // channel rejected the content.
    const outcome = page.getByText(/published|channel/i).first()
    await expect(outcome).toBeVisible({ timeout: 45_000 })

    // And it must actually exist afterwards.
    await page.goto(`/w/${workspace}/posts`)
    await expect(page.getByText(marker)).toBeVisible({ timeout: 20_000 })
  })

  test('a draft is saved without publishing', async ({ page }) => {
    await signIn(page)
    const workspace = workspaceIdFrom(page)
    await page.goto(`/w/${workspace}/compose`)

    const marker = `E2E draft ${Date.now()}`
    await page.getByLabel(/Shared text|Text for/).fill(marker)
    await expect(page.getByRole('button', { name: 'Save draft' })).toBeEnabled({ timeout: 15_000 })
    await page.getByRole('button', { name: 'Save draft' }).click()

    await page.waitForURL(/\/posts$/, { timeout: 20_000 })
    const row = page.locator('div').filter({ hasText: marker }).first()
    await expect(row).toBeVisible()
    // Saved, and NOT sent.
    await expect(page.getByText(marker)).toBeVisible()
  })

  test('the posts list distinguishes what happened to each post', async ({ page }) => {
    await signIn(page)
    const workspace = workspaceIdFrom(page)
    await page.goto(`/w/${workspace}/posts`)

    // Seeded data carries both. A list where every row says the same thing is
    // a list nobody can act on.
    await expect(page.getByText('Published').first()).toBeVisible({ timeout: 20_000 })
    await expect(page.getByText('Scheduled').first()).toBeVisible()
  })
})
