import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

/**
 * Envelope encryption for OAuth credentials.
 *
 * These tokens are the highest-value asset in the system: they carry publish
 * authority over a customer's real audience, and a leak is not recoverable by
 * rotating anything on our side.
 *
 * AES-256-GCM, envelope construction: a fresh per-record DEK encrypts the token,
 * and the KEK wraps the DEK. Two reasons that beats encrypting directly with the
 * KEK:
 *
 *   1. Rotation re-wraps small DEKs rather than decrypting and re-encrypting
 *      every token, so a key change is a fast background job rather than a
 *      migration that must hold every secret in memory.
 *   2. The KEK is used on 32 bytes per record instead of on arbitrary
 *      plaintext, which keeps its usage well inside safe limits for a single key.
 *
 * GCM rather than CBC: it authenticates. Without a tag, an attacker with write
 * access to the database can flip ciphertext bits and the application decrypts
 * garbage without ever noticing.
 */

const SCHEME_VERSION = 1
const KEY_BYTES = 32
const IV_BYTES = 12 // 96 bits, the GCM-recommended size
const TAG_BYTES = 16

/**
 * Where the KEK comes from.
 *
 * Self-hosted reads it from the environment. SaaS backs the same interface with
 * KMS or Vault, and no business logic changes — which is the point of it being
 * an interface at all.
 */
export interface KeyProvider {
  /** The key new records are encrypted with. */
  current(): { keyId: string; key: Buffer }
  /** Any key we must still be able to READ, including the previous one. */
  byId(keyId: string): Buffer | undefined
}

export class MissingEncryptionKey extends Error {
  override readonly name = 'MissingEncryptionKey'
  constructor(keyId: string) {
    super(
      `No encryption key available for keyId "${keyId}". A record was encrypted with a key ` +
        `this process cannot see. If you rotated ENCRYPTION_KEY, set ENCRYPTION_KEY_PREVIOUS ` +
        `to the old value until the rotation job reports complete.`
    )
  }
}

export class DecryptionFailed extends Error {
  override readonly name = 'DecryptionFailed'
  constructor(reason: string) {
    // Deliberately vague to the caller; the detail goes to logs. A precise
    // decryption error is an oracle.
    super(`Stored credential could not be decrypted (${reason}).`)
  }
}

/**
 * Environment-backed provider.
 *
 * `keyId` is derived from the key material itself, so a record always names the
 * key that encrypted it without the operator having to track version numbers by
 * hand — and rotating simply means a different derived id appears.
 */
export class EnvKeyProvider implements KeyProvider {
  private readonly keys = new Map<string, Buffer>()
  private readonly currentId: string

  constructor(currentKeyBase64: string, previousKeyBase64?: string) {
    const current = decodeKey(currentKeyBase64, 'ENCRYPTION_KEY')
    this.currentId = keyIdFor(current)
    this.keys.set(this.currentId, current)

    if (previousKeyBase64 && previousKeyBase64.length > 0) {
      const previous = decodeKey(previousKeyBase64, 'ENCRYPTION_KEY_PREVIOUS')
      this.keys.set(keyIdFor(previous), previous)
    }
  }

  current(): { keyId: string; key: Buffer } {
    return { keyId: this.currentId, key: this.keys.get(this.currentId)! }
  }

  byId(keyId: string): Buffer | undefined {
    return this.keys.get(keyId)
  }
}

function decodeKey(value: string, name: string): Buffer {
  const key = Buffer.from(value, 'base64')
  if (key.length < KEY_BYTES) {
    throw new Error(`${name} must decode to at least ${KEY_BYTES} bytes. Generate one with: openssl rand -base64 32`)
  }
  return key.subarray(0, KEY_BYTES)
}

/** A short, stable fingerprint. Not secret, and not reversible to the key. */
function keyIdFor(key: Buffer): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 16)
}

