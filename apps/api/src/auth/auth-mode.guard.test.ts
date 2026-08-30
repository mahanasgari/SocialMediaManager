import { beforeEach, describe, expect, it } from 'vitest'
import { Reflector } from '@nestjs/core'
import type { ExecutionContext } from '@nestjs/common'
import { resetEnvCache } from '@smm/config'
import { AuthModeGuard, PUBLIC_ROUTE } from './auth-mode.guard.js'
import { AppError } from '../common/errors.js'

const KEY = Buffer.alloc(32, 7).toString('base64')

beforeEach(() => {
  resetEnvCache()
  Object.assign(process.env, {
    DATABASE_URL: 'postgresql://smm:smm@localhost:5432/smm',
    REDIS_URL: 'redis://localhost:6379',
    ENCRYPTION_KEY: KEY,
    SESSION_SECRET: KEY,
    PUBLIC_URL: 'https://social.example.com',
    INTERNAL_API_URL: 'http://api:3001',
    S3_ENDPOINT: 'http://localhost:9000',
    S3_BUCKET: 'smm-media',
    S3_ACCESS_KEY_ID: 'a',
    S3_SECRET_ACCESS_KEY: 'b',
  })
})

type Req = {
  headers: Record<string, string | string[] | undefined>
  cookies?: Record<string, string>
  auth?: unknown
}

function contextFor(request: Req, isPublic = false): ExecutionContext {
  const reflector = new Reflector()
  reflector.getAllAndOverride = (() => isPublic) as typeof reflector.getAllAndOverride
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => undefined,
    getClass: () => undefined,
  } as unknown as ExecutionContext
}

function guardFor(isPublic = false) {
  const reflector = new Reflector()
  reflector.getAllAndOverride = (() => isPublic) as typeof reflector.getAllAndOverride
  return new AuthModeGuard(reflector)
}

// Over HTTPS the cookie carries the __Host- prefix; the guard must read the
// name the cookie policy actually produced, not a hard-coded string.
const COOKIE = '__Host-smm_session'

describe('credential resolution', () => {
  it('accepts a session cookie and records the mode on the request', () => {
    const request: Req = { headers: {}, cookies: { [COOKIE]: 'sess' } }
    expect(guardFor().canActivate(contextFor(request))).toBe(true)
    expect(request.auth).toEqual({ mode: { kind: 'session', token: 'sess' } })
  })

  it('accepts a bearer API key', () => {
    const request: Req = { headers: { authorization: 'Bearer smm_live_abc' } }
    expect(guardFor().canActivate(contextFor(request))).toBe(true)
    expect(request.auth).toEqual({ mode: { kind: 'apiKey', token: 'smm_live_abc' } })
  })

  it('reads the cookie name from the policy, not a hard-coded constant', () => {
    // A guard hard-coding "smm_session" would silently fail to authenticate
    // every HTTPS deployment, where the name carries the __Host- prefix.
    const wrongName: Req = { headers: {}, cookies: { smm_session: 'sess' } }
    expect(() => guardFor().canActivate(contextFor(wrongName))).toThrow(AppError)
  })
})

describe('dual-auth is rejected, never resolved', () => {
  const both: Req = {
    headers: { authorization: 'Bearer smm_live_abc' },
    cookies: { [COOKIE]: 'sess' },
  }

  it('throws auth_mode_conflict when both credentials are present', () => {
    try {
      guardFor().canActivate(contextFor(both))
      throw new Error('expected the guard to reject')
    } catch (err) {
      expect(err).toBeInstanceOf(AppError)
      expect((err as AppError).code).toBe('auth_mode_conflict')
      expect((err as AppError).status).toBe(401)
    }
  })

  it('rejects the conflict even on a public route', () => {
    // Ambiguity is refused before the public/private question is asked. A public
    // route that quietly accepted an API key alongside a cookie would be exactly
    // the confused-deputy path this exists to close.
    expect(() => guardFor(true).canActivate(contextFor(both, true))).toThrow(AppError)
  })

  it('does not populate request.auth when it rejects', () => {
    const request: Req = {
      headers: { authorization: 'Bearer smm_live_abc' },
      cookies: { [COOKIE]: 'sess' },
    }
    expect(() => guardFor().canActivate(contextFor(request))).toThrow()
    expect(request.auth).toBeUndefined()
  })
})

describe('public routes', () => {
  it('allows an anonymous request through', () => {
    const request: Req = { headers: {} }
    expect(guardFor(true).canActivate(contextFor(request, true))).toBe(true)
    expect(request.auth).toEqual({ mode: { kind: 'anonymous' } })
  })

  it('rejects an anonymous request on a protected route', () => {
    try {
      guardFor(false).canActivate(contextFor({ headers: {} }))
      throw new Error('expected the guard to reject')
    } catch (err) {
      expect((err as AppError).code).toBe('unauthenticated')
      expect((err as AppError).status).toBe(401)
    }
  })
})

describe('metadata key', () => {
  it('is namespaced so it cannot collide with another library', () => {
    expect(PUBLIC_ROUTE).toBe('smm:publicRoute')
  })
})
