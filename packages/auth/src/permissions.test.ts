import { describe, expect, it } from 'vitest'
import {
  authorize,
  can,
  permissionsFor,
  PERMISSIONS,
  ROLES,
  ROLE_PERMISSIONS,
  type Permission,
  type Role,
} from './permissions.js'

const principal = (role: Role, userId = 'u1') => ({ userId, role })

describe('grant matrix completeness', () => {
  // A role missing from the matrix would throw at runtime on its first request;
  // catching it here means a new role cannot be added without a decision about
  // every permission.
  it('every role has an entry', () => {
    for (const role of ROLES) {
      expect(ROLE_PERMISSIONS[role], `role ${role} has no grants declared`).toBeDefined()
    }
  })

  it('grants only permissions that exist', () => {
    const known = new Set<string>(PERMISSIONS)
    for (const role of ROLES) {
      for (const permission of ROLE_PERMISSIONS[role]) {
        expect(known.has(permission), `${role} grants unknown permission ${permission}`).toBe(true)
      }
    }
  })

  it('OWNER is the only role that can manage billing', () => {
    const withBilling = ROLES.filter((r) => ROLE_PERMISSIONS[r].has('billing.manage'))
    expect(withBilling).toEqual(['OWNER'])
  })

  it('every role can view analytics', () => {
    // Every persona in the PRD needs to see results; a role that cannot is
    // almost certainly a mistake in the matrix.
    for (const role of ROLES) {
      expect(ROLE_PERMISSIONS[role].has('analytics.view'), `${role} cannot view analytics`).toBe(
        true
      )
    }
  })
})

describe('publishing authority', () => {
  const publishers: Role[] = ['OWNER', 'ADMIN', 'MANAGER', 'EDITOR']
  const nonPublishers: Role[] = ['AUTHOR', 'APPROVER', 'ANALYST', 'CLIENT', 'VIEWER']

  it.each(publishers)('%s may publish', (role) => {
    expect(can(principal(role), 'content.publish')).toBe(true)
  })

  it.each(nonPublishers)('%s may not publish', (role) => {
    expect(can(principal(role), 'content.publish')).toBe(false)
  })

  it('AUTHOR can draft but not publish — the distinction the role exists for', () => {
    expect(can(principal('AUTHOR'), 'content.create')).toBe(true)
    expect(can(principal('AUTHOR'), 'content.publish')).toBe(false)
  })
})

describe('approval authority', () => {
  it('CLIENT can approve without being able to create or publish', () => {
    // The external-stakeholder shape: sign off, see results, touch nothing else.
    const client = principal('CLIENT')
    expect(can(client, 'content.approve')).toBe(true)
    expect(can(client, 'content.create')).toBe(false)
    expect(can(client, 'content.publish')).toBe(false)
    expect(can(client, 'accounts.connect')).toBe(false)
  })

  it('EDITOR can publish but not approve', () => {
    expect(can(principal('EDITOR'), 'content.publish')).toBe(true)
    expect(can(principal('EDITOR'), 'content.approve')).toBe(false)
  })
})

describe('account connection is privileged', () => {
  const canConnect: Role[] = ['OWNER', 'ADMIN', 'MANAGER']

  it.each(ROLES)('%s connect grant matches policy', (role) => {
    expect(can(principal(role), 'accounts.connect')).toBe(canConnect.includes(role))
  })
})

describe('ownership narrowing', () => {
  it('AUTHOR may edit their own content', () => {
    expect(can(principal('AUTHOR', 'u1'), 'content.edit', { authorId: 'u1' })).toBe(true)
  })

  it("AUTHOR may not edit someone else's content", () => {
    const result = authorize(principal('AUTHOR', 'u1'), 'content.edit', { authorId: 'u2' })
    expect(result.allowed).toBe(false)
    expect(result.allowed === false && result.reason).toMatch(/authored/)
  })

  it('EDITOR may edit content authored by anyone', () => {
    // Ownership narrowing applies only to roles that declare it; broadening it
    // to every role would break the shared-calendar workflow entirely.
    expect(can(principal('EDITOR', 'u1'), 'content.edit', { authorId: 'u2' })).toBe(true)
  })

  it('narrowing does not apply when the resource has no author', () => {
    expect(can(principal('AUTHOR', 'u1'), 'content.create')).toBe(true)
  })
})

describe('denials explain themselves', () => {
  it('names the role and the permission', () => {
    const result = authorize(principal('VIEWER'), 'content.publish')
    expect(result.allowed).toBe(false)
    if (result.allowed === false) {
      expect(result.reason).toContain('VIEWER')
      expect(result.reason).toContain('content.publish')
    }
  })
})

describe('permissionsFor', () => {
  it('returns a sorted, stable list for the frontend to render from', () => {
    const perms = permissionsFor('EDITOR')
    expect(perms).toEqual([...perms].sort())
    expect(perms).toContain('content.publish' satisfies Permission)
    expect(perms).not.toContain('billing.manage' satisfies Permission)
  })
})
