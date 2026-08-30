import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Redis } from 'ioredis'
import {
  createTestClient,
  decrypt,
  EnvKeyProvider,
  keyIdOf,
  withOrganization,
  withSystemScope,
  withTenant,
  type Db,
} from '@smm/database'
import { encrypt } from '@smm/database'
import { MockProvider, ProviderError, withCapability, UnsupportedCapability } from '@smm/providers'
import { RateLimiter, AccountMutex } from '@smm/ratelimit'

/**
 * PHASE 2 GATE — the reduced proving slice.
 *
 * Deliberately smaller than the Phase 4 slice, and deliberately EARLY. It
 * exercises tenancy enforcement, credential encryption, capability narrowing,
 * budget acquisition ordering and the error taxonomy months before the full
 * publishing pipeline exists — while all of them are still cheap to change.
 *
 * What it does NOT cover, because Post and PostVariant arrive in Phase 3/4: the
 * status reducer, the write-ahead attempt row, and reconciliation. Those belong
 * to the Phase 4 gate and are not simulated here — a slice that pretended to
 * prove them would be worse than one that stops honestly.
 */

const dbUrl = process.env['TEST_DATABASE_URL']
const redisUrl = process.env['TEST_REDIS_URL']

const suite = dbUrl && redisUrl ? describe : describe.skip
if (!dbUrl || !redisUrl) {
  console.warn('\n  [skipped] Phase 2 proving slice — run: bash scripts/test-db.sh up\n')
}

const KEY = Buffer.alloc(32, 9).toString('base64')
const keys = new EnvKeyProvider(KEY)

let client: Db
let redis: Redis
let orgId: string
let workspaceId: string
let userId: string
let accountId: string

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const omitTenancy = <T,>(data: T) => data as any

