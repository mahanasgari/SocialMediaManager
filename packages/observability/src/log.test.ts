import { describe, expect, it } from 'vitest'
import { createLogger, redact } from './log.js'

/** Captures lines instead of writing them, so nothing touches global state. */
function capture() {
  const lines: string[] = []
  return {
    lines,
    logger: (level?: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal') =>
      createLogger({ json: true, write: (l) => lines.push(l), ...(level ? { level } : {}) }),
    parsed: () => lines.map((l) => JSON.parse(l) as Record<string, unknown>),
  }
}

describe('redaction', () => {
  it('hides a value whose key names a secret', () => {
    const out = redact({ accessToken: 'live-token', user: 'ada' }) as Record<string, unknown>
    expect(out['accessToken']).toBe('[redacted]')
    expect(out['user']).toBe('ada')
  })

  it('matches the key case-insensitively and as a substring', () => {
    // Real field names in this codebase include accessToken, refreshToken,
    // ENCRYPTION_KEY and Authorization. An exact-match list would miss most.
    const out = redact({
      AccessToken: 'a',
      refresh_token: 'b',
      Authorization: 'c',
      SESSION_SECRET: 'd',
      apiKey: 'e',
      encryptionKey: 'f',
    }) as Record<string, string>
    expect(Object.values(out).every((v) => v === '[redacted]')).toBe(true)
  })

  it('redacts at depth, not only at the top level', () => {
    // The realistic shape: a token nested inside a logged request or account
    // object, which is exactly where a top-level-only check lets one through.
    const out = redact({
      account: { handle: '@brand', credential: { accessToken: 'live-token' } },
    }) as { account: { handle: string; credential: string } }
    expect(out.account.handle).toBe('@brand')
    expect(out.account.credential).toBe('[redacted]')
  })

  it('redacts inside arrays', () => {
    const out = redact([{ password: 'x' }, { name: 'ok' }]) as Array<Record<string, unknown>>
    expect(out[0]!['password']).toBe('[redacted]')
    expect(out[1]!['name']).toBe('ok')
  })

  it('serialises an Error usefully instead of as an empty object', () => {
    // message and stack are non-enumerable, so a caught error logs as {} —
    // the least useful possible record of a failure.
    const out = redact(new Error('it broke')) as Record<string, unknown>
    expect(out['name']).toBe('Error')
    expect(out['message']).toBe('it broke')
    expect(String(out['stack'])).toContain('it broke')
  })

  it('stops at a depth limit rather than following a cycle forever', () => {
    const a: Record<string, unknown> = {}
    a['self'] = a
    expect(() => JSON.stringify(redact(a))).not.toThrow()
  })

  it('leaves primitives alone', () => {
    expect(redact('plain')).toBe('plain')
    expect(redact(42)).toBe(42)
    expect(redact(null)).toBe(null)
  })
})

describe('the logger', () => {
  it('writes one JSON object per line with time, level and message first', () => {
    const c = capture()
    c.logger().info('published', { variantId: 'v1' })

    const [line] = c.parsed()
    expect(Object.keys(line!).slice(0, 3)).toEqual(['time', 'level', 'msg'])
    expect(line!['msg']).toBe('published')
    expect(line!['variantId']).toBe('v1')
  })

  it('drops anything below the configured level', () => {
    const c = capture()
    const logger = c.logger('warn')
    logger.debug('noise')
    logger.info('also noise')
    logger.warn('kept')
    logger.error('kept too')

    expect(c.parsed().map((l) => l['msg'])).toEqual(['kept', 'kept too'])
  })

  it('redacts fields on the way out', () => {
    const c = capture()
    c.logger().info('connected', { credential: { accessToken: 'live-token' } })
    expect(c.lines[0]).not.toContain('live-token')
    expect(c.lines[0]).toContain('[redacted]')
  })

  it('a child carries its fields onto every line', () => {
    // How a request id reaches a log written four call frames away without
    // being threaded through every signature in between.
    const c = capture()
    const child = c.logger().child({ requestId: 'r-1' })
    child.info('one')
    child.warn('two')

    expect(c.parsed().map((l) => l['requestId'])).toEqual(['r-1', 'r-1'])
  })

  it('a child inherits its parent’s fields and adds its own', () => {
    const c = capture()
    c.logger().child({ service: 'worker' }).child({ variantId: 'v1' }).info('nested')

    const [line] = c.parsed()
    expect(line!['service']).toBe('worker')
    expect(line!['variantId']).toBe('v1')
  })

  it('a per-call field beats the same field from the child', () => {
    const c = capture()
    c.logger().child({ stage: 'claim' }).info('done', { stage: 'publish' })
    expect(c.parsed()[0]!['stage']).toBe('publish')
  })
})
