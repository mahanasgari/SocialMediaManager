import { Prisma } from '@prisma/client'
import { currentScope, MissingTenantScope } from './scope.js'
import { tenantModel } from './models.js'
import { deletedIncluded } from './soft-delete.js'
import {
  buildCreateData,
  buildWhere,
  CREATE_OPS,
  FILTER_WHERE_OPS,
  scopeDataFor,
  scopeFilterFor,
  UNIQUE_WHERE_OPS,
} from './predicate.js'

/**
 * The tenancy client extension — the PRIMARY isolation guard.
 *
 * Two responsibilities, applied to every operation on a tenant-scoped model:
 *
 *   1. Inject the active tenant scope into `where` (reads, updates, deletes) and
 *      into `data` (creates). With no scope in force it THROWS, rather than
 *      returning every tenant's rows.
 *
 *   2. Filter `deletedAt: null` on soft-deletable models, unless the caller
 *      opted in through withDeleted().
 *
 * Postgres RLS (prisma/migrations/*_rls) is the SECONDARY guard, covering what
 * this extension cannot see: $queryRaw, and any future path that bypasses the
 * Prisma client entirely.
 *
 * The decision logic lives in predicate.ts as pure functions, so the part that
 * determines what a tenant can see is exhaustively unit-testable without a
 * database. This file is deliberately close to plumbing.
 */
export function tenancyExtension() {
  return Prisma.defineExtension((client) =>
    client.$extends({
      name: 'smm-tenancy',
      query: {
        $allModels: {
          async $allOperations({ model, operation, args, query }) {
            const meta = tenantModel(model)
            if (!meta) return query(args)

            const scope = currentScope()
            if (!scope) throw new MissingTenantScope(model, operation)

            const applySoftDelete =
              meta.softDeletable && !deletedIncluded() && scope.kind !== 'system'

            const mutable = { ...((args ?? {}) as Record<string, unknown>) }

            if (UNIQUE_WHERE_OPS.has(operation) || FILTER_WHERE_OPS.has(operation)) {
              mutable['where'] = buildWhere({
                operation,
                existingWhere: mutable['where'],
                filter: scopeFilterFor(meta, scope),
                applySoftDelete,
              })
            }

            if (CREATE_OPS.has(operation)) {
              mutable['data'] = buildCreateData(mutable['data'], scopeDataFor(meta, scope))
            }

            if (operation === 'upsert') {
              mutable['create'] = buildCreateData(mutable['create'], scopeDataFor(meta, scope))
            }

            return query(mutable)
          },
        },
      },
    })
  )
}
