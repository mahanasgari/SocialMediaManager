import { defineConfig, devices } from '@playwright/test'

/**
 * End-to-end tests against the real stack.
 *
 * Everything below runs through a browser against a running API, worker and
 * database. That is the point: 1034 unit tests did not catch a sign-in that
 * landed on a 404, a nav that highlighted the wrong section, or a button that
 * threw at runtime, because none of those cross a process boundary.
 *
 * The servers are NOT started here. They need Postgres, Redis, MinIO and a
 * seeded database, and a webServer block that silently starts a half-configured
 * app produces failures that look like product bugs. `pnpm e2e` brings the
 * stack up first and says so when it cannot.
 */
export default defineConfig({
  testDir: './e2e',
  // Generous, because a cold Next dev server compiles a route on first visit
  // and the first navigation to each page genuinely takes seconds.
  timeout: 60_000,
  expect: { timeout: 10_000 },

  // Serial by default. These tests share one seeded database and one demo
  // account; running them in parallel means one test's published post is
  // another's unexpected row.
  workers: 1,
  fullyParallel: false,

  // Never in CI: a passing suite that only passes on the second attempt is a
  // flaky suite reported as green.
  retries: 0,
  forbidOnly: !!process.env['CI'],

  reporter: process.env['CI'] ? [['list'], ['html', { open: 'never' }]] : [['list']],

  use: {
    baseURL: process.env['E2E_BASE_URL'] ?? 'http://localhost:3000',
    // Kept only for failures. A trace per passing test is gigabytes nobody reads.
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
