import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * The tenant scope in force on the current async execution path.
 *
 * `system` is a deliberate, named escape hatch rather than an absence of scope.
 * Requiring a reason string means every bypass is greppable and shows up in
 * review, which an implicit "no scope" never would.
 */
export type TenantScope =
  | { kind: 'workspace'; workspaceId: string; organizationId?: string }
  | { kind: 'organization'; organizationId: string }
  | { kind: 'system'; reason: string }

export const scopeStorage = new AsyncLocalStorage<TenantScope>()

export function currentScope(): TenantScope | undefined {
  return scopeStorage.getStore()
}

/**
 * Thrown when a tenant-scoped model is queried with no scope in force.
 *
 * A loud error is the point. The alternative — returning every tenant's rows —
 * is the worst outcome in the system, and it looks like success.
 */
export class MissingTenantScope extends Error {
  override readonly name = 'MissingTenantScope'

  constructor(model: string, operation: string) {
    super(
      `${model}.${operation} was called with no tenant scope in force. ` +
        `Wrap the call in withTenant(workspaceId, ...) or withOrganization(organizationId, ...). ` +
        `If this genuinely must span tenants, use withSystemScope('<reason>', ...) — which is ` +
        `deliberately explicit so the bypass is visible in review.`
    )
  }
}

/**
 * Thrown when the scope in force cannot satisfy the model being queried — for
 * example an organization scope reaching a workspace-scoped model.
 */
export class TenantScopeMismatch extends Error {
  override readonly name = 'TenantScopeMismatch'

  constructor(model: string, required: string, actual: string) {
    super(
      `${model} requires a ${required} scope but a ${actual} scope is in force. ` +
        `Narrow the scope before querying this model.`
    )
  }
}
