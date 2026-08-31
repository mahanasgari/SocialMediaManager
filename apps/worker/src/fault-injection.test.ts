import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, afterEach, describe, expect, it } from 'vitest'
import { Redis } from 'ioredis'
import {
  createTestClient,
  encrypt,
  EnvKeyProvider,
  keyIdOf,
  withOrganization,
  withSystemScope,
  withTenant,
  type Db,
} from '@smm/database'
import { FileLedger } from '@smm/providers'

/**
 * FAULT INJECTION — risk #1, the only one that cannot be undone.
 *
 * A duplicate public post is unrecoverable. You cannot un-send it, on most
 * networks you cannot tell which copy people saw, and on a client account it is
 * the kind of mistake that ends the relationship. Everything else in this
 * system can be retried, rolled back or apologised for. This cannot.
 *
 * The plan says this needs its own harness "because duplicate job execution
 * does not exercise the real failure", and that is exactly right. Running the
 * same job twice tests a scheduler. The real failure is a process that dies
 * mid-flight: the attempt row is committed, the post may already be public, and
 * the only thing that knew the outcome is gone.
 *
 * So this spawns a REAL worker process and SIGKILLs it. Not a mock, not a
 * thrown error, not process.exit — all three of those unwind cleanly, and
 * "cleanly" is the one thing an OOM kill is not. No handlers, no finally
 * blocks, no lease release, no connection teardown. Just a committed row and
 * silence.
 *
 * The kill is triggered by polling the DATABASE for the IN_FLIGHT row, so the
 * moment of death is defined by the same state the reconciler will later read,
 * rather than by anything the dying process claims about itself.
 *
 * Three scenarios, from the plan:
 *   1. Provider HAS read-back and the post landed  -> PUBLISHED, not republished
 *   2. Provider HAS read-back and it did NOT land  -> requeued, safe to retry
 *   3. Provider has NO read-back                   -> NEEDS_REVIEW, ask a human
 */

const dbUrl = process.env['TEST_DATABASE_URL']
const ownerUrl = process.env['TEST_DATABASE_OWNER_URL'] ?? dbUrl
const redisUrl = process.env['TEST_REDIS_URL']

const suite = dbUrl && redisUrl ? describe : describe.skip
if (!dbUrl || !redisUrl) {
  console.warn('\n  [skipped] fault injection — run: bash scripts/test-db.sh up\n')
}

const KEY = Buffer.alloc(32, 9).toString('base64')
const keys = new EnvKeyProvider(KEY)
const here = fileURLToPath(new URL('.', import.meta.url))

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const omitTenancy = <T,>(data: T) => data as any

let client: Db
let redis: Redis
let orgId: string
let userId: string
let workspaceId: string
let tempDir: string
let children: ChildProcess[] = []

/** Waits for a predicate, polling. Returns false on timeout rather than throwing. */
async function until(check: () => Promise<boolean>, timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  return false
}

