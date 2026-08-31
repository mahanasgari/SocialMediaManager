import { PrismaClient } from '@prisma/client'
import { runInTransactionContext } from '@smm/config'
import { tenancyExtension } from './tenancy.js'
import { scopeStorage, type TenantScope } from './scope.js'

export type Db = ReturnType<typeof createClient>

function createClient(options?: ConstructorParameters<typeof PrismaClient>[0]) {
  return new PrismaClient(options).$extends(tenancyExtension())
}

let singleton: Db | undefined

/** Process-wide client. Tests construct their own with createTestClient(). */
export function db(): Db {
  singleton ??= createClient()
  return singleton
}

export function createTestClient(datasourceUrl: string): Db {
  return createClient({ datasourceUrl })
}

export async function disconnect(): Promise<void> {
  if (singleton) {
    await singleton.$disconnect()
    singleton = undefined
  }
}

/**
 * Runs `fn` as one unit of database work under a workspace scope.
 *
 * Three things happen together, and they have to:
 *
 *   1. An interactive transaction opens. Postgres RLS reads
 *      `app.current_workspace`, which is transaction-scoped, so the setting and
 *      the queries must share a transaction or RLS sees nothing.
 *
 *   2. The tenant scope is placed in AsyncLocalStorage, so the Prisma extension
 *      injects the same predicate. Belt and braces: the extension is the primary
 *      guard, RLS is the backstop for raw SQL.
 *
 *   3. Transaction state is marked active, so assertOutsideTransaction() throws
 *      if provider HTTP or S3 I/O is attempted inside. THIS IS THE POINT. A
 *      30-second provider call inside a transaction pins a Postgres connection
 *      for 30 seconds; under load the pool exhausts and the whole deployment
 *      stalls, presenting as a database problem that is actually an HTTP one.
 *
 * `set_config(..., true)` is used rather than `SET LOCAL` because Postgres does
 * not accept bind parameters in a SET statement, and interpolating a value into
 * SQL to work around that would be worse than the problem. `is_local = true`
 * makes it identical to SET LOCAL: it is rolled back at commit, so a pooled
 * connection is returned clean and pgBouncer transaction pooling stays safe.
 * Never use plain SET here — it would persist on the connection and leak into
 * the next request that borrowed it.
 *
 * Every wrapper below hands `fn` to AsyncLocalStorage through an ASYNC arrow,
 * and the `async` is load-bearing. A Prisma promise is lazy: it does not run
 * until something subscribes to it. A plain `() => fn(tx)` returns that
 * unsubscribed promise, `run()` exits, and the query then fires with no scope
 * in force — so a caller who writes `withTenant(id, (tx) => tx.post.findMany())`
 * instead of an async callback gets MissingTenantScope on a call that is
 * perfectly correct. Awaiting inside the context keeps the subscription there.
 */
export function withTenant<T>(
  workspaceId: string,
  fn: (tx: Db) => Promise<T>,
  client: Db = db()
): Promise<T> {
  return client.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_workspace', ${workspaceId}, true)`

    // One indexed primary-key lookup, so the scope can stamp organizationId on
    // models that require both columns. The alternative is every caller passing
    // it by hand, which defeats the point of the extension and produces a class
    // of errors that only appear on the first write to such a model.
    const rows = await tx.$queryRaw<Array<{ organizationId: string }>>`
      SELECT "organizationId" FROM "Workspace" WHERE "id" = ${workspaceId}::uuid
    `
    const scope: TenantScope = {
      kind: 'workspace',
      workspaceId,
      ...(rows[0] ? { organizationId: rows[0].organizationId } : {}),
    }

    return scopeStorage.run(scope, () =>
      runInTransactionContext({ active: true, workspaceId }, async () => fn(tx as Db))
    )
  })
}

/**
 * Organization-scoped unit of work.
 *
 * Sets `app.current_organization` rather than `app.current_workspace`, because
 * two legitimate operations have no single workspace answer:
 *
 *   * Creating a workspace. The Workspace policy keys on the row's own id, which
 *     does not exist until the insert happens — under a workspace scope alone, a
 *     workspace could never be created at all.
 *   * Listing across workspaces, such as every member of an organization.
 *
 * The policies accept either setting for reads, but Workspace rows may only be
 * WRITTEN under an organization scope, so a workspace scope cannot move a
 * workspace into a different organization.
 */
