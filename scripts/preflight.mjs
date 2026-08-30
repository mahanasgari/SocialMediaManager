#!/usr/bin/env node
/**
 * Production preflight.
 *
 * Answers one question before a deploy rather than after: is this configuration
 * one that will actually work, and does it give up any security property
 * silently?
 *
 * The env schema already refuses to boot on a missing or example secret. This
 * goes further and reports the things that are *legal* but probably not what
 * anyone intended — plain http on a public host, no mail server, storage that
 * Instagram cannot reach — each with what it costs and how to fix it.
 *
 *   node scripts/preflight.mjs           reads .env
 *   node scripts/preflight.mjs .env.prod reads a named file
 */
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'

const file = process.argv[2] ?? '.env'

/** Findings, worst first. `fail` blocks a deploy; `warn` is a judgement call. */
const findings = []
const fail = (title, detail) => findings.push({ level: 'fail', title, detail })
const warn = (title, detail) => findings.push({ level: 'warn', title, detail })
const note = (title, detail) => findings.push({ level: 'note', title, detail })

if (!existsSync(file)) {
  console.error(`\n  No ${file} found. Copy .env.example and fill it in.\n`)
  process.exit(1)
}

const env = {}
// Split on \r?\n, not \n.
//
// JavaScript's `.` does not match \r, so against a CRLF file `(.*)$` never
// reaches end-of-line and EVERY line fails to parse — which this script would
// then report as "nothing is configured". That is the most alarming possible
// way for a preflight check to be wrong, and it happened.
for (const line of (await readFile(file, 'utf8')).split(/\r?\n/)) {
  const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line)
  if (match) env[match[1]] = match[2].trim().replace(/^["']|["']$/g, '')
}

const has = (key) => typeof env[key] === 'string' && env[key].length > 0

// --- secrets ---------------------------------------------------------------

for (const key of [
  'ENCRYPTION_KEY',
  'SESSION_SECRET',
  'POSTGRES_PASSWORD',
  'APP_DB_PASSWORD',
  'REDIS_PASSWORD',
  'S3_SECRET_ACCESS_KEY',
]) {
  if (!has(key)) {
    fail(`${key} is not set`, 'Generate one with: openssl rand -base64 32')
  }
}

if (has('ENCRYPTION_KEY')) {
  const bytes = Buffer.from(env.ENCRYPTION_KEY, 'base64').length
  if (bytes !== 32) {
    fail(
      `ENCRYPTION_KEY is ${bytes} bytes, not 32`,
      'AES-256 needs exactly 32. Generate with: openssl rand -base64 32'
    )
  }
}

// Values that look like they came from a tutorial rather than from a generator.
const WEAK = new Set(['smm', 'password', 'changeme', 'secret', 'postgres', 'redis', 'minioadmin'])
for (const key of ['POSTGRES_PASSWORD', 'APP_DB_PASSWORD', 'REDIS_PASSWORD', 'S3_SECRET_ACCESS_KEY']) {
  if (has(key) && WEAK.has(env[key].toLowerCase())) {
    fail(`${key} is a default value`, 'Anything scanning the internet already knows this one.')
  }
}

// --- the single-origin invariant and TLS -----------------------------------

if (!has('PUBLIC_URL')) {
  fail('PUBLIC_URL is not set', 'It decides the cookie policy and every link in outbound mail.')
} else {
  let url
  try {
    url = new URL(env.PUBLIC_URL)
  } catch {
    fail('PUBLIC_URL is not a valid URL', `Got: ${env.PUBLIC_URL}`)
  }

  if (url) {
    const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1'

    if (url.protocol === 'https:') {
      note('Cookies are Secure and __Host- prefixed', 'The strongest posture available.')
    } else if (local) {
      note('Plain http on localhost', 'Fine for development; browsers exempt localhost.')
    } else if (env.ALLOW_INSECURE_COOKIES === 'true') {
      warn(
        'Plain http on a non-local host, insecure cookies opted into',
        'Session cookies lose Secure and the __Host- prefix, so anyone on the ' +
          'network path can read a session. Defensible on a firewalled LAN, not ' +
          'on the internet. Put TLS in front of it and remove ALLOW_INSECURE_COOKIES.'
      )
    } else {
      fail(
        'Plain http on a non-local host',
        'The API refuses to boot like this. Either serve over https, or set ' +
          'ALLOW_INSECURE_COOKIES=true to accept the loss deliberately.'
      )
    }
  }
}

// --- media reachability -----------------------------------------------------

const mode = env.MEDIA_PUBLIC_MODE ?? 'relay'
if (mode === 'disabled') {
  warn(
    'MEDIA_PUBLIC_MODE=disabled',
    'Instagram pulls media from a public URL rather than accepting an upload, ' +
      'so it is marked unavailable at boot. Every other connector still works.'
  )
} else if (mode === 'presigned-s3') {
  note(
    'MEDIA_PUBLIC_MODE=presigned-s3',
    'Storage must be reachable from the internet for platforms that pull media. ' +
      'Publish the minio port, or point S3_ENDPOINT at a hosted bucket.'
  )
} else {
  note('MEDIA_PUBLIC_MODE=relay', 'The API streams media itself; storage stays private.')
}

// --- mail -------------------------------------------------------------------

if (!has('SMTP_URL')) {
  warn(
    'No SMTP_URL',
    'Password reset and email confirmation links are written to the server log ' +
      'instead of being emailed. The sign-in page says so. Account recovery ' +
      'works only for someone who can read the logs.'
  )
} else if (!has('MAIL_FROM')) {
  warn('SMTP_URL is set but MAIL_FROM is not', 'Messages will be sent from noreply@localhost.')
}

// --- inbound webhooks -------------------------------------------------------

const inbound = ['META_WEBHOOK_VERIFY_TOKEN', 'TELEGRAM_WEBHOOK_SECRET'].filter(has)
if (inbound.length === 0) {
  note(
    'No inbound webhook secrets configured',
    'The inbox receives nothing. Publishing and analytics are unaffected. A ' +
      'provider with no secret REFUSES events rather than accepting unsigned ones.'
  )
}

// --- registration -----------------------------------------------------------

if (env.AUTH_REGISTRATION === 'open') {
  warn(
    'AUTH_REGISTRATION=open',
    'Anyone who can reach the sign-in page can create an account and an ' +
      'organization. Use `invite` for a private deployment.'
  )
}

// --- demo mode --------------------------------------------------------------

if (env.DEMO_MODE === 'true') {
  fail(
    'DEMO_MODE=true',
    'Demo data uses fixed, published credentials (owner@demo.local / demo1234). ' +
      'Never enable this on anything reachable.'
  )
}

// --- report -----------------------------------------------------------------

const ICON = { fail: '  ✗', warn: '  !', note: '  ·' }
const order = { fail: 0, warn: 1, note: 2 }
findings.sort((a, b) => order[a.level] - order[b.level])

console.log(`\n  Preflight — ${file}\n`)
for (const f of findings) {
  console.log(`${ICON[f.level]} ${f.title}`)
  for (const line of wrap(f.detail, 68)) console.log(`      ${line}`)
  console.log('')
}

const failures = findings.filter((f) => f.level === 'fail').length
const warnings = findings.filter((f) => f.level === 'warn').length

if (failures > 0) {
  console.log(`  ${failures} blocking problem${failures === 1 ? '' : 's'}. Fix before deploying.\n`)
  process.exit(1)
}
console.log(
  warnings > 0
    ? `  No blocking problems. ${warnings} thing${warnings === 1 ? '' : 's'} worth a decision.\n`
    : '  Ready.\n'
)

function wrap(text, width) {
  const words = text.split(/\s+/)
  const lines = []
  let line = ''
  for (const word of words) {
    if ((line + ' ' + word).trim().length > width) {
      lines.push(line.trim())
      line = word
    } else {
      line += ' ' + word
    }
  }
  if (line.trim()) lines.push(line.trim())
  return lines
}
