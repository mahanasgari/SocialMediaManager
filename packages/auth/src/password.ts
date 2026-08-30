import { hash, verify } from '@node-rs/argon2'
import type { Algorithm } from '@node-rs/argon2'

/**
 * `Algorithm` is an ambient const enum, which `verbatimModuleSyntax` forbids
 * reading at runtime — the import would be erased and the value would not exist.
 * The numeric value is part of the library's public API (Argon2d=0, Argon2i=1,
 * Argon2id=2), and the test asserting the `$argon2id$` prefix is what actually
 * holds this honest, rather than trusting the constant.
 */
const ARGON2ID = 2 as Algorithm

/**
 * Password hashing.
 *
 * argon2id, not bcrypt and certainly not a bare SHA. argon2id is memory-hard, so
 * the attacker's advantage from GPUs and ASICs — which is the entire economics
 * of offline cracking — is blunted rather than merely slowed.
 *
 * Parameters follow OWASP's baseline: 19 MiB of memory, 2 iterations,
 * parallelism 1. Memory cost dominates; raising iterations without raising
 * memory buys much less than it appears to.
 */
const PARAMS = {
  algorithm: ARGON2ID,
  memoryCost: 19_456, // KiB
  timeCost: 2,
  parallelism: 1,
} as const

export async function hashPassword(plaintext: string): Promise<string> {
  return hash(plaintext, PARAMS)
}

/**
 * Verifies a password.
 *
 * Returns false rather than throwing on a malformed stored hash. A corrupt row
 * should deny the login, not surface a 500 that tells an attacker they found
 * something unusual about this particular account.
 */
export async function verifyPassword(storedHash: string, plaintext: string): Promise<boolean> {
  try {
    return await verify(storedHash, plaintext, PARAMS)
  } catch {
    return false
  }
}

/**
 * True when a stored hash was produced with weaker parameters than current
 * policy, so it should be transparently re-hashed on the next successful login.
 *
 * Without this, a parameter increase only ever protects accounts created after
 * the change — the long-standing accounts, which are the ones worth attacking,
 * keep their old cost forever.
 */
export function needsRehash(storedHash: string): boolean {
  const m = /\$argon2id\$v=\d+\$m=(\d+),t=(\d+),p=(\d+)\$/.exec(storedHash)
  if (!m) return true // unknown or legacy format — re-hash it
  const [, memory, time, parallelism] = m
  return (
    Number(memory) < PARAMS.memoryCost ||
    Number(time) < PARAMS.timeCost ||
    Number(parallelism) < PARAMS.parallelism
  )
}

export { PARAMS as ARGON2_PARAMS }
