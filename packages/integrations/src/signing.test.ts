import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { sign, verify } from './signing.js'

const SECRET = 'whsec_test_secret'
const BODY = JSON.stringify({ id: 'evt_1', type: 'post.published' })

describe('webhook signatures', () => {
  it('produces the documented header shape', () => {
    expect(sign(BODY, SECRET, 1735689600)).toMatch(/^t=1735689600,v1=[0-9a-f]{64}$/)
  })

  it('signs timestamp AND body, not the body alone', () => {
    // If the signature covered only the body, a captured request could be
    // replayed forever. Binding the timestamp means a receiver can reject old
    // ones, and altering the timestamp invalidates the signature.
    expect(sign(BODY, SECRET, 1)).not.toBe(sign(BODY, SECRET, 2))
  })

  it('changes when the body changes', () => {
    expect(sign(BODY, SECRET, 1)).not.toBe(sign(BODY + ' ', SECRET, 1))
  })

  it('changes with the secret, so one endpoint cannot forge another', () => {
    expect(sign(BODY, SECRET, 1)).not.toBe(sign(BODY, 'other_secret', 1))
  })

  it('is reproducible by a receiver following the documented recipe', () => {
    // The check a consumer actually writes: recompute over `${t}.${rawBody}`.
    const timestamp = 1735689600
    const expected = createHmac('sha256', SECRET).update(`${timestamp}.${BODY}`).digest('hex')
    expect(sign(BODY, SECRET, timestamp)).toBe(`t=${timestamp},v1=${expected}`)
  })

  it('signs the exact bytes, so whitespace is not incidental', () => {
    // A receiver that re-serialises parsed JSON before hashing will fail —
    // which is the single most common way this check is got wrong.
    const reserialised = JSON.stringify(JSON.parse(BODY.replace('{', '{ ')))
    expect(sign(BODY.replace('{', '{ '), SECRET, 1)).not.toBe(sign(reserialised, SECRET, 1))
  })
})

describe('verify — the check a consumer actually writes', () => {
  const secret = 'whsec_test'
  const body = JSON.stringify({ id: 'evt_1', type: 'post.published' })
  const now = new Date('2026-08-30T12:00:00Z')
  const timestamp = Math.floor(now.getTime() / 1000)

  it('accepts what sign() produced', () => {
    expect(verify(sign(body, secret, timestamp), body, secret, 300, now)).toEqual({ valid: true })
  })

  it('rejects a replay whose signature is still perfectly valid', () => {
    // Freshness is a separate property from correctness. A captured request
    // replays forever because its signature never stops matching.
    const old = timestamp - 3600
    const result = verify(sign(body, secret, old), body, secret, 300, now)
    expect(result.valid).toBe(false)
    if (!result.valid) expect(result.reason).toMatch(/away from now/)
  })

  it('rejects a changed body', () => {
    const header = sign(body, secret, timestamp)
    expect(verify(header, body + ' ', secret, 300, now).valid).toBe(false)
  })

  it('rejects a different secret, so one endpoint cannot forge another', () => {
    const header = sign(body, secret, timestamp)
    expect(verify(header, body, 'whsec_other', 300, now).valid).toBe(false)
  })

  it('rejects a header with the timestamp swapped, since it is inside the MAC', () => {
    const header = sign(body, secret, timestamp)
    const tampered = header.replace(`t=${timestamp}`, `t=${timestamp - 5}`)
    expect(verify(tampered, body, secret, 300, now).valid).toBe(false)
  })

  it('does not throw on a malformed header', () => {
    for (const header of ['', 'garbage', 't=abc,v1=x', 't=1']) {
      expect(() => verify(header, body, secret, 300, now)).not.toThrow()
      expect(verify(header, body, secret, 300, now).valid).toBe(false)
    }
  })

  it('gives a distinct reason for stale versus wrong, so skew is diagnosable', () => {
    const stale = verify(sign(body, secret, timestamp - 9999), body, secret, 300, now)
    const wrong = verify(sign(body, 'other', timestamp), body, secret, 300, now)
    expect(stale.valid).toBe(false)
    expect(wrong.valid).toBe(false)
    if (!stale.valid && !wrong.valid) expect(stale.reason).not.toBe(wrong.reason)
  })
})
