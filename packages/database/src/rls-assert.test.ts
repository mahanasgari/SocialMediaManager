import { afterAll, describe, expect, it } from 'vitest'
import { createTestClient, type Db } from './client.js'
import { assertRlsApplies, rlsStatus, RlsBypassDetected } from './rls-assert.js'
import { exemptReason } from './models.js'

/**
 * Regression guard for a failure that every configuration check reported as fine.
 *
 * RLS was enabled, FORCE ROW LEVEL SECURITY was set, and all four policies were
 * present in pg_policies — yet raw SQL returned every tenant's rows, because the
 * application connected as a superuser. FORCE removes the table OWNER's
 * exemption; it does nothing about a superuser or a role with BYPASSRLS.
 *
 * These tests run against BOTH roles, so they assert the difference rather than
 * asserting the configuration we hope produces it.
 */

const appUrl = process.env['TEST_DATABASE_URL']
const ownerUrl = process.env['TEST_DATABASE_OWNER_URL']

const suite = appUrl && ownerUrl ? describe : describe.skip
if (!appUrl || !ownerUrl) {
  console.warn(
    '\n  [skipped] RLS enforcement suite — needs TEST_DATABASE_URL (unprivileged)\n' +
      '  and TEST_DATABASE_OWNER_URL (superuser). Run: bash scripts/test-db.sh up\n'
  )
}

const clients: Db[] = []
function client(url: string): Db {
  const c = createTestClient(url)
  clients.push(c)
  return c
}

afterAll(async () => {
  await Promise.all(clients.map((c) => c.$disconnect()))
})

suite('RLS enforcement', () => {
  it('the application role cannot bypass RLS', async () => {
    const status = await rlsStatus(client(appUrl!))
    expect(status.enforced).toBe(true)
    expect(status.reasons).toEqual([])
  })

  it('the owner role CAN bypass RLS — which is why the app must not use it', async () => {
    // This is the whole finding. The owner is a superuser in the official
    // postgres image, so connecting as it makes every policy silently inert.
    const status = await rlsStatus(client(ownerUrl!))
    expect(status.enforced).toBe(false)
    expect(status.reasons).toContain('SUPERUSER')
  })

  it('assertRlsApplies passes for the application role', async () => {
    await expect(assertRlsApplies(client(appUrl!))).resolves.toBeUndefined()
  })

  it('assertRlsApplies refuses to start on a bypassing role', async () => {
    await expect(assertRlsApplies(client(ownerUrl!))).rejects.toThrow(RlsBypassDetected)
  })

  it('the refusal explains what to do, not merely that it failed', async () => {
    try {
      await assertRlsApplies(client(ownerUrl!))
      throw new Error('expected the assertion to reject')
    } catch (err) {
      const message = (err as Error).message
      expect(message).toMatch(/smm_app/)
      expect(message).toMatch(/MIGRATE_DATABASE_URL/)
      // Says what actually goes wrong, not just "misconfigured".
      expect(message).toMatch(/every workspace would be able to read/)
    }
  })

  it('allowBypass lets migrations and fixtures through explicitly', async () => {
    // The escape exists, but it is an argument someone had to type — not a
    // default that quietly applies everywhere.
    await expect(assertRlsApplies(client(ownerUrl!), true)).resolves.toBeUndefined()
  })

  it('policies are enforced in practice, not merely declared', async () => {
    // The configuration-level check (relrowsecurity, relforcerowsecurity,
    // pg_policies) reported everything correct while the behaviour was wrong.
    // Only a real query distinguishes the two.
    const app = client(appUrl!)
    const owner = client(ownerUrl!)

    const asApp = await app.$queryRaw<Array<{ count: bigint }>>`SELECT count(*) FROM "Workspace"`
    const asOwner = await owner.$queryRaw<Array<{ count: bigint }>>`SELECT count(*) FROM "Workspace"`

    expect(Number(asApp[0]?.count ?? -1)).toBe(0)
    expect(Number(asOwner[0]?.count ?? 0)).toBeGreaterThanOrEqual(0)
  })
})

/**
 * Every model carrying an organizationId must have a policy that can SEE it.
 *
 * This exists because the failure mode is silent and was found by accident. The
 * Prisma tenancy extension permits an organization-scoped query on any model
 * with an organizationId column; if the RLS policy only matches on
 * workspaceId, the query runs, every row is filtered out, and the caller gets
 * an empty result with no error at all.
 *
 * An organization-wide count of webhooks returned 0 with rows plainly present.
 * Five models were affected. Nothing would have caught it, because "no rows" is
 * a perfectly ordinary answer.
 */
suite('organization scope reaches every model that claims it', () => {
  it('has no model with an organizationId whose policy ignores it', async () => {
    const owner = createTestClient(ownerUrl!)
    try {
      const rows = await owner.$queryRawUnsafe<Array<{ relname: string }>>(`
        SELECT c.relname
        FROM pg_policy p
        JOIN pg_class c ON c.oid = p.polrelid
        WHERE p.polname LIKE '%tenant_isolation%'
          AND pg_get_expr(p.polqual, p.polrelid) NOT LIKE '%current_organization%'
          AND EXISTS (
            SELECT 1 FROM information_schema.columns col
            WHERE col.table_name = c.relname AND col.column_name = 'organizationId'
          )
      `)

      expect(
        rows.map((r) => r.relname),
        'these models carry an organizationId but their RLS policy cannot match on it, ' +
          'so an organization-scoped read returns zero rows with no error'
      ).toEqual([])
    } finally {
      await owner.$disconnect()
    }
  })

  it('has a tenant isolation policy on every tenant-scoped table', async () => {
    const owner = createTestClient(ownerUrl!)
    try {
      const rows = await owner.$queryRawUnsafe<Array<{ table_name: string }>>(`
        SELECT col.table_name
        FROM information_schema.columns col
        JOIN pg_class c ON c.relname = col.table_name
        WHERE col.column_name = 'workspaceId'
          AND col.table_schema = 'public'
          AND NOT EXISTS (
            SELECT 1 FROM pg_policy p
            WHERE p.polrelid = c.oid AND p.polname LIKE '%tenant_isolation%'
          )
      `)

      // A table with a workspaceId and no isolation policy is a cross-tenant
      // read waiting to happen, and it would never announce itself.
      //
      // Exemptions come from the SAME list the tenancy guard uses, so a model
      // can only be excused here if someone wrote down why there. Outbox is
      // exempt because a system-wide dispatcher must scan across workspaces.
      const unexplained = rows
        .map((r) => r.table_name)
        .filter((name) => !exemptReason(name))

      expect(unexplained).toEqual([])
    } finally {
      await owner.$disconnect()
    }
  })
})
