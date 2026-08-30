import { describe, expect, it, beforeEach } from 'vitest'
import { cookiePolicy, envSchema, loadEnv, resetEnvCache } from './env.js'

const KEY = Buffer.alloc(32, 7).toString('base64')

const valid = {
  DATABASE_URL: 'postgresql://smm:smm@localhost:5432/smm',
  REDIS_URL: 'redis://localhost:6379',
  ENCRYPTION_KEY: KEY,
  SESSION_SECRET: KEY,
  PUBLIC_URL: 'https://social.example.com',
  INTERNAL_API_URL: 'http://api:3001',
  S3_ENDPOINT: 'http://localhost:9000',
  S3_BUCKET: 'smm-media',
  S3_ACCESS_KEY_ID: 'minio',
  S3_SECRET_ACCESS_KEY: 'minio-secret',
} satisfies NodeJS.ProcessEnv

beforeEach(resetEnvCache)

describe('required secrets', () => {
  it('names the variable when ENCRYPTION_KEY is absent', () => {
    const { ENCRYPTION_KEY: _omitted, ...withoutKey } = valid
    expect(() => loadEnv(withoutKey as NodeJS.ProcessEnv)).toThrowError(/ENCRYPTION_KEY/)
  })

  it('rejects a key that decodes to fewer than 32 bytes', () => {
    const short = Buffer.alloc(16, 1).toString('base64')
    const result = envSchema.safeParse({ ...valid, ENCRYPTION_KEY: short })
    expect(result.success).toBe(false)
  })

  it('rejects the example placeholder rather than accepting a known key', () => {
    const result = envSchema.safeParse({ ...valid, SESSION_SECRET: 'changeme' })
    expect(result.success).toBe(false)
  })
})

describe('cookie and TLS policy', () => {
  it('uses the __Host- prefix over HTTPS', () => {
    const policy = cookiePolicy(loadEnv(valid))
    expect(policy).toMatchObject({ name: '__Host-smm_session', secure: true, warning: null })
  })

  it('allows plain HTTP on localhost without an opt-in', () => {
    const env = loadEnv({ ...valid, PUBLIC_URL: 'http://localhost:3000' })
    const policy = cookiePolicy(env)
    expect(policy.secure).toBe(false)
    expect(policy.warning).toBeNull()
  })

  it('refuses to boot on http:// against a non-localhost host', () => {
    const result = envSchema.safeParse({ ...valid, PUBLIC_URL: 'http://smm.lan:3000' })
    expect(result.success).toBe(false)
    // The message has to tell the operator what to do, not merely that it failed.
    const message = result.success ? '' : result.error.issues[0]!.message
    expect(message).toMatch(/ALLOW_INSECURE_COOKIES/)
  })

  it('permits the same host once insecure cookies are explicitly accepted', () => {
    const env = loadEnv({
      ...valid,
      PUBLIC_URL: 'http://smm.lan:3000',
      ALLOW_INSECURE_COOKIES: 'true',
    })
    const policy = cookiePolicy(env)
    expect(policy.name).toBe('smm_session')
    expect(policy.secure).toBe(false)
    // Opting out must stay visible on every boot, not just at the moment of choice.
    expect(policy.warning).toMatch(/INSECURE COOKIES/)
  })
})

describe('defaults', () => {
  it('defaults to the self-hosted posture', () => {
    const env = loadEnv(valid)
    expect(env.AUTH_REGISTRATION).toBe('invite')
    expect(env.INBOUND_MODE).toBe('auto')
    expect(env.MEDIA_PUBLIC_MODE).toBe('relay')
    expect(env.CATCHUP_WINDOW_MINUTES).toBe(60)
    expect(env.WORKSPACE_PURGE_GRACE_DAYS).toBe(30)
  })

  it('leaves inbox retention unlimited unless set', () => {
    expect(loadEnv(valid).INBOX_RETENTION_DAYS).toBeUndefined()
  })
})
