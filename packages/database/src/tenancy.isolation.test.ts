import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { assertOutsideTransaction, TransactionBoundaryViolation } from '@smm/config'
import {
  createTestClient,
  withTenant,
  withOrganization,
  withUser,
  withSystemScope,
  type Db,
} from './client.js'
import { MissingTenantScope } from './scope.js'
import { withDeleted } from './soft-delete.js'
import { TENANT_MODELS } from './models.js'

/**
 * Tenant isolation suite — CI gate G1.
 *
 * The important property is that this suite ENUMERATES tenant-scoped models from
 * the Prisma DMMF rather than testing a hand-written list. Adding a model with a
 * `workspaceId` automatically brings it under these assertions, so forgetting
 * isolation fails CI instead of shipping quietly. Nobody has to remember to
 * write the test — which is the only way a rule like this survives contact with
 * a growing schema.
 *
 * Requires a live Postgres with migrations applied. Set TEST_DATABASE_URL.
 */

const url = process.env['TEST_DATABASE_URL']

const suite = url ? describe : describe.skip
if (!url) {
  console.warn(
    '\n  [skipped] tenant isolation suite — set TEST_DATABASE_URL to a Postgres\n' +
      '  instance with migrations applied. CI provides one; see .github/workflows/ci.yml.\n'
  )
}

let client: Db
let orgId: string
let wsA: string
let wsB: string
let userId: string

