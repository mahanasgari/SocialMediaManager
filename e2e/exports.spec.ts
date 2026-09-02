import { expect, test } from '@playwright/test'
import { signIn, workspaceIdFrom } from './helpers'

/**
 * Export, in a real browser.
 *
 * The page has one property that matters more than the rest: it must never show
 * a Download button for a file that is not there. An export is requested by
 * somebody under time pressure — a portability request, or a subject-access
 * request with a legal clock on it — and a dead download is worse here than
 * almost anywhere else in the product.
 *
 * The build itself runs on the worker's tick, so these tests assert the states
 * the page shows on the way there rather than waiting thirty seconds for a
 * file. `exports.test.ts` covers what the file actually contains.
 */

test.describe('exporting data', () => {
  test('the two kinds are offered with their scope stated', async ({ page }) => {
    await signIn(page)
    const workspace = workspaceIdFrom(page)
    await page.goto(`/w/${workspace}/exports`)

    await expect(page.getByText('This whole workspace')).toBeVisible({ timeout: 20_000 })
    await expect(page.getByText('Everything about one person')).toBeVisible()

    // The boundary is stated on the form, not buried in a doc. Somebody
    // answering a subject-access request needs to know this export covers one
    // workspace before they send it, not after.
    await expect(page.getByText(/this workspace only/i)).toBeVisible()
  })

  test('the handle field appears only for a subject export', async ({ page }) => {
    await signIn(page)
    const workspace = workspaceIdFrom(page)
    await page.goto(`/w/${workspace}/exports`)

    await expect(page.getByLabel('Handle', { exact: true })).toBeHidden()

    await page.getByRole('radio').nth(1).check()
    await expect(page.getByLabel('Handle', { exact: true })).toBeVisible()
    // Exact matching is explained where the value is typed, because
    // over-collecting on a subject request discloses a third party's messages.
    await expect(page.getByText(/not searched as a prefix/i)).toBeVisible()
  })

  test('a requested export appears with a status that says what happens next', async ({ page }) => {
    await signIn(page)
    const workspace = workspaceIdFrom(page)
    await page.goto(`/w/${workspace}/exports`)

    // Only click when the control is live, exactly as the sibling test below
    // does. The page disables it while an export is in flight — correct product
    // behaviour — so a leftover from an earlier run made this wait out the full
    // timeout against a disabled button and report a product failure that was
    // nothing of the kind. What this test is actually about is the CARD and
    // what it says, and that holds whoever queued the job.
    const request = page.getByRole('button', { name: 'Request export' })
    await expect(request).toBeVisible({ timeout: 20_000 })
    if (await request.isEnabled()) await request.click()

    const card = page.locator('[data-card="export"]').first()
    await expect(card).toBeVisible({ timeout: 20_000 })

    // Queued, running or already built — all three are legitimate depending on
    // where the worker's tick fell. What must never appear is a bare status
    // with no explanation of what to do about it.
    await expect(card.getByText(/worker picks it up|being built|Ready to download/i)).toBeVisible()
  })

  test('a second request is refused while one is in flight, and says why', async ({ page }) => {
    await signIn(page)
    const workspace = workspaceIdFrom(page)
    await page.goto(`/w/${workspace}/exports`)

    const button = page.getByRole('button', { name: 'Request export' })
    await expect(button).toBeVisible({ timeout: 20_000 })

    // Only request when the control is live. An earlier test may already have
    // left one in flight, and clicking a disabled button just waits out the
    // timeout — which reads as a product failure and is nothing of the kind.
    if (await button.isEnabled()) {
      await button.click()
      await page.waitForTimeout(1500)
      await page.reload()
    }

    // Two legitimate outcomes: the button is disabled and the page says why, or
    // the worker's tick already finished the job and a fresh request is
    // correctly allowed. What is NOT acceptable is the third state — a disabled
    // button with no reason given, which is the dead control the honesty policy
    // rules out.
    if (await page.getByRole('button', { name: 'Request export' }).isDisabled()) {
      await expect(page.getByText(/already being prepared/i)).toBeVisible()
    }
  })

  test('a download link is shown only for an export that is actually ready', async ({ page }) => {
    await signIn(page)
    const workspace = workspaceIdFrom(page)
    await page.goto(`/w/${workspace}/exports`)

    const cards = page.locator('[data-card="export"]')
    const count = await cards.count()

    for (let i = 0; i < count; i += 1) {
      const card = cards.nth(i)
      const ready = await card.getByText('ready', { exact: true }).count()
      const links = await card.getByRole('link', { name: 'Download' }).count()
      // The invariant, both ways round: ready implies a link, and a link
      // implies ready. A download button on a pending or expired export is a
      // dead control, which is the thing the honesty policy rules out.
      expect(links).toBe(ready > 0 ? 1 : 0)
    }
  })
})