export function withOrganization<T>(
  organizationId: string,
  fn: (tx: Db) => Promise<T>,
  client: Db = db()
): Promise<T> {
  const scope: TenantScope = { kind: 'organization', organizationId }

  return client.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_organization', ${organizationId}, true)`
    return scopeStorage.run(scope, () =>
      runInTransactionContext({ active: true }, async () => fn(tx as Db))
    )
  })
}

/**
 * Per-user unit of work, for the query that necessarily precedes tenancy:
 * "which workspaces does this person belong to?"
 *
 * There is no workspace to scope by, because discovering the answer is how you
 * learn what to scope by. Rather than bypassing RLS for it, the database has
 * policies letting a user read their own memberships and the workspaces those
 * grant — both SELECT-only, so visibility never implies the ability to write.
 *
 * The tenant scope is `system` because no single workspace applies; the RLS
 * setting is what actually constrains the read.
 */
export function withUser<T>(
  userId: string,
  reason: string,
  fn: (tx: Db) => Promise<T>,
  client: Db = db()
): Promise<T> {
  return client.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_user', ${userId}, true)`
    return scopeStorage.run({ kind: 'system', reason }, () =>
      runInTransactionContext({ active: true }, async () => fn(tx as Db))
    )
  })
}

/**
 * The scheduler's unit of work.
 *
 * "Which posts are due?" spans every workspace by definition — one scanner
 * serves the whole deployment, so there is no single workspace to scope by.
 * Rather than bypassing RLS, the database grants this narrow actor SELECT on
 * Post and PostVariant plus UPDATE of variant status, and nothing else: it
 * cannot read a credential, touch a workspace, or alter content.
 *
 * Everything after the claim runs under withTenant(), so only the sweep itself
 * uses this.
 */
export function withScheduler<T>(fn: (tx: Db) => Promise<T>, client: Db = db()): Promise<T> {
  return client.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.scheduler', 'on', true)`
    return scopeStorage.run({ kind: 'system', reason: 'scheduler sweep across workspaces' }, () =>
      runInTransactionContext({ active: true }, async () => fn(tx as Db))
    )
  })
}

/**
 * The retention sweep.
 *
 * Like the scheduler, retention must find due rows across every workspace
 * before any tenancy exists — that is what "find everything past its deadline"
 * means. Without an actor it matched nothing and the purge reported success
 * having deleted nothing.
 *
 * A SEPARATE actor rather than a widening of `withScheduler`, because this is
 * the only actor in the system that can DELETE a workspace. That grant does not
 * belong on the one that publishes posts every thirty seconds.
 *
 * What it deliberately CANNOT read is the interesting part: not Post, not
 * SocialAccount, not OAuthCredential, not Message. It does not need to —
 * deleting the Workspace row cascades those in the database — so a bug in the
 * purge cannot turn into a data leak. It also cannot DELETE an AuditLog row,
 * only minimise one.
 */
export function withRetention<T>(fn: (tx: Db) => Promise<T>, client: Db = db()): Promise<T> {
  return client.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.retention', 'on', true)`
    return scopeStorage.run(
      { kind: 'system', reason: 'retention sweep across workspaces' },
      () => runInTransactionContext({ active: true }, async () => fn(tx as Db))
    )
  })
}

/**
 * The crash reconciler.
 *
 * "Which publishes were in flight when a worker died?" is the same shape as the
 * scheduler and retention sweeps: a cross-cutting query that legitimately runs
 * BEFORE any tenant is known. Under tenant-keyed RLS it matches nothing, and
 * nothing errors — the sweep reports success having found no stale attempts,
 * forever, while variants sit stuck in PUBLISHING.
 *
 * A separate actor rather than a widening of withScheduler(), because this is
 * the only one that reads PublishAttempt — the record of what we sent to a
 * third party and when. That grant does not belong on the actor that asks which
 * posts are due every thirty seconds.
 *
 * SELECT only, and only on PublishAttempt. This finds candidate ids; every
 * decision and every write after that runs under withTenant() through the same
 * code the live publisher uses.
 */
export function withReconciler<T>(fn: (tx: Db) => Promise<T>, client: Db = db()): Promise<T> {
  return client.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.reconciler', 'on', true)`
    return scopeStorage.run(
      { kind: 'system', reason: 'stale publish-attempt sweep across workspaces' },
      () => runInTransactionContext({ active: true }, async () => fn(tx as Db))
    )
  })
}

