import { describe, expect, it } from 'vitest'
import {
  DecryptionFailed,
  EnvKeyProvider,
  MissingEncryptionKey,
  decrypt,
  encrypt,
  keyIdOf,
  rewrap,
  type Envelope,
} from './encryption.js'

const KEY_A = Buffer.alloc(32, 1).toString('base64')
const KEY_B = Buffer.alloc(32, 2).toString('base64')

const providerA = new EnvKeyProvider(KEY_A)
const providerB = new EnvKeyProvider(KEY_B)
/** Mid-rotation: new key current, old key still readable. */
const rotating = new EnvKeyProvider(KEY_B, KEY_A)

const TOKEN = 'ya29.a0AfB_byC-real-looking-oauth-token'

describe('round trip', () => {
  it('recovers the exact plaintext', () => {
    expect(decrypt(encrypt(TOKEN, providerA), providerA)).toBe(TOKEN)
  })

  it('handles unicode and long tokens', () => {
    const odd = 'tökén-🔐-' + 'x'.repeat(4000)
    expect(decrypt(encrypt(odd, providerA), providerA)).toBe(odd)
  })

  it('never contains the plaintext', () => {
    expect(encrypt(TOKEN, providerA)).not.toContain(TOKEN)
    expect(encrypt(TOKEN, providerA)).not.toContain('ya29')
  })

  it('produces different ciphertext each time for the same input', () => {
    // A fresh DEK and IV per record. Identical ciphertexts would leak that two
    // accounts share a token, and would break GCM's security entirely on IV reuse.
    expect(encrypt(TOKEN, providerA)).not.toBe(encrypt(TOKEN, providerA))
  })

  it('uses a fresh DEK per record', () => {
    const first = JSON.parse(encrypt(TOKEN, providerA)) as Envelope
    const second = JSON.parse(encrypt(TOKEN, providerA)) as Envelope
    expect(first.dek).not.toBe(second.dek)
    // Same KEK, so the same keyId — that part must NOT vary.
    expect(first.keyId).toBe(second.keyId)
  })
})

describe('envelope shape', () => {
  it('is versioned so the scheme itself can change later', () => {
    const envelope = JSON.parse(encrypt(TOKEN, providerA)) as Envelope
    expect(envelope.v).toBe(1)
    expect(envelope).toHaveProperty('keyId')
    expect(envelope).toHaveProperty('dek')
    expect(envelope).toHaveProperty('iv')
    expect(envelope).toHaveProperty('tag')
  })

  it('refuses an unknown scheme version rather than guessing', () => {
    const envelope = JSON.parse(encrypt(TOKEN, providerA)) as Envelope
    envelope.v = 99
    expect(() => decrypt(JSON.stringify(envelope), providerA)).toThrow(DecryptionFailed)
  })

  it('exposes the keyId without decrypting, for the rotation job to scan', () => {
    const serialised = encrypt(TOKEN, providerA)
    expect(keyIdOf(serialised)).toBe(providerA.current().keyId)
  })
})

