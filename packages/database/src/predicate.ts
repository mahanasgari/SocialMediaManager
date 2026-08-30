import { TenantScopeMismatch } from './scope.js'
import type { TenantScope } from './scope.js'
import type { TenantModel } from './models.js'

/**
 * Pure predicate construction for the tenancy extension.
 *
 * Extracted from the extension so it can be unit-tested without a database.
 * The extension itself then has almost no logic of its own, which is the point:
 * the part that decides what a tenant can see is the part that most needs
 * exhaustive tests, and integration tests are too slow to enumerate every
 * operation and scope combination.
 */

export type ScopeFilter = Record<string, string>

/**
 * Operations whose `where` is a UNIQUE-where. Prisma restricts the shape here,
 * so the scope is merged as flat keys rather than wrapped in `AND`.
 */
export const UNIQUE_WHERE_OPS: ReadonlySet<string> = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'update',
  'delete',
  'upsert',
])

/** Operations taking a general filter, where `AND`-composition is safe. */
export const FILTER_WHERE_OPS: ReadonlySet<string> = new Set([
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
  'updateMany',
  'deleteMany',
])

export const CREATE_OPS: ReadonlySet<string> = new Set([
  'create',
  'createMany',
  'createManyAndReturn',
])

/** The tenancy predicate for reads, updates and deletes. */
export function scopeFilterFor(model: TenantModel, scope: TenantScope): ScopeFilter {
  if (scope.kind === 'system') return {}

  if (scope.kind === 'workspace') {
    if (!model.supports.includes('workspace')) {
      throw new TenantScopeMismatch(model.name, 'organization', 'workspace')
    }
    // Workspace is identified by its own primary key, not a workspaceId column.
    if (model.name === 'Workspace') return { id: scope.workspaceId }
    return { workspaceId: scope.workspaceId }
  }

  if (!model.supports.includes('organization')) {
    throw new TenantScopeMismatch(model.name, 'workspace', 'organization')
  }
  return { organizationId: scope.organizationId }
}

/** The tenancy columns stamped onto newly created rows. */
export function scopeDataFor(model: TenantModel, scope: TenantScope): ScopeFilter {
  if (scope.kind === 'system') return {}
  if (scope.kind === 'organization') return { organizationId: scope.organizationId }
  // A Workspace row is created under an organization scope, never a workspace one.
  if (model.name === 'Workspace') return {}
  if (!model.hasWorkspaceId) return {}

  // A workspace scope also stamps organizationId when the model carries it.
  // Several models (AuditLog, SocialAccount) require BOTH, and without this
  // every create under a workspace scope would fail on a column the caller has
  // no business supplying by hand — the whole point of the extension is that
  // tenancy columns are not the caller's problem.
  const stamped: ScopeFilter = { workspaceId: scope.workspaceId }
  if (model.hasOrganizationId && scope.organizationId) {
    stamped['organizationId'] = scope.organizationId
  }
  return stamped
}

export type WhereBuildInput = {
  operation: string
  existingWhere: unknown
  filter: ScopeFilter
  applySoftDelete: boolean
}

/**
 * Builds the final `where`.
 *
 * The guard's keys are applied LAST in both branches, so a caller passing
 * `{ workspaceId: someOtherTenant }` cannot override the scope. That direction
 * matters: the opposite precedence would turn a typo into a cross-tenant read.
 */
export function buildWhere({
  operation,
  existingWhere,
  filter,
  applySoftDelete,
}: WhereBuildInput): unknown {
  const injected: Record<string, unknown> = { ...filter }
  if (applySoftDelete) injected['deletedAt'] = null

  if (Object.keys(injected).length === 0) return existingWhere

  const existing =
    existingWhere && typeof existingWhere === 'object'
      ? (existingWhere as Record<string, unknown>)
      : undefined

  if (UNIQUE_WHERE_OPS.has(operation)) {
    // Prisma's unique-where does not accept an AND wrapper, so merge flat.
    // Extended-where-unique (Prisma 5+) permits the extra non-unique keys.
    return { ...(existing ?? {}), ...injected }
  }

  if (!existing) return injected
  return { AND: [existing, injected] }
}

/** Stamps tenancy columns onto create payloads, single or batched. */
export function buildCreateData(existingData: unknown, injected: ScopeFilter): unknown {
  if (Object.keys(injected).length === 0) return existingData

  if (Array.isArray(existingData)) {
    return existingData.map((row) => ({ ...(row as object), ...injected }))
  }
  if (existingData && typeof existingData === 'object') {
    return { ...(existingData as object), ...injected }
  }
  return injected
}
