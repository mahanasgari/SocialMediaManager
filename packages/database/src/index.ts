export { db, createTestClient, disconnect, withTenant, withOrganization, withUser, withScheduler, withReconciler, withInboundRouter, withTokenRedemption, withRetention, withApiKeyAuth, withPublicPage, withConnectorSettings, withConnectorSettingsWrite, withAggregator, withSystemScope } from './client.js'
export type { Db } from './client.js'

export { scopeStorage, currentScope, MissingTenantScope, TenantScopeMismatch } from './scope.js'
export type { TenantScope } from './scope.js'

export { withDeleted, deletedIncluded } from './soft-delete.js'

export { TENANT_MODELS, SOFT_DELETABLE, tenantModel, isTenantScoped, exemptReason } from './models.js'
export type { TenantModel, TenantScopeKind } from './models.js'

export { tenancyExtension } from './tenancy.js'

export {
  buildWhere,
  buildCreateData,
  scopeFilterFor,
  scopeDataFor,
  UNIQUE_WHERE_OPS,
  FILTER_WHERE_OPS,
  CREATE_OPS,
} from './predicate.js'
export type { ScopeFilter } from './predicate.js'

export { Prisma } from '@prisma/client'

export { assertRlsApplies, rlsStatus, RlsBypassDetected } from './rls-assert.js'

export {
  encrypt,
  decrypt,
  rewrap,
  keyIdOf,
  keyProvider,
  setKeyProvider,
  EnvKeyProvider,
  MissingEncryptionKey,
  DecryptionFailed,
} from './encryption.js'
export type { KeyProvider, Envelope } from './encryption.js'

export { seedDemo } from './seed-demo.js'
export type { SeedResult } from './seed-demo.js'

// The transactional outbox. Producers call emit() inside their own
// transaction; the worker drains it.
export * as outbox from './outbox.js'
export type { OutboxEvent, PendingOutboxRow } from './outbox.js'
