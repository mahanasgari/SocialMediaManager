import { describe, expect, it } from 'vitest'
import { buildWhere, buildCreateData, scopeDataFor, scopeFilterFor } from './predicate.js'
import { TenantScopeMismatch, type TenantScope } from './scope.js'
import type { TenantModel } from './models.js'

const WS = '018f5c00-0000-7000-8000-000000000001'
const OTHER_WS = '018f5c00-0000-7000-8000-000000000002'
const ORG = '018f5c00-0000-7000-8000-0000000000aa'

const workspaceScope: TenantScope = { kind: 'workspace', workspaceId: WS }
const orgScope: TenantScope = { kind: 'organization', organizationId: ORG }
const systemScope: TenantScope = { kind: 'system', reason: 'outbox dispatcher' }

const model = (over: Partial<TenantModel> = {}): TenantModel => ({
  name: 'Invite',
  hasWorkspaceId: true,
  hasOrganizationId: true,
  softDeletable: true,
  supports: ['workspace', 'organization'],
  ...over,
})

describe('scopeFilterFor', () => {
  it('filters on workspaceId under a workspace scope', () => {
    expect(scopeFilterFor(model(), workspaceScope)).toEqual({ workspaceId: WS })
  })

  it('filters Workspace on its own primary key', () => {
    const workspace = model({ name: 'Workspace', hasWorkspaceId: false })
    expect(scopeFilterFor(workspace, workspaceScope)).toEqual({ id: WS })
  })

  it('filters on organizationId under an organization scope', () => {
    expect(scopeFilterFor(model(), orgScope)).toEqual({ organizationId: ORG })
  })

  it('returns no filter under a system scope', () => {
    expect(scopeFilterFor(model(), systemScope)).toEqual({})
  })

  it('refuses a workspace scope on an organization-only model', () => {
    const orgOnly = model({ supports: ['organization'], hasWorkspaceId: false })
    expect(() => scopeFilterFor(orgOnly, workspaceScope)).toThrow(TenantScopeMismatch)
  })

  it('refuses an organization scope on a workspace-only model', () => {
    const wsOnly = model({ supports: ['workspace'], hasOrganizationId: false })
    expect(() => scopeFilterFor(wsOnly, orgScope)).toThrow(TenantScopeMismatch)
  })
})

describe('buildWhere — filter operations', () => {
  it('AND-composes rather than merging, so a caller filter cannot be lost', () => {
    const where = buildWhere({
      operation: 'findMany',
      existingWhere: { email: 'a@example.com' },
      filter: { workspaceId: WS },
      applySoftDelete: true,
    })
    expect(where).toEqual({
      AND: [{ email: 'a@example.com' }, { workspaceId: WS, deletedAt: null }],
    })
  })

  it('returns the injected filter alone when the caller passed none', () => {
    expect(
      buildWhere({
        operation: 'findMany',
        existingWhere: undefined,
        filter: { workspaceId: WS },
        applySoftDelete: false,
      })
    ).toEqual({ workspaceId: WS })
  })

  // The whole point of the guard: a caller naming another tenant must not win.
  it('the guard wins over a caller-supplied workspaceId', () => {
    const where = buildWhere({
      operation: 'findMany',
      existingWhere: { workspaceId: OTHER_WS },
      filter: { workspaceId: WS },
      applySoftDelete: false,
    }) as { AND: Array<Record<string, unknown>> }

    // Both predicates apply, so the query can only match rows in BOTH — and a
    // row cannot belong to two workspaces, so the result is empty rather than
    // another tenant's data.
    expect(where.AND[0]).toEqual({ workspaceId: OTHER_WS })
    expect(where.AND[1]).toEqual({ workspaceId: WS })
  })

  it('the guard wins over a caller trying to see deleted rows', () => {
    const where = buildWhere({
      operation: 'findMany',
      existingWhere: { deletedAt: { not: null } },
      filter: { workspaceId: WS },
      applySoftDelete: true,
    }) as { AND: Array<Record<string, unknown>> }
    expect(where.AND[1]).toMatchObject({ deletedAt: null })
  })
})

describe('buildWhere — unique-where operations', () => {
  // Prisma's unique-where does not accept an AND wrapper, so these merge flat.
  it('merges flat for findUnique', () => {
    expect(
      buildWhere({
        operation: 'findUnique',
        existingWhere: { id: 'abc' },
        filter: { workspaceId: WS },
        applySoftDelete: true,
      })
    ).toEqual({ id: 'abc', workspaceId: WS, deletedAt: null })
  })

  it('injected keys are applied last, so a spoofed workspaceId is overwritten', () => {
    expect(
      buildWhere({
        operation: 'update',
        existingWhere: { id: 'abc', workspaceId: OTHER_WS },
        filter: { workspaceId: WS },
        applySoftDelete: false,
      })
    ).toEqual({ id: 'abc', workspaceId: WS })
  })

  it('leaves the where untouched under a system scope', () => {
    expect(
      buildWhere({
        operation: 'findUnique',
        existingWhere: { id: 'abc' },
        filter: {},
        applySoftDelete: false,
      })
    ).toEqual({ id: 'abc' })
  })
})

describe('buildCreateData', () => {
  it('stamps the scope onto a single create', () => {
    expect(buildCreateData({ email: 'a@example.com' }, { workspaceId: WS })).toEqual({
      email: 'a@example.com',
      workspaceId: WS,
    })
  })

  it('stamps every row of a batch create', () => {
    expect(buildCreateData([{ n: 1 }, { n: 2 }], { workspaceId: WS })).toEqual([
      { n: 1, workspaceId: WS },
      { n: 2, workspaceId: WS },
    ])
  })

  it('overrides a caller-supplied workspaceId rather than trusting it', () => {
    expect(buildCreateData({ workspaceId: OTHER_WS }, { workspaceId: WS })).toEqual({
      workspaceId: WS,
    })
  })

  it('is a no-op under a system scope', () => {
    expect(buildCreateData({ n: 1 }, {})).toEqual({ n: 1 })
  })
})

describe('scopeDataFor', () => {
  it('does not stamp workspaceId onto a Workspace row', () => {
    // A Workspace is created under an organization scope; stamping a
    // workspaceId onto it would be meaningless.
    const workspace = model({ name: 'Workspace', hasWorkspaceId: false })
    expect(scopeDataFor(workspace, workspaceScope)).toEqual({})
  })

  it('stamps organizationId under an organization scope', () => {
    expect(scopeDataFor(model(), orgScope)).toEqual({ organizationId: ORG })
  })

  it('skips models with no workspaceId column', () => {
    const noWs = model({ hasWorkspaceId: false, supports: ['organization'] })
    expect(scopeDataFor(noWs, workspaceScope)).toEqual({})
  })
})
