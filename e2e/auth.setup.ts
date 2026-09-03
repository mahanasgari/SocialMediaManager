import { test as setup } from '@playwright/test'
import { signIn } from './helpers'

/**
 * Signs in once, for the whole suite.
 *
 * Every test used to sign in for itself: thirty-four form submissions from one
 * address inside a few minutes. The product's own IP limiter allows forty in
 * fifteen, refunding only ONE attempt per success — deliberately, so an
 * attacker holding a single valid account cannot reset the address budget and
 * spray the rest. So the suite tripped its own brute-force protection partway
 * through and every remaining test failed at the login form, reporting
 * timeouts that looked like product bugs and were the product working.
 *
 * Raising the limit for tests would have been the wrong fix twice over: it
 * weakens a real control, and it leaves the suite doing thirty-three sign-ins
 * that prove nothing after the first.
 *
 * The session is saved and reused. Sign-in ITSELF is still exercised for real —
 * here, and by auth.spec.ts, which opts out of the saved state because the form
 * is the thing it tests.
 */
setup('authenticate', async ({ page }) => {
  await signIn(page)
  await page.context().storageState({ path: '.auth/session.json' })
})