/**
 * Redeeming a verification token.
 *
 * Password reset must work for someone who CANNOT SIGN IN — that is the whole
 * point of it — so there is no session, no user id, and no workspace to derive
 * a scope from. The only thing the caller holds is the token itself.
 *
 * A separate narrow actor rather than a bypass: it can read and spend
 * VerificationToken rows and nothing else. It cannot see users, posts, or
 * credentials, so a bug in the redemption path cannot become a data leak.
 */
export function withTokenRedemption<T>(fn: (tx: Db) => Promise<T>, client: Db = db()): Promise<T> {
  return client.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.token_redeem', 'on', true)`
    return scopeStorage.run(
      { kind: 'system', reason: 'verification token redemption, pre-authentication' },
      () => runInTransactionContext({ active: true }, async () => fn(tx as Db))
    )
  })
}

/**
 * The inbound webhook router.
 *
 * Routing an inbound event is a CROSS-CUTTING QUERY THAT PRECEDES TENANCY: the
 * receiver must find every SocialAccount matching a providerAccountId, across
 * every workspace, before it can know whose event this is. Deciding that is the
 * entire problem the receiver exists to solve, so no workspace scope can be set
 * beforehand.
 *
 * It is a separate actor from `withScheduler` rather than a widening of it,
 * because the failure mode here is uniquely quiet: without the grant the lookup
 * matches zero rows, every event is classified as unrouted and dropped, and
 * NOTHING logs an error — the inbox just stays empty forever. A named actor
 * makes the grant greppable and keeps it minimal: SELECT on SocialAccount, and
 * write access to the three inbound tables. It cannot read message bodies,
 * credentials, or posts.
 *
 * This is the one place in the system where workspace context derives from
 * untrusted input, which is also why the signature check happens BEFORE any of
 * this runs.
 */
export function withInboundRouter<T>(fn: (tx: Db) => Promise<T>, client: Db = db()): Promise<T> {
  return client.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.inbound_router', 'on', true)`
    return scopeStorage.run(
      { kind: 'system', reason: 'inbound webhook routing across workspaces' },
      () => runInTransactionContext({ active: true }, async () => fn(tx as Db))
    )
  })
}

/**
 * A public link-in-bio page.
 *
 * /l/:slug is served to anyone, with no session and no tenant context — the
 * page IS public, which is the entire point of the feature. The database grants
 * this actor SELECT on published pages and enabled links, plus the counter
 * update a visit causes, and nothing else. An unpublished page stays invisible
 * even to this actor.
 */
export function withPublicPage<T>(fn: (tx: Db) => Promise<T>, client: Db = db()): Promise<T> {
  return client.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.public_page', 'on', true)`
    return scopeStorage.run({ kind: 'system', reason: 'public link-in-bio page' }, () =>
      runInTransactionContext({ active: true }, async () => fn(tx as Db))
    )
  })
}

/**
 * API-key authentication.
 *
 * The key IS what establishes which workspace a request belongs to, so the
 * lookup necessarily runs before any tenant scope exists. The database grants
 * this actor SELECT on ApiKey and nothing else — it cannot read a credential, a
 * post, or a workspace. Everything after the key resolves runs under withTenant.
 */
export function withApiKeyAuth<T>(fn: (tx: Db) => Promise<T>, client: Db = db()): Promise<T> {
  return client.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.apikey_auth', 'on', true)`
    return scopeStorage.run({ kind: 'system', reason: 'API key lookup precedes tenancy' }, () =>
      runInTransactionContext({ active: true }, async () => fn(tx as Db))
    )
  })
}

/**
 * Deliberate, named escape from tenant scoping — for the outbox dispatcher, the
 * scheduler, the purge job, and the admin console.
 *
 * The `reason` is required so every bypass is greppable and shows up in review.
 * An implicit "no scope" would be invisible, which is exactly how a cross-tenant
 * read gets shipped.
 *
 * Note this does NOT open a transaction: system work is usually a long scan, and
 * holding a connection for it is the failure mode described above.
 */
export function withSystemScope<T>(reason: string, fn: () => Promise<T>): Promise<T> {
  return scopeStorage.run({ kind: 'system', reason }, fn)
}
