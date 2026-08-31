import { z } from 'zod'

/**
 * Environment schema. Parsed once at boot; a failure exits the process with a
 * message naming the offending variables rather than surfacing later as a
 * confusing runtime error.
 *
 * Two rules encoded here that are decisions, not defaults:
 *
 *  1. Secrets must be real. A missing, short, or example-valued ENCRYPTION_KEY
 *     refuses to boot. An encrypted-at-rest guarantee that silently degrades to
 *     a known key is worse than no guarantee.
 *
 *  2. Insecure cookies must be opted into. `__Host-` requires Secure, which
 *     requires TLS, and localhost is exempt — so a naive implementation passes
 *     in development and fails on the first LAN deploy. Rather than fail
 *     mysteriously or downgrade silently, an http:// non-localhost PUBLIC_URL
 *     refuses to boot without ALLOW_INSECURE_COOKIES.
 */

/** Values shipped in .env.example. Present means the operator did not set one. */
const PLACEHOLDER_SECRETS = new Set(['', 'changeme', 'CHANGEME', 'your-key-here'])

const base64Secret = (name: string) =>
  z
    .string()
    .refine((v) => !PLACEHOLDER_SECRETS.has(v), {
      message: `${name} is unset or still the example value. Generate one: openssl rand -base64 32`,
    })
    .refine((v) => Buffer.from(v, 'base64').length >= 32, {
      message: `${name} must decode to at least 32 bytes. Generate one: openssl rand -base64 32`,
    })

const bool = z
  .enum(['true', 'false'])
  .transform((v) => v === 'true')

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

    // --- infrastructure ---
    // The application connects as an UNPRIVILEGED role. Superusers bypass
    // row-level security unconditionally, so connecting as the owner would
    // make every tenant-isolation policy silently inert. assertRlsApplies()
    // refuses to boot if it detects otherwise.
    DATABASE_URL: z.string().url(),
    /** Owner credentials. Used only by the one-shot migrate service. */
    MIGRATE_DATABASE_URL: z.string().url().optional(),
    /**
   * SMTP connection string, e.g. smtp://user:pass@host:587.
   *
   * OPTIONAL, and its absence is a supported configuration rather than an
   * error: plenty of self-hosted deployments have no mail server. Without it,
   * password-reset and verification links are written to the SERVER LOG and the
   * UI says so — never silently discarded, and never presented as if an email
   * were on its way.
   */
  SMTP_URL: z.string().min(1).optional(),

  /** The From address. Only meaningful when SMTP_URL is set. */
  MAIL_FROM: z.string().email().optional(),

  REDIS_URL: z.string().url(),

    // --- secrets ---
    ENCRYPTION_KEY: base64Secret('ENCRYPTION_KEY'),
    /** Set only during rotation; the old KEK stays readable until re-wrapping completes. */
    ENCRYPTION_KEY_PREVIOUS: z.string().optional(),
    SESSION_SECRET: base64Secret('SESSION_SECRET'),

    // --- URLs ---
    PUBLIC_URL: z.string().url(),
    INTERNAL_API_URL: z.string().url(),
    ALLOW_INSECURE_COOKIES: bool.default('false'),

    // --- object storage ---
    S3_ENDPOINT: z.string().url(),
    S3_REGION: z.string().min(1).default('us-east-1'),
    S3_BUCKET: z.string().min(1),
    S3_ACCESS_KEY_ID: z.string().min(1),
    S3_SECRET_ACCESS_KEY: z.string().min(1),
    S3_FORCE_PATH_STYLE: bool.default('true'),
    MEDIA_PUBLIC_MODE: z.enum(['presigned-s3', 'relay', 'disabled']).default('relay'),

    // --- behaviour ---
    AUTH_REGISTRATION: z.enum(['open', 'invite', 'closed']).default('invite'),
    INBOUND_MODE: z.enum(['poll', 'webhook', 'auto']).default('auto'),
    CATCHUP_WINDOW_MINUTES: z.coerce.number().int().positive().default(60),
    WORKSPACE_PURGE_GRACE_DAYS: z.coerce.number().int().positive().default(30),
    INBOX_RETENTION_DAYS: z.coerce.number().int().positive().optional(),

    // --- observability ---
    /**
     * Bearer token required by GET /api/v1/metrics.
     *
     * Optional, because an unauthenticated scrape on a private network is a
     * legitimate setup and refusing it outright would be hostile. Left unset on
     * an internet-facing deployment the API warns on every boot — the same
     * shape as ALLOW_INSECURE_COOKIES, and for the same reason: a property that
     * disappears without saying so is worse than either explicit choice.
     */
    METRICS_TOKEN: z.string().min(16).optional(),

    // --- connector credentials ---
    //
    // Each is optional, and absence means the connector reports itself
    // UNCONFIGURED rather than broken. That distinction reaches the UI: a
    // provider nobody has given credentials for is disabled for a different
    // reason than one that is not built yet, and the person looking at the
    // screen needs to know which — one they can fix, one they cannot.
    /** Facebook Pages and Instagram share one Meta app. */
    META_APP_ID: z.string().min(1).optional(),
    META_APP_SECRET: z.string().min(1).optional(),
    PINTEREST_APP_ID: z.string().min(1).optional(),
    PINTEREST_APP_SECRET: z.string().min(1).optional(),
    /** YouTube. A Google Cloud project, not a YouTube-specific credential. */
    GOOGLE_CLIENT_ID: z.string().min(1).optional(),
    GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),
    /** TikTok calls it a client KEY, not an id. */
    TIKTOK_CLIENT_KEY: z.string().min(1).optional(),
    TIKTOK_CLIENT_SECRET: z.string().min(1).optional(),
    /** LinkedIn personal profiles. Company Pages need a separate, reviewed app. */
    LINKEDIN_CLIENT_ID: z.string().min(1).optional(),
    LINKEDIN_CLIENT_SECRET: z.string().min(1).optional(),
  })
  .superRefine((env, ctx) => {
    const url = new URL(env.PUBLIC_URL)
    const isHttps = url.protocol === 'https:'
    const isLocal = url.hostname === 'localhost' || url.hostname === '127.0.0.1'

    if (!isHttps && !isLocal && !env.ALLOW_INSECURE_COOKIES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['PUBLIC_URL'],
        message:
          `PUBLIC_URL is http:// on a non-localhost host (${url.hostname}). Secure cookies ` +
          `require TLS, so sessions cannot be protected. Either serve over HTTPS, or set ` +
          `ALLOW_INSECURE_COOKIES=true to accept the risk explicitly.`,
      })
    }
  })

