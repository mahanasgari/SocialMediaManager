import { Prisma } from '@prisma/client'

/**
 * Which models are tenant-scoped, derived from the Prisma DMMF rather than a
 * hand-maintained list.
 *
 * This matters more than it looks. A hand-maintained list is a list somebody has
 * to remember to update, and the failure mode of forgetting is a model with no
 * isolation that nobody notices. Deriving it from the schema means adding a
 * model with a `workspaceId` automatically brings it under the guard AND into
 * the isolation suite — so forgetting fails CI instead of shipping quietly.
 */

/** Models exempt from the tenancy guard, each for a stated reason. */
const EXEMPT: Record<string, string> = {
  // Drained by a system principal that must scan across every workspace. It
  // carries workspaceId so consumers can establish tenancy downstream, but the
  // dispatcher itself is intentionally global.
  Outbox: 'system-wide dispatcher; tenancy is established downstream by the consumer',

  // These two carry NO tenancy column at all, so the DMMF scan below would skip
  // them regardless. They are named here anyway, because "absent from a list"
  // and "deliberately excluded" look identical when someone audits this file —
  // and this is the one part of the system where workspace context is derived
  // from untrusted input, so the reasoning must be written down rather than
  // inferred.
  InboundEvent:
    'arrives before its workspace is known; routing it IS the problem. Reachable only by the receiver and dispatcher, both under app.scheduler.',
  UnroutedInboundEvent:
    'by definition matched no workspace. Retained for admin visibility, never attached to a plausible one.',

  // Belongs to a USER, who exists before any workspace and may belong to
  // several. Password reset in particular has to work for someone who cannot
  // sign in, so there is no scope to derive. Guarded by app.current_user and
  // the narrow app.token_redeem actor instead.
  VerificationToken: 'user-scoped, not tenant-scoped; must work before authentication',
  // Deployment-global by design. A Meta app registration belongs to the
  // installation, not to a workspace — the adapters that read it run in OAuth
  // callbacks and background jobs with no tenant in hand. Guarded by the two
  // narrow actors app.connector_settings (read) and
  // app.connector_settings_write instead.
  ProviderSetting: 'installation-wide connector credentials; no tenant to scope to',
}

export type TenantScopeKind = 'workspace' | 'organization'

export type TenantModel = {
  name: string
  hasWorkspaceId: boolean
  hasOrganizationId: boolean
  /** True when the model carries `deletedAt` and participates in soft deletion. */
  softDeletable: boolean
  /** Scope kinds this model can be queried under. */
  supports: readonly TenantScopeKind[]
}

function build(): TenantModel[] {
  const out: TenantModel[] = []

  for (const model of Prisma.dmmf.datamodel.models) {
    if (EXEMPT[model.name]) continue

    const names = new Set(model.fields.map((f) => f.name))
    const hasWorkspaceId = names.has('workspaceId')
    const hasOrganizationId = names.has('organizationId')
    if (!hasWorkspaceId && !hasOrganizationId) continue

    const supports: TenantScopeKind[] = []
    if (hasWorkspaceId) supports.push('workspace')
    if (hasOrganizationId) supports.push('organization')

    out.push({
      name: model.name,
      hasWorkspaceId,
      hasOrganizationId,
      softDeletable: names.has('deletedAt'),
      supports,
    })
  }

  // Workspace is scoped by its own primary key rather than a workspaceId column,
  // so the DMMF scan above classifies it as organization-only. It must also be
  // reachable under a workspace scope — that is the single most common query in
  // the product ("load my workspace").
  const workspace = out.find((m) => m.name === 'Workspace')
  if (workspace && !workspace.supports.includes('workspace')) {
    workspace.supports = ['workspace', ...workspace.supports]
  }

  return out
}

export const TENANT_MODELS: readonly TenantModel[] = build()

const BY_NAME = new Map(TENANT_MODELS.map((m) => [m.name, m]))

export function tenantModel(name: string): TenantModel | undefined {
  return BY_NAME.get(name)
}

export function isTenantScoped(name: string): boolean {
  return BY_NAME.has(name)
}

/** Every model carrying `deletedAt`, tenant-scoped or not. */
export const SOFT_DELETABLE: ReadonlySet<string> = new Set(
  Prisma.dmmf.datamodel.models
    .filter((m) => m.fields.some((f) => f.name === 'deletedAt'))
    .map((m) => m.name)
)

export function exemptReason(name: string): string | undefined {
  return EXEMPT[name]
}