/**
 * Prisma's generated create types still require the tenancy columns the
 * extension injects at runtime — they are produced from the schema and cannot
 * know an extension supplies them. See the note in beforeAll.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const omitTenancyStatic = <T,>(data: T) => data as any

suite('tenant isolation', () => {
  beforeAll(async () => {
    client = createTestClient(url!)

    // Organization and User are not workspace-scoped and carry no RLS policy,
    // so they are created under a system scope.
    await withSystemScope('integration test fixture setup', async () => {
      const org = await client.organization.create({
        data: { name: 'Test Org', slug: `org-${Date.now()}` },
      })
      orgId = org.id

      const user = await client.user.create({
        data: { email: `t-${Date.now()}@example.com`, passwordHash: 'x', name: 'T' },
      })
      userId = user.id
    })

    // Everything below is under RLS, and a workspace cannot be created under a
    // workspace scope — its policy keys on the row's own id, which does not
    // exist until the insert happens. Organization scope is the only way in.
    /**
     * The tenancy columns are omitted on purpose — the extension stamps them.
     *
     * The cast is needed because Prisma's generated create types still list
     * `organizationId` as required: they are produced from the schema and cannot
     * know an extension supplies it at runtime. That is a genuine ergonomic cost
     * of the injecting-extension design, and it applies to every create call
     * site, not just this fixture. Worth revisiting with generated helper types
     * once there are enough models for it to bite.
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const omitTenancy = <T>(data: T) => data as any

    await withOrganization(
      orgId,
      async (tx) => {
        const a = await tx.workspace.create({ data: omitTenancy({ name: 'A', slug: 'a' }) })
        const b = await tx.workspace.create({ data: omitTenancy({ name: 'B', slug: 'b' }) })
        wsA = a.id
        wsB = b.id

        for (const ws of [wsA, wsB]) {
          await tx.membership.create({
            data: omitTenancy({ userId, workspaceId: ws, role: 'ADMIN' }),
          })
          await tx.auditLog.create({
            data: omitTenancy({
              workspaceId: ws,
              actorId: userId,
              action: 'test.seed',
              entityType: 'Workspace',
              entityId: ws,
            }),
          })
        }
      },
      client
    )
  })

  afterAll(async () => {
    await withSystemScope('integration test teardown', async () => {
      await client.organization.delete({ where: { id: orgId } })
      await client.user.delete({ where: { id: userId } })
    })
    await client.$disconnect()
  })

  // -------------------------------------------------------------------------
  // The enumerated core
  // -------------------------------------------------------------------------

  const workspaceScoped = TENANT_MODELS.filter((m) => m.supports.includes('workspace'))

  it.each(workspaceScoped.map((m) => [m.name] as const))(
    '%s: a workspace scope sees none of the other workspace rows',
    async (name) => {
      const key = (name.charAt(0).toLowerCase() + name.slice(1)) as keyof Db
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const delegate = (c: Db) => (c as any)[key]

      const inA = await withTenant(wsA, async (tx) => delegate(tx).findMany({}), client)
      const inB = await withTenant(wsB, async (tx) => delegate(tx).findMany({}), client)

      const idsA = new Set(inA.map((r: { id: string }) => r.id))
      for (const row of inB as Array<{ id: string }>) {
        expect(idsA.has(row.id), `${name} row ${row.id} leaked across workspaces`).toBe(false)
      }
    }
  )

  it.each(workspaceScoped.map((m) => [m.name] as const))(
    '%s: querying with no scope throws instead of returning every tenant',
    async (name) => {
      const key = (name.charAt(0).toLowerCase() + name.slice(1)) as keyof Db
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await expect((client as any)[key].findMany({})).rejects.toThrow(MissingTenantScope)
    }
  )

  it('a lookup by id cannot reach across workspaces', async () => {
    const foreign = await withTenant(wsB, async (tx) => tx.auditLog.findFirst({}), client)
    expect(foreign).not.toBeNull()

    const found = await withTenant(
      wsA,
      async (tx) => tx.auditLog.findUnique({ where: { id: foreign!.id } }),
      client
    )
    // The row exists, but not for this tenant. findUnique must not become a
    // cross-tenant read just because the caller happens to know an id.
    expect(found).toBeNull()
  })

  it('a create is stamped with the active workspace, not the one the caller passed', async () => {
    const row = await withTenant(
      wsA,
      async (tx) =>
        tx.auditLog.create({
          data: {
            organizationId: orgId,
            workspaceId: wsB, // spoofed
            action: 'test.spoof',
            entityType: 'Test',
          },
        }),
      client
    )
    expect(row.workspaceId).toBe(wsA)
  })

  // -------------------------------------------------------------------------
  // Soft delete
  // -------------------------------------------------------------------------

  it('soft-deleted rows are invisible to normal reads and visible under withDeleted', async () => {
    const created = await withTenant(
      wsA,
      async (tx) =>
        tx.invite.create({
          data: {
            organizationId: orgId,
            email: 'gone@example.com',
            role: 'VIEWER',
            tokenHash: `h-${Date.now()}`,
            expiresAt: new Date(Date.now() + 86_400_000),
            invitedById: userId,
          },
        }),
      client
    )

    await withTenant(
      wsA,
      async (tx) =>
        tx.invite.update({ where: { id: created.id }, data: { deletedAt: new Date() } }),
      client
    )

    const normal = await withTenant(
      wsA,
      async (tx) => tx.invite.findUnique({ where: { id: created.id } }),
      client
    )
    expect(normal).toBeNull()

    const included = await withDeleted(() =>
      withTenant(wsA, async (tx) => tx.invite.findUnique({ where: { id: created.id } }), client)
    )
    expect(included?.id).toBe(created.id)
  })

  // -------------------------------------------------------------------------
  // The failure modes that motivated the design
  // -------------------------------------------------------------------------

  it('pooled connections do not leak tenant context between units of work', async () => {
    // Interleaved on the same client, so they contend for the same pool. If the
    // context were set with SET rather than SET LOCAL, whichever ran second
    // could inherit the first one's workspace — a silent cross-tenant leak that
    // no error would ever reveal.
    const [a, b] = await Promise.all([
      withTenant(wsA, async (tx) => tx.auditLog.findMany({ select: { workspaceId: true } }), client),
      withTenant(wsB, async (tx) => tx.auditLog.findMany({ select: { workspaceId: true } }), client),
    ])

    expect(a.every((r) => r.workspaceId === wsA)).toBe(true)
    expect(b.every((r) => r.workspaceId === wsB)).toBe(true)
  })

  it('I/O inside a transaction throws rather than pinning a connection', async () => {
    // A provider HTTP call here would hold a Postgres connection for the call's
    // whole duration; under load the pool exhausts and the deployment stalls,
    // presenting as a database problem that is actually an HTTP problem.
    await expect(
      withTenant(
        wsA,
        async () => {
          assertOutsideTransaction('provider HTTP request')
          return null
        },
        client
      )
    ).rejects.toThrow(TransactionBoundaryViolation)
  })

  it('RLS blocks raw SQL that the client extension never sees', async () => {
    // $queryRaw bypasses the extension entirely. This is the case RLS exists
    // for: with no app.current_workspace set, the policy matches nothing.
    const rows = await withSystemScope('deliberate raw query without tenant context', () =>
      client.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "Workspace"`
    )
    expect(rows).toHaveLength(0)
  })

  it('RLS admits exactly one workspace once the context is set', async () => {
    const rows = await withTenant(
      wsA,
      async (tx) => tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "Workspace"`,
      client
    )
    expect(rows.map((r) => r.id)).toEqual([wsA])
  })

  // -------------------------------------------------------------------------
  // Per-user scope — the query that precedes tenancy
  // -------------------------------------------------------------------------

  it('a user can discover their own memberships without a tenant scope', async () => {
    // This is the query that has no workspace to scope by, because discovering
    // the answer is how you learn what to scope by. With only tenant-keyed
    // policies it returned zero rows, and a freshly registered user saw an empty
    // workspace list — correct RLS, broken product.
    const rows = await withUser(
      userId,
      'membership discovery',
      async (tx) => tx.membership.findMany({ where: { userId }, select: { workspaceId: true } }),
      client
    )
    const ids = rows.map((r) => r.workspaceId)
    expect(ids).toContain(wsA)
    expect(ids).toContain(wsB)
  })

  it('a user can read the workspaces their memberships grant', async () => {
    const rows = await withUser(
      userId,
      'workspace discovery',
      async (tx) => tx.workspace.findMany({ select: { id: true } }),
      client
    )
    expect(rows.map((r) => r.id).sort()).toEqual([wsA, wsB].sort())
  })

  it('a DIFFERENT user sees none of them', async () => {
    // The self-read policies must grant access to the user's own rows only.
    // A policy that leaked here would be worse than no policy, because the
    // membership query runs on every single request.
    const stranger = await withSystemScope('fixture: unrelated user', async () =>
      client.user.create({
        data: { email: `stranger-${Date.now()}@example.com`, passwordHash: 'x', name: 'S' },
      })
    )

    const memberships = await withUser(
      stranger.id,
      'membership discovery',
      async (tx) => tx.membership.findMany({}),
      client
    )
    const workspaces = await withUser(
      stranger.id,
      'workspace discovery',
      async (tx) => tx.workspace.findMany({}),
      client
    )

    expect(memberships).toHaveLength(0)
    expect(workspaces).toHaveLength(0)

    await withSystemScope('fixture cleanup', async () =>
      client.user.delete({ where: { id: stranger.id } })
    )
  })

  it('the self-read policies are SELECT-only — visibility does not imply write', async () => {
    // Being able to see a workspace must not let a user grant themselves a role
    // in it. Writes still require an organization scope.
    await expect(
      withUser(
        userId,
        'attempted self-grant',
        async (tx) =>
          tx.membership.create({
            data: omitTenancyStatic({ userId, workspaceId: wsA, role: 'OWNER' }),
          }),
        client
      )
    ).rejects.toThrow()
  })

  // -------------------------------------------------------------------------
  // Organization scope
  // -------------------------------------------------------------------------

  it('an organization scope spans its workspaces but not other organizations', async () => {
    const members = await withOrganization(
      orgId,
      async (tx) => tx.membership.findMany({ select: { organizationId: true } }),
      client
    )
    expect(members.length).toBeGreaterThan(0)
    expect(members.every((m) => m.organizationId === orgId)).toBe(true)
  })
})