export type Env = z.infer<typeof envSchema>

export type CookiePolicy = {
  /** `__Host-` is only legal alongside Secure, Path=/ and no Domain attribute. */
  name: string
  secure: boolean
  /** Non-null when the operator opted out of TLS; the caller must log it on every boot. */
  warning: string | null
}

/**
 * Derives the cookie policy from PUBLIC_URL. Kept beside the schema so the
 * decision lives in one place rather than being re-derived at each call site.
 */
export function cookiePolicy(env: Env): CookiePolicy {
  const url = new URL(env.PUBLIC_URL)
  const isHttps = url.protocol === 'https:'
  const isLocal = url.hostname === 'localhost' || url.hostname === '127.0.0.1'

  if (isHttps) return { name: '__Host-smm_session', secure: true, warning: null }
  if (isLocal) return { name: 'smm_session', secure: false, warning: null }

  return {
    name: 'smm_session',
    secure: false,
    warning:
      'INSECURE COOKIES: sessions are being served over plain HTTP without the Secure ' +
      'flag, because ALLOW_INSECURE_COOKIES=true. Anyone on the network path can read ' +
      'session cookies. Do not use this configuration on an untrusted network.',
  }
}

let cached: Env | undefined

/** Parse and cache. Throws a formatted, actionable error on failure. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (cached) return cached

  const parsed = envSchema.safeParse(source)
  if (!parsed.success) {
    const lines = parsed.error.issues.map(
      (i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`
    )
    throw new Error(
      `Invalid environment configuration:\n${lines.join('\n')}\n\n` +
        `See .env.example for the documented set.`
    )
  }

  cached = parsed.data
  return cached
}

/** Test-only. Production code should never need to discard the cache. */
export function resetEnvCache(): void {
  cached = undefined
}
