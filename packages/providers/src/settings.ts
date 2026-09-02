/**
 * Operator-supplied connector credentials.
 *
 * Every adapter used to read `process.env` directly, which meant adding a Meta
 * app required shell access and a restart. For something that ships as a
 * self-hosted web application with an admin console, that is the wrong answer:
 * the person who can administer the installation is by definition sitting in a
 * browser.
 *
 * So adapters ask HERE instead, and this consults two sources in order:
 *
 *   1. Values an administrator saved through the UI, held in memory and
 *      refreshed from the database.
 *   2. The environment, unchanged.
 *
 * The environment is a FALLBACK rather than a legacy path. A deployment that
 * injects secrets from a vault or a Kubernetes secret should keep doing that —
 * those setups are more secure than a database column, not less — and this must
 * not force them into a worse one. What the UI adds is an option for the
 * installation that has no such machinery.
 *
 * Precedence is UI over environment, deliberately. An administrator who types a
 * new value into a form and sees nothing change has been lied to, and would
 * have no way to discover why.
 */

type SettingMap = Readonly<Record<string, string>>

let overrides: SettingMap = {}
let loadedAt: number | null = null

/**
 * The value for a key, or undefined.
 *
 * Empty strings are treated as absent. A cleared form field arrives as `''`,
 * and an empty client secret is not a credential — it is the absence of one,
 * and `isConfigured()` must say so rather than reporting a configured provider
 * that fails at the first call.
 */
export function providerSetting(key: string): string | undefined {
  const stored = overrides[key]
  if (stored) return stored

  const fromEnv = process.env[key]
  return fromEnv ? fromEnv : undefined
}

/** Replaces the stored values wholesale. Called after loading from the database. */
export function setProviderSettings(values: Record<string, string>): void {
  const cleaned: Record<string, string> = {}
  for (const [key, value] of Object.entries(values)) {
    if (typeof value === 'string' && value.length > 0) cleaned[key] = value
  }
  overrides = Object.freeze(cleaned)
  loadedAt = Date.now()
}

/** How long since the stored values were last refreshed, in ms. Null if never. */
export function settingsAge(): number | null {
  return loadedAt === null ? null : Date.now() - loadedAt
}

/** Test helper, and the reset a process needs if it drops its database. */
export function clearProviderSettings(): void {
  overrides = {}
  loadedAt = null
}

/**
 * Every key an administrator may set, and what it is for.
 *
 * Declared here rather than inferred from the adapters, for two reasons. The
 * settings form has to render something before any value exists, so it needs
 * the list up front. And an allowlist means a write endpoint cannot be used to
 * set arbitrary process configuration — without it, `PUT /settings/DATABASE_URL`
 * would be a perfectly reasonable-looking request.
 */
export type ProviderSettingDescriptor = {
  readonly key: string
  readonly provider: string
  readonly label: string
  readonly secret: boolean
  readonly help?: string
}

const KEYS = [
  {
    key: 'META_APP_ID',
    provider: 'facebook',
    label: 'Meta app ID',
    secret: false,
    help: 'One Meta app serves both Facebook Pages and Instagram — Instagram Business accounts are reached through a Page.',
  },
  {
    key: 'META_APP_SECRET',
    provider: 'facebook',
    label: 'Meta app secret',
    secret: true,
    help: 'Also verifies inbound webhook signatures, so comments and messages need it too.',
  },
  {
    key: 'INSTAGRAM_APP_ID',
    provider: 'instagramLogin',
    label: 'Instagram app ID',
    secret: false,
    help: 'NOT the Meta app ID. Find it under Products > Instagram > API setup with Instagram login — connecting an Instagram account directly uses its own app credentials.',
  },
  {
    key: 'INSTAGRAM_APP_SECRET',
    provider: 'instagramLogin',
    label: 'Instagram app secret',
    secret: true,
    help: 'From the same panel as the Instagram app ID. Publishing, comments and insights each need Meta App Review before anyone outside your test users can connect.',
  },
  {
    key: 'PINTEREST_APP_ID',
    provider: 'pinterest',
    label: 'Pinterest app ID',
    secret: false,
    help: 'On Trial access, pins created through the API are visible only to you.',
  },
  {
    key: 'PINTEREST_APP_SECRET',
    provider: 'pinterest',
    label: 'Pinterest app secret',
    secret: true,
  },
  {
    key: 'GOOGLE_CLIENT_ID',
    provider: 'youtube',
    label: 'Google client ID',
    secret: false,
    help: 'A Google Cloud project with the YouTube Data API enabled.',
  },
  {
    key: 'GOOGLE_CLIENT_SECRET',
    provider: 'youtube',
    label: 'Google client secret',
    secret: true,
  },
  {
    key: 'TIKTOK_CLIENT_KEY',
    provider: 'tiktok',
    label: 'TikTok client key',
    secret: false,
    help: 'TikTok calls it a client KEY, not an ID. Posts stay private until your app passes their audit.',
  },
  {
    key: 'TIKTOK_CLIENT_SECRET',
    provider: 'tiktok',
    label: 'TikTok client secret',
    secret: true,
  },
  {
    key: 'LINKEDIN_CLIENT_ID',
    provider: 'linkedin',
    label: 'LinkedIn client ID',
    secret: false,
    help: 'Add the Share on LinkedIn and Sign In with LinkedIn products to your app. No review needed for personal profiles.',
  },
  {
    key: 'LINKEDIN_CLIENT_SECRET',
    provider: 'linkedin',
    label: 'LinkedIn client secret',
    secret: true,
  },
  {
    key: 'TELEGRAM_WEBHOOK_SECRET',
    provider: 'telegram',
    label: 'Telegram webhook secret',
    secret: true,
    help: 'Only needed to RECEIVE messages. Publishing works without it.',
  },
] as const satisfies ReadonlyArray<ProviderSettingDescriptor>

/**
 * Widened to the descriptor type on export, deliberately.
 *
 * `as const` infers a union in which entries without a `help` line have no
 * such property AT ALL, so every consumer reading `entry.help` fails to
 * compile — for the entries where it would simply be undefined. Annotating the
 * export makes the field uniformly optional while KEYS above keeps the literal
 * key types that ProviderSettingKey is derived from.
 */
export const PROVIDER_SETTING_KEYS: readonly ProviderSettingDescriptor[] = KEYS

export type ProviderSettingKey = (typeof KEYS)[number]['key']

export function isProviderSettingKey(key: string): key is ProviderSettingKey {
  return PROVIDER_SETTING_KEYS.some((entry) => entry.key === key)
}

/**
 * Where a value is coming from, for the settings screen.
 *
 * The distinction is worth surfacing. An administrator who sees a provider
 * working, finds the form empty, and types a value into it has just overridden
 * something they did not know was there — and if they then clear the field,
 * the provider keeps working for a reason nothing on screen explains.
 */
export function settingSource(key: string): 'ui' | 'environment' | 'unset' {
  if (overrides[key]) return 'ui'
  if (process.env[key]) return 'environment'
  return 'unset'
}