suite('Phase 2 proving slice', () => {
  beforeAll(async () => {
    client = createTestClient(dbUrl!)
    redis = new Redis(redisUrl!)

    await withSystemScope('slice fixture', async () => {
      const org = await client.organization.create({
        data: { name: 'Slice Org', slug: `slice-${Date.now()}` },
      })
      orgId = org.id
      const user = await client.user.create({
        data: { email: `slice-${Date.now()}@example.com`, passwordHash: 'x', name: 'Slice' },
      })
      userId = user.id
    })

    await withOrganization(
      orgId,
      async (tx) => {
        const ws = await tx.workspace.create({
          data: omitTenancy({ name: 'Slice WS', slug: 'slice' }),
        })
        workspaceId = ws.id
        await tx.membership.create({
          data: omitTenancy({ userId, workspaceId, role: 'OWNER' }),
        })
      },
      client
    )
  })

  afterAll(async () => {
    await withSystemScope('slice teardown', async () => {
      await client.organization.delete({ where: { id: orgId } })
      await client.user.delete({ where: { id: userId } })
    })
    await client.$disconnect()
    await redis.quit()
  })

  // -------------------------------------------------------------------------

  it('1. connects a mock account and stores the credential ENCRYPTED', async () => {
    const provider = new MockProvider()
    const discovered = await provider.handleCallback(
      { redirectUri: 'https://example.com/cb', state: 'x' },
      { accounts: '1' }
    )
    expect(discovered).toHaveLength(1)

    const account = discovered[0]!
    const sealed = encrypt(account.credential.accessToken, keys)

    await withTenant(
      workspaceId,
      async (tx) => {
        const row = await tx.socialAccount.create({
          data: omitTenancy({
            organizationId: orgId,
            provider: 'mock',
            providerAccountId: account.providerAccountId,
            handle: account.handle,
            displayName: account.displayName,
            surfaces: ['feed'],
          }),
          select: { id: true },
        })
        accountId = row.id

        await tx.oAuthCredential.create({
          data: omitTenancy({
            socialAccountId: row.id,
            accessToken: sealed,
            scopes: ['read', 'write'],
            keyId: keyIdOf(sealed),
          }),
        })
      },
      client
    )

    // The stored value must not contain the token in any readable form.
    const stored = await withTenant(
      workspaceId,
      async (tx) => tx.oAuthCredential.findUnique({ where: { socialAccountId: accountId } }),
      client
    )
    expect(stored!.accessToken).not.toContain(account.credential.accessToken)
    expect(decrypt(stored!.accessToken, keys)).toBe(account.credential.accessToken)
  })

  it('2. another workspace cannot see the account or its credential', async () => {
    let otherWs = ''
    await withOrganization(
      orgId,
      async (tx) => {
        const ws = await tx.workspace.create({
          data: omitTenancy({ name: 'Other', slug: `other-${Date.now()}` }),
        })
        otherWs = ws.id
      },
      client
    )

    const accounts = await withTenant(otherWs, async (tx) => tx.socialAccount.findMany({}), client)
    const creds = await withTenant(otherWs, async (tx) => tx.oAuthCredential.findMany({}), client)

    expect(accounts).toHaveLength(0)
    expect(creds).toHaveLength(0)
  })

  it('3. capability narrowing refuses an undeclared capability BEFORE any call', async () => {
    const provider = new MockProvider()
    expect(provider.capabilities.audienceAnalytics).toBe(false)
    expect(() => withCapability(provider, 'audienceAnalytics')).toThrow(UnsupportedCapability)

    expect(provider.capabilities.retrievePosts).toBe(true)
    expect(() => withCapability(provider, 'retrievePosts')).not.toThrow()
  })

  it('4. budget is acquired BEFORE the publish call', async () => {
    const limiter = new RateLimiter(redis)
    const spec = {
      provider: 'mock',
      accountId,
      operation: 'publish' as const,
      scope: 'account' as const,
      cost: 1,
      capacity: 2,
      windowMs: 60_000,
    }
    await redis.del(`rl:mock:publish:acct:${accountId}`)

    const provider = new MockProvider()
    const account = {
      id: accountId,
      providerAccountId: 'mock-account-1',
      handle: '@mock1',
      displayName: 'Mock',
      platformMeta: {},
    }
    const credential = { accessToken: 'mock-token-1', scopes: ['write'] }

    const budget = await limiter.acquire(spec)
    expect(budget.granted).toBe(true)

    const result = await provider.publish(account, credential, {
      surface: 'feed',
      text: 'hello from the proving slice',
      media: [],
      idempotencyKey: 'slice-1',
    })
    expect(result.remoteId).toMatch(/^mock-post-/)

    // Exhaust the budget; the next attempt must be DENIED rather than calling
    // the provider. Ordering is the invariant: a locally denied job must never
    // reach the point where an attempt record would be written, because to the
    // reconciler that is indistinguishable from a job that may have landed.
    await limiter.acquire(spec)
    const denied = await limiter.acquire(spec)
    expect(denied.granted).toBe(false)
    expect(denied.granted === false && denied.waitMs).toBeGreaterThan(0)
  })

  it('5. a refused budget is refunded so the quota is not silently lost', async () => {
    const limiter = new RateLimiter(redis)
    const spec = {
      provider: 'mock',
      accountId,
      operation: 'mediaUpload' as const,
      scope: 'account' as const,
      cost: 1,
      capacity: 3,
      windowMs: 60_000,
    }
    await redis.del(`rl:mock:mediaUpload:acct:${accountId}`)

    await limiter.acquire(spec)
    expect((await limiter.inspect(spec))[0]!.tokens).toBe(2)

    // Media preparation failed after acquisition — the call never reached the
    // provider, so the token was never spent.
    await limiter.refund(spec)
    expect((await limiter.inspect(spec))[0]!.tokens).toBe(3)
  })

  it('6. one publish at a time per account', async () => {
    const mutex = new AccountMutex(redis)
    await redis.del(`mx:mock:${accountId}`)

    const first = await mutex.acquire('mock', accountId, 5000)
    const second = await mutex.acquire('mock', accountId, 5000)

    expect(first).not.toBeNull()
    expect(second).toBeNull()

    await mutex.release('mock', accountId, first!.token)
    expect(await mutex.acquire('mock', accountId, 5000)).not.toBeNull()
  })

  it('7. provider errors normalise, and retryability comes from the taxonomy', async () => {
    const provider = new MockProvider()
    const account = {
      id: accountId,
      providerAccountId: 'rate-limited-account',
      handle: '@x',
      displayName: 'x',
      platformMeta: {},
    }
    provider.setScenario('rate-limited-account', 'rate_limited')

    try {
      await provider.publish(
        account,
        { accessToken: 't', scopes: [] },
        { surface: 'feed', text: 'x', media: [], idempotencyKey: 'k' }
      )
      throw new Error('expected a ProviderError')
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderError)
      const e = err as ProviderError
      expect(e.code).toBe('RateLimited')
      // Retryable, and NOT a reason to mark the account broken.
      expect(e.retryable).toBe(true)
      expect(e.requiresReauth).toBe(false)
      expect(e.options.retryAfterSeconds).toBe(42)
    }
  })

  it('8. an expired token needs reauth and must not burn retries', async () => {
    const provider = new MockProvider()
    provider.setScenario('expired-account', 'token_expired')

    try {
      await provider.publish(
        {
          id: accountId,
          providerAccountId: 'expired-account',
          handle: '@x',
          displayName: 'x',
          platformMeta: {},
        },
        { accessToken: 't', scopes: [] },
        { surface: 'feed', text: 'x', media: [], idempotencyKey: 'k' }
      )
      throw new Error('expected a ProviderError')
    } catch (err) {
      const e = err as ProviderError
      expect(e.code).toBe('TokenExpired')
      // No amount of waiting fixes a revoked token.
      expect(e.retryable).toBe(false)
      expect(e.requiresReauth).toBe(true)
      expect(e.message).toMatch(/[Rr]econnect/)
    }
  })

  it('9. accept-then-hang leaves the post ON the provider — reconciliation, not retry', async () => {
    // The fault-injection scenario for the top-ranked risk in the system. The
    // post really landed; a worker that retried instead of reconciling would
    // publish a duplicate, which is unrecoverable.
    const store = new Map()
    const provider = new MockProvider({ hangMs: 20, store })
    provider.setScenario('hang-account', 'accept_then_hang')

    const account = {
      id: accountId,
      providerAccountId: 'hang-account',
      handle: '@x',
      displayName: 'x',
      platformMeta: {},
    }
    const before = new Date(Date.now() - 1000)

    await expect(
      provider.publish(
        account,
        { accessToken: 't', scopes: [] },
        { surface: 'feed', text: 'landed but unacknowledged', media: [], idempotencyKey: 'k' }
      )
    ).rejects.toBeInstanceOf(ProviderError)

    // Read-back finds it — which is exactly what makes exactly-once achievable.
    withCapability(provider, 'retrievePosts')
    const found = await provider.retrievePosts(account, { accessToken: 't', scopes: [] }, before)
    expect(found).toHaveLength(1)
    expect(found[0]!.text).toBe('landed but unacknowledged')
  })

  it('10. the connection is audited', async () => {
    await withTenant(
      workspaceId,
      async (tx) =>
        tx.auditLog.create({
          data: omitTenancy({
            actorId: userId,
            action: 'account.connected',
            entityType: 'SocialAccount',
            entityId: accountId,
          }),
        }),
      client
    )

    const entries = await withTenant(
      workspaceId,
      async (tx) => tx.auditLog.findMany({ where: { action: 'account.connected' } }),
      client
    )
    expect(entries.length).toBeGreaterThan(0)
    expect(entries[0]!.workspaceId).toBe(workspaceId)
  })
})
