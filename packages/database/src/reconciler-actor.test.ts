import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestClient, withReconciler, withTenant, withSystemScope, type Db } from './client.js'

/**
 * The reconciler actor, asserted against the live database.
 *
 * This is the fifth time a cross-cutting query that precedes tenancy has needed
 * a named actor, and twice it shipped as a bug first. The failure has no
 * symptoms: RLS is working exactly as configured, the query is valid, and it
 * returns zero rows forever. Nothing throws. Nothing logs. The sweep reports
 * success having found nothing to do.
 *
 * Here that silence would mean interrupted publishes are never recovered, which
 * is the top-ranked risk in the system. So the invariant is asserted directly
 * rather than left to the fault-injection harness to discover — that harness
 * runs against a seeded database where a bug in this policy would look like a
 * passing test with an empty batch.
 *
 * The second half matters as much as the first: the actor must be NARROW. An
 * actor that can read everything is a bypass with a nicer name.
 */

const appUrl = process.env['TEST_DATABASE_URL']
const ownerUrl = process.env['TEST_DATABASE_OWNER_URL']

const suite = appUrl && ownerUrl ? describe : describe.skip
if (!appUrl || !ownerUrl) {
  console.warn('\n  [skipped] reconciler actor — run: bash scripts/test-db.sh up\n')
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const omitTenancy = <T,>(data: T) => data as any

let app: Db
let owner: Db
let orgId: string
let userId: string
let workspaceId: string
let variantId: string

suite('the reconciler actor', () => {
  beforeAll(async () => {
    app = createTestClient(appUrl!)
    owner = createTestClient(ownerUrl!)

    const stamp = Date.now()
    await withSystemScope(
      'reconciler actor fixture',
      async () => {
        const org = await owner.organization.create({
          data: { name: 'Recon Org', slug: `recon-${stamp}` },
        })
        orgId = org.id
        const user = await owner.user.create({
          data: { email: `recon-${stamp}@example.com`, passwordHash: 'x', name: 'Recon' },
        })
        userId = user.id
        const ws = await owner.workspace.create({
          data: omitTenancy({ organizationId: orgId, name: 'Recon WS', slug: `recon-${stamp}` }),
        })
        workspaceId = ws.id
        const account = await owner.socialAccount.create({
          data: omitTenancy({
            organizationId: orgId,
            workspaceId,
            provider: 'mock',
            providerAccountId: `recon-${stamp}`,
            handle: '@recon',
            displayName: 'Recon',
            surfaces: ['feed'],
          }),
        })
        const post = await owner.post.create({
          data: omitTenancy({
            organizationId: orgId,
            workspaceId,
            authorId: userId,
            baseContent: 'recon',
            status: 'SCHEDULED',
          }),
        })
        const variant = await owner.postVariant.create({
          data: omitTenancy({
            organizationId: orgId,
            workspaceId,
            postId: post.id,
            socialAccountId: account.id,
            surface: 'feed',
            status: 'PUBLISHING',
          }),
        })
        variantId = variant.id
        await owner.publishAttempt.create({
          data: omitTenancy({
            workspaceId,
            postVariantId: variantId,
            idempotencyKey: `recon-${stamp}`,
            status: 'IN_FLIGHT',
            startedAt: new Date(Date.now() - 60 * 60_000),
          }),
        })
    })
  }, 60_000)

  afterAll(async () => {
    await withSystemScope(
      'reconciler actor teardown',
      async () => {
        await owner.organization.delete({ where: { id: orgId } })
        await owner.user.delete({ where: { id: userId } })
    })
    await app.$disconnect()
    await owner.$disconnect()
  }, 30_000)

  it('finds a stale attempt without knowing which workspace it belongs to', async () => {
    // The query the sweep actually runs. No workspace is supplied, because at
    // this point none is known — that is the entire problem being solved.
    const found = await withReconciler(
      (tx) =>
        tx.publishAttempt.findMany({
          where: { status: 'IN_FLIGHT', startedAt: { lt: new Date() } },
          select: { postVariantId: true, workspaceId: true },
        }),
      app
    )

    expect(found.some((a) => a.postVariantId === variantId)).toBe(true)
  })

  it('returns nothing for the same query under a different tenant', async () => {
    // The control. Without the actor this is what the sweep saw: a valid query,
    // no error, and an empty result forever.
    const other = await withTenant(
      '00000000-0000-7000-8000-000000000000',
      (tx) => tx.publishAttempt.findMany({ where: { status: 'IN_FLIGHT' } }),
      app
    )
    expect(other.some((a) => a.postVariantId === variantId)).toBe(false)
  })

  it('cannot read a credential', async () => {
    // The narrowness assertion. A reconciler that can reach OAuthCredential is
    // a cross-tenant credential read one bug away, and it has no need for one:
    // everything past discovery runs under withTenant().
    const credentials = await withReconciler(
      (tx) => tx.oAuthCredential.findMany({ select: { id: true } }),
      app
    )
    expect(credentials).toEqual([])
  })

  it('cannot read posts or accounts', async () => {
    const [posts, accounts] = await withReconciler(
      async (tx) => [
        await tx.post.findMany({ select: { id: true } }),
        await tx.socialAccount.findMany({ select: { id: true } }),
      ],
      app
    )
    expect(posts).toEqual([])
    expect(accounts).toEqual([])
  })

  it('cannot close an attempt it has found', async () => {
    // SELECT only. Resolving an attempt is a decision, and decisions are made
    // under a tenant scope by the same code the live publisher uses.
    const changed = await withReconciler(
      (tx) =>
        tx.publishAttempt.updateMany({
          where: { postVariantId: variantId },
          data: { status: 'FAILED' },
        }),
      app
    )
    expect(changed.count).toBe(0)

    const still = await withReconciler(
      (tx) => tx.publishAttempt.findMany({ where: { postVariantId: variantId } }),
      app
    )
    expect(still[0]!.status).toBe('IN_FLIGHT')
  })
})
