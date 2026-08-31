import { describe, expect, it } from 'vitest'
import { Prisma } from '@prisma/client'
import { TENANT_MODELS, SOFT_DELETABLE, exemptReason, isTenantScoped, tenantModel } from './models.js'

/**
 * These tests guard the DERIVATION, not a hand-written list.
 *
 * The value of deriving tenant-scoped models from the DMMF is that adding a
 * model with a `workspaceId` automatically brings it under the guard and into
 * the isolation suite. These tests fail if that derivation ever silently stops
 * working — which would be invisible otherwise, because the symptom is a model
 * that quietly has no isolation.
 */

describe('tenant model derivation', () => {
  it('classifies every model carrying a tenancy column', () => {
    // This list is expected to GROW, and the friction is the point. Every time
    // a model with a tenancy column is added, this fails and someone has to
    // confirm the model really should be tenant-scoped before updating it. It
    // has already caught SocialAccount, OAuthCredential, the content models and
    // the metric models — none of which anyone had to remember to register.
    const names = TENANT_MODELS.map((m) => m.name).sort()
    expect(names).toEqual([
      'AccountMetric',
      'ApiKey',
      'Approval',
      'ApprovalStep',
      'AuditLog',
      'Campaign',
      'Conversation',
      'ExportJob',
      'InboundEventDelivery',
      'Invite',
      'Label',
      'Link',
      'LinkPage',
      'MediaAsset',
      'MediaRendition',
      'Membership',
      'Message',
      'Notification',
      'OAuthCredential',
      'Post',
      'PostComment',
      'PostLabel',
      'PostMedia',
      'PostMetric',
      'PostVariant',
      'PublishAttempt',
      'RSSFeed',
      'RSSItem',
      'SocialAccount',
      'SyncCursor',
      'Template',
      'UtmPreset',
      'Webhook',
      'WebhookDelivery',
      'Workspace',
    ])
  })

  it('exempts Outbox, and says why', () => {
    expect(isTenantScoped('Outbox')).toBe(false)
    expect(exemptReason('Outbox')).toMatch(/dispatcher/)
  })

  it('does not scope models that have no tenancy column', () => {
    // User and Session are per-person, not per-tenant; Organization is the
    // tenancy root and cannot be scoped by itself.
    expect(isTenantScoped('User')).toBe(false)
    expect(isTenantScoped('Session')).toBe(false)
    expect(isTenantScoped('Organization')).toBe(false)
  })

  it('lets Workspace be queried under a workspace scope', () => {
    // Workspace has no workspaceId column — it IS the workspace — so the naive
    // DMMF scan would classify it organization-only and make "load my
    // workspace" impossible under the scope every request actually holds.
    const workspace = tenantModel('Workspace')
    expect(workspace?.supports).toContain('workspace')
    expect(workspace?.supports).toContain('organization')
  })

  it('credentials are never soft-deletable', () => {
    // A soft-deleted secret is still a secret sitting in the database. Disconnect
    // HARD-deletes the credential and keeps only the account row for history.
    expect(SOFT_DELETABLE.has('OAuthCredential')).toBe(false)
    expect(SOFT_DELETABLE.has('SocialAccount')).toBe(true)
  })

  it('records which models participate in soft deletion', () => {
    expect(SOFT_DELETABLE.has('Workspace')).toBe(true)
    expect(SOFT_DELETABLE.has('Membership')).toBe(true)
    // Audit rows survive purge in minimised form; they are never soft-deleted.
    expect(SOFT_DELETABLE.has('AuditLog')).toBe(false)
    // Sessions are hard-deleted on revocation — a soft-deleted session is still
    // a live credential if any code path ever forgets the filter.
    expect(SOFT_DELETABLE.has('Session')).toBe(false)
  })

  it('every derived model really has the column it claims', () => {
    const byName = new Map(Prisma.dmmf.datamodel.models.map((m) => [m.name, m]))
    for (const model of TENANT_MODELS) {
      const fields = new Set(byName.get(model.name)?.fields.map((f) => f.name) ?? [])
      if (model.hasWorkspaceId) expect(fields).toContain('workspaceId')
      if (model.hasOrganizationId) expect(fields).toContain('organizationId')
      if (model.softDeletable) expect(fields).toContain('deletedAt')
    }
  })
})

describe('gate — no tenant-scoped model may be silently unguarded', () => {
  /**
   * The standing CI gate (G1). Any model with a tenancy column must be either
   * guarded or explicitly exempt with a stated reason. Adding a model and
   * forgetting isolation fails here rather than shipping.
   */
  it('accounts for every model carrying a tenancy column', () => {
    const unaccounted = Prisma.dmmf.datamodel.models
      .filter((m) => m.fields.some((f) => f.name === 'workspaceId' || f.name === 'organizationId'))
      .map((m) => m.name)
      .filter((name) => !isTenantScoped(name) && !exemptReason(name))

    expect(
      unaccounted,
      `These models carry a tenancy column but are neither guarded nor exempt. ` +
        `Add them to the guard, or add an EXEMPT entry in models.ts stating why.`
    ).toEqual([])
  })
})
