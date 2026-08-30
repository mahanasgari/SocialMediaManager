import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { verifyHmac, withinTolerance } from './webhook-signature.js'

const SECRET = 'shhh-this-is-the-shared-secret'
const body = Buffer.from(JSON.stringify({ entry: [{ id: '17841400000000000' }] }), 'utf8')
const sign = (buf: Buffer, secret = SECRET) =>
  'sha256=' + createHmac('sha256', secret).update(buf).digest('hex')

describe('verifyHmac', () => {
  it('accepts a correctly signed body', () => {
    expect(verifyHmac(body, { secret: SECRET, signature: sign(body), prefix: 'sha256=' })).toEqual({
      valid: true,
    })
  })

  it('REFUSES when no secret is configured, rather than passing', () => {
    // The tempting shortcut — skip verification when unconfigured so it "works
    // out of the box" — turns the endpoint into an open write into an inbox.
    const result = verifyHmac(body, { secret: undefined, signature: sign(body) })
    expect(result.valid).toBe(false)
  })

  it('refuses when the request carries no signature at all', () => {
    expect(verifyHmac(body, { secret: SECRET, signature: undefined }).valid).toBe(false)
  })

  it('rejects a body signed with a different secret', () => {
    const forged = sign(body, 'attacker-guessed-this')
    expect(verifyHmac(body, { secret: SECRET, signature: forged, prefix: 'sha256=' }).valid).toBe(
      false
    )
  })

  it('rejects when a single byte of the body changes', () => {
    const signature = sign(body)
    const tampered = Buffer.from(body.toString('utf8').replace('17841', '17842'), 'utf8')
    expect(verifyHmac(tampered, { secret: SECRET, signature, prefix: 'sha256=' }).valid).toBe(false)
  })

  it('rejects a re-serialised body whose JSON parses identically', () => {
    // THE TEST THAT MATTERS. Re-serialising parsed JSON and hashing that is the
    // single most common way this check silently passes on well-formed payloads
    // and fails on everything else. These two buffers are the same object and
    // different bytes.
    const signature = sign(body)
    const reserialised = Buffer.from(JSON.stringify(JSON.parse(body.toString('utf8'))), 'utf8')
    expect(reserialised.equals(body)).toBe(true)

    // Now the version that actually differs: key order and spacing.
    const respaced = Buffer.from('{"entry": [{"id": "17841400000000000"}]}', 'utf8')
    expect(JSON.stringify(JSON.parse(respaced.toString()))).toBe(body.toString())
    expect(verifyHmac(respaced, { secret: SECRET, signature, prefix: 'sha256=' }).valid).toBe(false)
  })

  it('does not throw on a signature of the wrong length', () => {
    // timingSafeEqual THROWS on a length mismatch. An uncaught throw here is a
    // 500, which tells an attacker their guess had the wrong shape.
    expect(() => verifyHmac(body, { secret: SECRET, signature: 'sha256=ab', prefix: 'sha256=' })).not.toThrow()
    expect(verifyHmac(body, { secret: SECRET, signature: 'sha256=ab', prefix: 'sha256=' }).valid).toBe(false)
  })

  it('tolerates a missing prefix', () => {
    const bare = createHmac('sha256', SECRET).update(body).digest('hex')
    expect(verifyHmac(body, { secret: SECRET, signature: bare, prefix: 'sha256=' }).valid).toBe(true)
  })

  it('supports sha1, which older Meta subscriptions still send', () => {
    const sig = 'sha1=' + createHmac('sha1', SECRET).update(body).digest('hex')
    expect(
      verifyHmac(body, { secret: SECRET, signature: sig, prefix: 'sha1=', algorithm: 'sha1' }).valid
    ).toBe(true)
  })

  it('signs over a prefixed string where the provider does that', () => {
    const signed = Buffer.concat([Buffer.from('v0:1700000000:', 'utf8'), body])
    const sig = createHmac('sha256', SECRET).update(signed).digest('hex')
    expect(
      verifyHmac(body, { secret: SECRET, signature: sig, signedPrefix: 'v0:1700000000:' }).valid
    ).toBe(true)
  })

  it('rejects that same signature when the prefix is not applied', () => {
    const signed = Buffer.concat([Buffer.from('v0:1700000000:', 'utf8'), body])
    const sig = createHmac('sha256', SECRET).update(signed).digest('hex')
    expect(verifyHmac(body, { secret: SECRET, signature: sig }).valid).toBe(false)
  })
})

describe('withinTolerance', () => {
  const now = new Date('2026-08-30T12:00:00Z')

  it('accepts a fresh timestamp', () => {
    expect(withinTolerance(now.getTime() / 1000 - 10, 300, now).valid).toBe(true)
  })

  it('rejects a replayed event, whose signature is still perfectly valid', () => {
    // Signature validity does not make an event fresh: a captured request
    // replays forever because its signature never stops matching.
    expect(withinTolerance(now.getTime() / 1000 - 3600, 300, now).valid).toBe(false)
  })

  it('rejects a timestamp from the future beyond tolerance', () => {
    expect(withinTolerance(now.getTime() / 1000 + 3600, 300, now).valid).toBe(false)
  })

  it('accepts a string timestamp, which is how it arrives in a header', () => {
    expect(withinTolerance(String(now.getTime() / 1000), 300, now).valid).toBe(true)
  })

  it('rejects a missing or unparseable timestamp rather than defaulting to now', () => {
    expect(withinTolerance(undefined, 300, now).valid).toBe(false)
    expect(withinTolerance('not-a-number', 300, now).valid).toBe(false)
  })
})