suite('fault injection: a worker killed mid-publish', () => {
  beforeAll(async () => {
    client = createTestClient(dbUrl!)
    redis = new Redis(redisUrl!)
    tempDir = mkdtempSync(join(tmpdir(), 'smm-fault-'))

    await withSystemScope('fault fixture', async () => {
      const org = await client.organization.create({
        data: { name: 'Fault Org', slug: `fault-${Date.now()}` },
      })
      orgId = org.id
      const user = await client.user.create({
        data: { email: `fault-${Date.now()}@example.com`, passwordHash: 'x', name: 'Fault' },
      })
      userId = user.id
    })

    await withOrganization(
      orgId,
      async (tx) => {
        const ws = await tx.workspace.create({
          data: omitTenancy({ name: 'Fault WS', slug: `fault-${Date.now()}` }),
        })
        workspaceId = ws.id
        await tx.membership.create({ data: omitTenancy({ userId, workspaceId, role: 'OWNER' }) })
      },
      client
    )
  }, 60_000)

  afterEach(() => {
    for (const child of children) if (!child.killed) child.kill('SIGKILL')
    children = []
  })

  afterAll(async () => {
    await withSystemScope('fault teardown', async () => {
      await client.organization.delete({ where: { id: orgId } })
      await client.user.delete({ where: { id: userId } })
    })
    await client.$disconnect()
    await redis.quit()
    rmSync(tempDir, { recursive: true, force: true })
  }, 30_000)

  // -------------------------------------------------------------------------

  /** An account, a post and one variant scheduled to publish immediately. */
  async function fixture(scenario: string): Promise<{ accountId: string; variantId: string; providerAccountId: string }> {
    const providerAccountId = `fault-${Math.random().toString(36).slice(2, 10)}`
    const sealed = encrypt('fault-token', keys)

    return withTenant(
      workspaceId,
      async (tx) => {
        const account = await tx.socialAccount.create({
          data: omitTenancy({
            organizationId: orgId,
            provider: 'mock',
            providerAccountId,
            handle: `@${providerAccountId}`,
            displayName: 'Fault Account',
            surfaces: ['feed'],
            // The scenario travels on the ACCOUNT, so the child process needs
            // no arguments beyond ids and no way to disagree with the parent
            // about what the provider will do.
            platformMeta: { mockScenario: scenario },
          }),
          select: { id: true },
        })
        await tx.oAuthCredential.create({
          data: omitTenancy({
            socialAccountId: account.id,
            accessToken: sealed,
            scopes: ['write'],
            keyId: keyIdOf(sealed),
          }),
        })

        const post = await tx.post.create({
          data: omitTenancy({
            organizationId: orgId,
            authorId: userId,
            baseContent: `Fault injection ${providerAccountId}`,
            status: 'SCHEDULED',
            scheduledAt: new Date(),
          }),
          select: { id: true },
        })
        const variant = await tx.postVariant.create({
          data: omitTenancy({
            organizationId: orgId,
            postId: post.id,
            socialAccountId: account.id,
            surface: 'feed',
            status: 'QUEUED',
          }),
          select: { id: true },
        })

        return { accountId: account.id, variantId: variant.id, providerAccountId }
      },
      client
    )
  }

  /**
   * Runs a real publish in a child process and SIGKILLs it the instant the
   * IN_FLIGHT attempt row is committed.
   */
  async function killMidPublish(
    variantId: string,
    ledgerPath: string,
    extraEnv: Record<string, string> = {}
  ): Promise<void> {
    const child = spawn(
      process.execPath,
      [
        '--conditions',
        'development',
        '--import',
        '@swc-node/register/esm-register',
        join(here, 'fault-child.ts'),
        workspaceId,
        variantId,
      ],
      {
        cwd: join(here, '..'),
        env: {
          ...process.env,
          DATABASE_URL: ownerUrl!,
          REDIS_URL: redisUrl!,
          ENCRYPTION_KEY: KEY,
          PUBLIC_URL: 'http://localhost:3000',
          INTERNAL_API_URL: 'http://localhost:3001',
          S3_ENDPOINT: 'http://localhost:59000',
          S3_BUCKET: 'smm',
          S3_ACCESS_KEY_ID: 'smmadmin',
          S3_SECRET_ACCESS_KEY: 'smmadmin',
          SESSION_SECRET: KEY,
          SMM_MOCK_LEDGER: ledgerPath,
          ...extraEnv,
        },
        stdio: 'pipe',
      }
    )
    children.push(child)

    let output = ''
    child.stdout?.on('data', (d) => (output += String(d)))
    child.stderr?.on('data', (d) => (output += String(d)))

    // The kill signal is the database, not a message from the child. What the
    // reconciler will read is what decides when to pull the plug.
    const committed = await until(async () => {
      const attempt = await withTenant(
        workspaceId,
        async (tx) =>
          tx.publishAttempt.findFirst({ where: { postVariantId: variantId, status: 'IN_FLIGHT' } }),
        client
      )
      return attempt !== null
    }, 30_000)

    if (!committed) {
      child.kill('SIGKILL')
      throw new Error(`no IN_FLIGHT attempt was ever committed. Child output:\n${output}`)
    }

    child.kill('SIGKILL')
    await new Promise((r) => child.on('exit', r))

    // The lease is deliberately NOT released — a killed process releases
    // nothing. The reconciler must wait it out rather than assume the account
    // is free, so the test clears it explicitly to stand in for that expiry
    // instead of sleeping through a two-minute TTL.
    await redis.del(`mx:mock:${(await accountOf(variantId)).providerAccountId}`)
  }

  async function accountOf(variantId: string): Promise<{ providerAccountId: string }> {
    return withTenant(
      workspaceId,
      async (tx) => {
        const v = await tx.postVariant.findUniqueOrThrow({
          where: { id: variantId },
          select: { socialAccount: { select: { providerAccountId: true } } },
        })
        return v.socialAccount
      },
      client
    )
  }

  async function variantState(variantId: string) {
    return withTenant(
      workspaceId,
      async (tx) =>
        tx.postVariant.findUniqueOrThrow({
          where: { id: variantId },
          select: {
            status: true,
            remoteId: true,
            lastError: true,
            fingerprint: true,
            publishAttempts: { select: { status: true, errorCode: true } },
          },
        }),
      client
    )
  }

  /**
   * Runs the recovery sweep with the clock advanced past the staleness window.
   *
   * The mock is REGISTERED here rather than configured by environment, because
   * the registry builds its providers once, at first import. Setting
   * SMM_MOCK_LEDGER afterwards changes nothing — the instance answering
   * retrievePosts was constructed before the variable existed, holds no ledger,
   * and reports every post absent. That made the reconciliation test pass its
   * requeue assertion and fail its reconcile assertion, which is the shape of a
   * harness quietly testing the wrong thing.
   *
   * The child process needs no such care: it is a fresh process and its
   * environment is set before anything imports.
   */
  async function sweep(ledgerPath: string, noReadBack = false) {
    process.env['DATABASE_URL'] = ownerUrl!
    process.env['REDIS_URL'] = redisUrl!
    process.env['ENCRYPTION_KEY'] = KEY
    process.env['SESSION_SECRET'] = KEY
    process.env['PUBLIC_URL'] = 'http://localhost:3000'
    process.env['INTERNAL_API_URL'] = 'http://localhost:3001'
    process.env['S3_ENDPOINT'] = 'http://localhost:59000'
    process.env['S3_BUCKET'] = 'smm'
    process.env['S3_ACCESS_KEY_ID'] = 'smmadmin'
    process.env['S3_SECRET_ACCESS_KEY'] = 'smmadmin'

    const { MockProvider, registry } = await import('@smm/providers')
    registry.register(new MockProvider({ ledgerPath, noReadBack }))

    const { Publisher } = await import('@smm/publishing')
    const { recoverInterrupted } = await import('./recovery.js')

    const publisher = new Publisher()
    try {
      // Six minutes on, so the five-minute staleness threshold has passed
      // without the test spending five minutes passing it.
      return await recoverInterrupted(publisher, new Date(Date.now() + 6 * 60_000))
    } finally {
      await publisher.close()
    }
  }

  // -------------------------------------------------------------------------

  it(
    'leaves a committed IN_FLIGHT attempt and a variant stuck in PUBLISHING',
    async () => {
      const ledger = join(tempDir, 'stuck.jsonl')
      const { variantId } = await fixture('accept_then_hang')
      await killMidPublish(variantId, ledger)

      // This is the state a crash actually leaves, and it is why the sweep has
      // to exist: nothing errored, nothing retried, nothing alerted. The
      // variant simply sits here forever.
      const state = await variantState(variantId)
      expect(state.status).toBe('PUBLISHING')
      expect(state.publishAttempts).toHaveLength(1)
      expect(state.publishAttempts[0]!.status).toBe('IN_FLIGHT')

      // And the post IS public. The provider recorded it before hanging, which
      // is what makes a blind retry a duplicate rather than a no-op.
      expect(new FileLedger(ledger).all()).toHaveLength(1)
    },
    120_000
  )

  it(
    'reconciles to the post that is already live instead of publishing it twice',
    async () => {
      const ledger = join(tempDir, 'reconcile.jsonl')
      const { variantId, providerAccountId } = await fixture('accept_then_hang')
      await killMidPublish(variantId, ledger)

      const published = new FileLedger(ledger).all()
      expect(published).toHaveLength(1)

      const result = await sweep(ledger)
      expect(result.found).toBeGreaterThanOrEqual(1)
      expect(result.republishAvoided).toBeGreaterThanOrEqual(1)

      const state = await variantState(variantId)
      expect(state.status).toBe('PUBLISHED')
      // The DISCOVERED remote id, not a new one. This is the assertion the
      // whole harness exists for: the row now points at the post that is
      // already live.
      expect(state.remoteId).toBe(published[0]!.remoteId)
      expect(state.publishAttempts.map((a) => a.status)).toContain('RECONCILED')

      // And nothing new was sent. One post before the sweep, one after.
      const after = new FileLedger(ledger).all().filter((p) => p.providerAccountId === providerAccountId)
      expect(after).toHaveLength(1)
    },
    120_000
  )

  it(
    'requeues when read-back confirms the post never landed',
    async () => {
      const ledger = join(tempDir, 'absent.jsonl')
      const { variantId } = await fixture('accept_then_hang')
      await killMidPublish(variantId, ledger)

      // The ledger is thrown away, standing in for a provider that never
      // recorded the post. Confirmed absent is a genuinely different answer
      // from unknown, and it is the only case where retrying is safe.
      rmSync(ledger, { force: true })

      const result = await sweep(ledger)
      expect(result.requeued).toBeGreaterThanOrEqual(1)

      const state = await variantState(variantId)
      expect(state.status).toBe('QUEUED')
      expect(state.remoteId).toBeNull()
    },
    120_000
  )

  it(
    'asks a human when the provider offers no way to check',
    async () => {
      const ledger = join(tempDir, 'noreadback.jsonl')
      const { variantId } = await fixture('accept_then_hang')
      await killMidPublish(variantId, ledger, { SMM_MOCK_NO_READBACK: '1' })

      const result = await sweep(ledger, true)
      expect(result.needsReview).toBeGreaterThanOrEqual(1)

      const state = await variantState(variantId)
      // At-most-once plus a human beats at-least-once plus a duplicate. There
      // is no third option here — the information does not exist.
      expect(state.status).toBe('NEEDS_REVIEW')
      expect(state.lastError).toMatch(/interrupted/i)
      expect(state.remoteId).toBeNull()
    },
    120_000
  )

  it(
    'leaves an attempt alone while another worker still holds the account lease',
    async () => {
      const ledger = join(tempDir, 'leased.jsonl')
      const { variantId, providerAccountId } = await fixture('accept_then_hang')
      await killMidPublish(variantId, ledger)

      // A slow publish and a dead one are indistinguishable by age alone. The
      // lease is what tells them apart, and reconciling underneath a live
      // worker is the concurrent write the mutex exists to prevent.
      await redis.set(`mx:mock:${providerAccountId}`, '999', 'PX', 60_000)

      const result = await sweep(ledger)
      expect(result.skipped).toBeGreaterThanOrEqual(1)
      expect(result.republishAvoided).toBe(0)

      const state = await variantState(variantId)
      expect(state.status).toBe('PUBLISHING')

      await redis.del(`mx:mock:${providerAccountId}`)
    },
    120_000
  )
})