/**
 * Serialised form.
 *
 * `v` versions the SCHEME itself, so the algorithm can change later without a
 * flag day: a reader sees v=1 and knows exactly how to interpret the rest.
 */
export type Envelope = {
  v: number
  keyId: string
  /** DEK wrapped by the KEK, with its own iv and tag. */
  dek: string
  iv: string
  tag: string
  ciphertext: string
}

export function encrypt(plaintext: string, provider: KeyProvider): string {
  const { keyId, key } = provider.current()

  // Fresh DEK per record. Reusing one across records would mean a single
  // compromised DEK exposes every credential encrypted with it.
  const dek = randomBytes(KEY_BYTES)

  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', dek, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()

  const dekIv = randomBytes(IV_BYTES)
  const wrapper = createCipheriv('aes-256-gcm', key, dekIv)
  const wrappedDek = Buffer.concat([wrapper.update(dek), wrapper.final()])
  const dekTag = wrapper.getAuthTag()

  const envelope: Envelope = {
    v: SCHEME_VERSION,
    keyId,
    dek: Buffer.concat([dekIv, dekTag, wrappedDek]).toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  }

  return JSON.stringify(envelope)
}

export function decrypt(serialised: string, provider: KeyProvider): string {
  let envelope: Envelope
  try {
    envelope = JSON.parse(serialised) as Envelope
  } catch {
    throw new DecryptionFailed('malformed envelope')
  }

  if (envelope.v !== SCHEME_VERSION) {
    throw new DecryptionFailed(`unsupported scheme version ${envelope.v}`)
  }

  const key = provider.byId(envelope.keyId)
  if (!key) throw new MissingEncryptionKey(envelope.keyId)

  try {
    const dekBlob = Buffer.from(envelope.dek, 'base64')
    const dekIv = dekBlob.subarray(0, IV_BYTES)
    const dekTag = dekBlob.subarray(IV_BYTES, IV_BYTES + TAG_BYTES)
    const wrappedDek = dekBlob.subarray(IV_BYTES + TAG_BYTES)

    const unwrapper = createDecipheriv('aes-256-gcm', key, dekIv)
    unwrapper.setAuthTag(dekTag)
    const dek = Buffer.concat([unwrapper.update(wrappedDek), unwrapper.final()])

    const decipher = createDecipheriv('aes-256-gcm', dek, Buffer.from(envelope.iv, 'base64'))
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'))
    return Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8')
  } catch (err) {
    // GCM verification failing here means the ciphertext or tag was altered.
    // That is a tamper signal, not a corrupt-row signal, and it must never
    // return plaintext.
    throw new DecryptionFailed(err instanceof Error ? err.name : 'authentication failed')
  }
}

/** The keyId a stored envelope was encrypted under — what the rotation job scans. */
export function keyIdOf(serialised: string): string | null {
  try {
    return (JSON.parse(serialised) as Envelope).keyId ?? null
  } catch {
    return null
  }
}

/**
 * Re-wrap under the current key without ever writing plaintext anywhere.
 *
 * Rotation reads, decrypts in memory, and re-encrypts. Because only the DEK is
 * wrapped by the KEK, this stays cheap regardless of token size.
 */
export function rewrap(serialised: string, provider: KeyProvider): string {
  return encrypt(decrypt(serialised, provider), provider)
}

let singleton: KeyProvider | undefined

export function keyProvider(): KeyProvider {
  if (!singleton) {
    const key = process.env['ENCRYPTION_KEY']
    if (!key) {
      throw new Error(
        'ENCRYPTION_KEY is not set. Credentials cannot be stored without it, and starting ' +
          'without encryption would silently downgrade a guarantee the product makes.'
      )
    }
    singleton = new EnvKeyProvider(key, process.env['ENCRYPTION_KEY_PREVIOUS'])
  }
  return singleton
}

export function setKeyProvider(provider: KeyProvider | undefined): void {
  singleton = provider
}