describe('authentication', () => {
  // GCM rather than CBC precisely so tampering is detected. Without a tag, an
  // attacker with database write access flips bits and we decrypt garbage
  // without noticing.
  it('rejects a tampered ciphertext', () => {
    const envelope = JSON.parse(encrypt(TOKEN, providerA)) as Envelope
    const bytes = Buffer.from(envelope.ciphertext, 'base64')
    bytes[0] = bytes[0]! ^ 0xff
    envelope.ciphertext = bytes.toString('base64')

    expect(() => decrypt(JSON.stringify(envelope), providerA)).toThrow(DecryptionFailed)
  })

  it('rejects a tampered auth tag', () => {
    const envelope = JSON.parse(encrypt(TOKEN, providerA)) as Envelope
    const tag = Buffer.from(envelope.tag, 'base64')
    tag[0] = tag[0]! ^ 0xff
    envelope.tag = tag.toString('base64')

    expect(() => decrypt(JSON.stringify(envelope), providerA)).toThrow(DecryptionFailed)
  })

  it('rejects a tampered wrapped DEK', () => {
    const envelope = JSON.parse(encrypt(TOKEN, providerA)) as Envelope
    const dek = Buffer.from(envelope.dek, 'base64')
    dek[dek.length - 1] = dek[dek.length - 1]! ^ 0xff
    envelope.dek = dek.toString('base64')

    expect(() => decrypt(JSON.stringify(envelope), providerA)).toThrow(DecryptionFailed)
  })

  it('rejects a swapped ciphertext from another record', () => {
    // Both encrypted under the same KEK, but each with its own DEK — so a
    // ciphertext cannot be lifted from one row into another.
    const first = JSON.parse(encrypt('token-one', providerA)) as Envelope
    const second = JSON.parse(encrypt('token-two', providerA)) as Envelope
    first.ciphertext = second.ciphertext

    expect(() => decrypt(JSON.stringify(first), providerA)).toThrow(DecryptionFailed)
  })

  it('never returns plaintext on a failure path', () => {
    const envelope = JSON.parse(encrypt(TOKEN, providerA)) as Envelope
    envelope.tag = Buffer.alloc(16).toString('base64')
    let result: unknown
    try {
      result = decrypt(JSON.stringify(envelope), providerA)
    } catch {
      result = undefined
    }
    expect(result).toBeUndefined()
  })

  it('does not echo the reason in a way that helps an attacker', () => {
    // A precise decryption error is an oracle; the detail belongs in logs.
    try {
      decrypt('not json at all', providerA)
    } catch (err) {
      expect((err as Error).message).not.toContain('not json at all')
    }
  })
})

describe('key rotation', () => {
  it('cannot decrypt with the wrong key', () => {
    expect(() => decrypt(encrypt(TOKEN, providerA), providerB)).toThrow(MissingEncryptionKey)
  })

  it('names the missing key and says what to do about it', () => {
    try {
      decrypt(encrypt(TOKEN, providerA), providerB)
    } catch (err) {
      expect((err as Error).message).toContain('ENCRYPTION_KEY_PREVIOUS')
    }
  })

  it('reads old records while the previous key is still configured', () => {
    // The rotation window: new writes use the new key, old rows still decrypt.
    // Without this, rotating would take every connected account offline at once.
    const old = encrypt(TOKEN, providerA)
    expect(decrypt(old, rotating)).toBe(TOKEN)
  })

  it('writes new records under the CURRENT key during rotation', () => {
    const fresh = JSON.parse(encrypt(TOKEN, rotating)) as Envelope
    expect(fresh.keyId).toBe(providerB.current().keyId)
    expect(fresh.keyId).not.toBe(providerA.current().keyId)
  })

  it('rewrap moves a record onto the current key without changing the plaintext', () => {
    const old = encrypt(TOKEN, providerA)
    const rewrapped = rewrap(old, rotating)

    expect(keyIdOf(rewrapped)).toBe(providerB.current().keyId)
    expect(decrypt(rewrapped, rotating)).toBe(TOKEN)
    // The whole point: once rotated, the old key is no longer needed.
    expect(decrypt(rewrapped, providerB)).toBe(TOKEN)
  })
})

describe('key material validation', () => {
  it('refuses a key shorter than 32 bytes', () => {
    expect(() => new EnvKeyProvider(Buffer.alloc(16).toString('base64'))).toThrow(/32 bytes/)
  })

  it('tells the operator how to generate one', () => {
    try {
      new EnvKeyProvider('short')
    } catch (err) {
      expect((err as Error).message).toContain('openssl rand -base64 32')
    }
  })

  it('derives a stable keyId from the key material', () => {
    // So a record always names the key that encrypted it, without the operator
    // tracking version numbers by hand.
    expect(new EnvKeyProvider(KEY_A).current().keyId).toBe(new EnvKeyProvider(KEY_A).current().keyId)
    expect(new EnvKeyProvider(KEY_A).current().keyId).not.toBe(
      new EnvKeyProvider(KEY_B).current().keyId
    )
  })

  it('does not expose key material in the keyId', () => {
    const id = new EnvKeyProvider(KEY_A).current().keyId
    expect(id).toHaveLength(16)
    expect(Buffer.from(KEY_A, 'base64').toString('hex')).not.toContain(id)
  })
})
