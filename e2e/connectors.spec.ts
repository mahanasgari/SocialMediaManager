import { expect, test } from '@playwright/test'
import { signIn, workspaceIdFrom } from './helpers'

/**
 * The honesty policy, enforced in the browser.
 *
 * "Do not create pages whose functionality does not work" and "never claim
 * unsupported functionality" are the two rules most easily broken by accident,
 * because a disabled button and a working one look nearly identical in code
 * review. These tests check what a user can actually click.
 */
test.describe('connector honesty', () => {
  test('unbuilt connectors are visible, disabled, and say why', async ({ page }) => {
    await signIn(page)
    const workspace = workspaceIdFrom(page)
    await page.goto(`/w/${workspace}/accounts`)

    // Present, not hidden. Someone looking for a connector we have not built
    // should find out why, rather than concluding the product does not support
    // it at all.
    const snapchat = page.getByTestId('provider-snapchat')
    await expect(snapchat).toBeVisible({ timeout: 20_000 })
    await expect(snapchat.getByText(/partner|restricted|not implemented|review/i)).toBeVisible()
  })

  test('a skeleton cannot be connected even by a hand-crafted request', async ({ page }) => {
    await signIn(page)
    const workspace = workspaceIdFrom(page)

    // The UI disables the control; the server must refuse independently. A
    // disabled button is a suggestion, not a boundary.
    // page.request, not the bare `request` fixture: that one is a separate
    // context with no session cookie, so every call is a 401 and the test
    // proves nothing about the refusal it claims to check.
    const response = await page.request.post('/api/v1/social-accounts/connect/snapchat', {
      headers: { 'x-smm-client': 'web', origin: 'http://localhost:3000' },
      data: { workspaceId: workspace },
      failOnStatusCode: false,
    })

    expect(response.status()).toBe(422)
    const body = (await response.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('provider_not_implemented')
    expect(body.error.message).toMatch(/not implemented/i)
  })

  test('a connector that WORKS but may reach nobody says so before you connect', async ({
    page,
  }) => {
    await signIn(page)
    const workspace = workspaceIdFrom(page)
    await page.goto(`/w/${workspace}/accounts`)

    // The hardest case in the honesty policy, and why `notice` exists next to
    // `disabledReason`. Pinterest on Trial access and TikTok without an audit
    // both PUBLISH SUCCESSFULLY and reach nobody: an id comes back, nothing
    // errors, and a month of scheduled content is quietly wasted. Neither is
    // disabled, because both genuinely work — so the caveat has to be said
    // before anyone schedules against them.
    const pinterest = page.getByTestId('provider-pinterest')
    await expect(pinterest.getByText(/visible only to you/i)).toBeVisible({ timeout: 20_000 })

    const tiktok = page.getByTestId('provider-tiktok')
    await expect(tiktok.getByText(/audit/i)).toBeVisible()
  })

  test('a connector with no such caveat carries no notice', async ({ page }) => {
    // The field has to stay meaningful. If every provider carried a warning,
    // nobody would read any of them.
    await signIn(page)
    const workspace = workspaceIdFrom(page)
    await page.goto(`/w/${workspace}/accounts`)

    const telegram = page.getByTestId('provider-telegram')
    await expect(telegram).toBeVisible({ timeout: 20_000 })
    await expect(telegram.getByText(/audit|visible only to you|sandbox/i)).toHaveCount(0)
  })

  test('a provider needing operator credentials says THAT, not "not built"', async ({ page }) => {
    await signIn(page)
    const workspace = workspaceIdFrom(page)
    await page.goto(`/w/${workspace}/accounts`)

    // Two different disabled states that must never be conflated: one the
    // operator can fix by pasting a client id, one they cannot fix at all.
    // Facebook is implemented and simply has no credentials on this install.
    const facebook = page.getByTestId('provider-facebook')
    await expect(facebook.getByText(/not configured/i)).toBeVisible({ timeout: 20_000 })
    await expect(facebook.getByText(/not implemented|not built/i)).toHaveCount(0)
  })

  test('implemented connectors that use credentials show a form, not a dead button', async ({
    page,
  }) => {
    await signIn(page)
    const workspace = workspaceIdFrom(page)
    await page.goto(`/w/${workspace}/accounts`)

    // Bluesky and Telegram have no redirect to send anyone to. Before the
    // connect form existed they sat behind a Connect button that could never
    // work — the exact dead control the policy rules out.
    //
    // The fields are revealed by the Connect button rather than shown inline,
    // so the test has to open one. Asserting on the collapsed card would only
    // prove the card exists.
    const bluesky = page.getByTestId('provider-bluesky')
    await bluesky.getByRole('button', { name: 'Connect' }).click()

    await expect(bluesky.getByLabel('Handle')).toBeVisible({ timeout: 15_000 })
    // The hint says where to GET the value, not what it is. "An app password is
    // a password for an app" helps nobody.
    await expect(bluesky.getByText(/App passwords/i)).toBeVisible()

    // Telegram is the other credentials provider, and its hint names the exact
    // place to get a bot token.
    const telegram = page.getByTestId('provider-telegram')
    await telegram.getByRole('button', { name: 'Connect' }).click()
    await expect(telegram.getByText(/BotFather/i)).toBeVisible({ timeout: 15_000 })
  })

  test('Mastodon asks for an instance, because there is no global Mastodon', async ({ page }) => {
    await signIn(page)
    const workspace = workspaceIdFrom(page)
    await page.goto(`/w/${workspace}/accounts`)

    const mastodon = page.getByTestId('provider-mastodon')
    await mastodon.getByRole('button', { name: 'Connect' }).click()

    // An OAuth provider that still needs a field first: the authorize URL lives
    // on a specific server and the app is registered there at connect time.
    await expect(mastodon.getByLabel('Instance')).toBeVisible({ timeout: 15_000 })
    await expect(mastodon.getByText(/the server your account is on/i)).toBeVisible()
  })

  test('the roster is served from the registry, not a hard-coded list', async ({ page }) => {
    await signIn(page)
    const response = await page.request.get('/api/v1/social-providers')
    expect(response.ok()).toBe(true)

    const providers = (await response.json()) as Array<{
      id: string
      state: string
      disabledReason: string | null
      notice: string | null
    }>

    // Every provider is in exactly one declared state, and every disabled one
    // carries a reason. A disabled provider with no reason is a dead end.
    expect(providers.length).toBeGreaterThan(20)
    for (const provider of providers) {
      expect(['implemented', 'skeleton', 'mock']).toContain(provider.state)
      if (provider.state === 'skeleton') {
        expect(provider.disabledReason, `${provider.id} is disabled with no reason`).toBeTruthy()
      }
    }

    // The five the roadmap prioritised are built, not documented intentions.
    for (const id of ['facebook', 'instagram', 'pinterest', 'youtube', 'tiktok']) {
      expect(providers.find((p) => p.id === id)?.state, `${id} should be implemented`).toBe(
        'implemented'
      )
    }
  })
})
