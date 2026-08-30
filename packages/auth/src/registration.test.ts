import { describe, expect, it } from 'vitest'
import { decideRegistration, organizationDisposition } from './registration.js'

const validInvite = { valid: true, expired: false, consumed: false }

describe('first-run bootstrap', () => {
  // Without this rule, `invite` — the correct default for self-hosting — makes a
  // fresh deployment permanently unusable, because nobody exists to send the
  // first invite. This is the single most important case in the file.
  it.each(['open', 'invite', 'closed'] as const)(
    'allows the very first account in %s mode',
    (mode) => {
      const decision = decideRegistration({ mode, isFirstUser: true })
      expect(decision.allowed).toBe(true)
      expect(decision.allowed && decision.reason).toBe('bootstrap')
    }
  )

  it('the bootstrap creates an organization rather than joining one', () => {
    const decision = decideRegistration({ mode: 'invite', isFirstUser: true })
    expect(organizationDisposition(decision)).toBe('create')
  })

  it('closes permanently once a user exists', () => {
    const decision = decideRegistration({ mode: 'closed', isFirstUser: false })
    expect(decision.allowed).toBe(false)
  })
})

describe('open mode', () => {
  it('allows signup with no invite', () => {
    const decision = decideRegistration({ mode: 'open', isFirstUser: false })
    expect(decision.allowed).toBe(true)
    expect(organizationDisposition(decision)).toBe('create')
  })
})

describe('closed mode', () => {
  it('refuses even a valid invite', () => {
    // "Closed" has to mean closed, or it is just a slower version of invite mode.
    const decision = decideRegistration({
      mode: 'closed',
      isFirstUser: false,
      invite: validInvite,
    })
    expect(decision.allowed).toBe(false)
    expect(decision.allowed === false && decision.code).toBe('registration_closed')
  })
})

describe('invite mode', () => {
  it('allows a valid invite', () => {
    const decision = decideRegistration({
      mode: 'invite',
      isFirstUser: false,
      invite: validInvite,
    })
    expect(decision.allowed).toBe(true)
    expect(decision.allowed && decision.reason).toBe('invite')
  })

  it('accepting an invite JOINS rather than creating a second organization', () => {
    // An invite that created its own organization would silently fragment a
    // team, and the symptom — an empty workspace — looks like a bug in
    // everything except the actual cause.
    const decision = decideRegistration({
      mode: 'invite',
      isFirstUser: false,
      invite: validInvite,
    })
    expect(organizationDisposition(decision)).toBe('join')
  })

  it('refuses signup with no invite', () => {
    const decision = decideRegistration({ mode: 'invite', isFirstUser: false })
    expect(decision.allowed === false && decision.code).toBe('invite_required')
  })

  it.each([
    [{ ...validInvite, consumed: true }, 'invite_already_used'],
    [{ ...validInvite, expired: true }, 'invite_expired'],
    [{ ...validInvite, valid: false }, 'invite_invalid'],
  ] as const)('rejects a bad invite with a specific code', (invite, code) => {
    const decision = decideRegistration({ mode: 'invite', isFirstUser: false, invite })
    expect(decision.allowed).toBe(false)
    expect(decision.allowed === false && decision.code).toBe(code)
  })

  it('reports reuse before expiry when an invite is both', () => {
    // Order matters for the message the user reads: "already used" is actionable
    // and true, while "expired" would send them looking for the wrong problem.
    const decision = decideRegistration({
      mode: 'invite',
      isFirstUser: false,
      invite: { valid: true, expired: true, consumed: true },
    })
    expect(decision.allowed === false && decision.code).toBe('invite_already_used')
  })

  it('every denial carries a message a person can act on', () => {
    const denials = [
      decideRegistration({ mode: 'invite', isFirstUser: false }),
      decideRegistration({ mode: 'closed', isFirstUser: false }),
      decideRegistration({
        mode: 'invite',
        isFirstUser: false,
        invite: { ...validInvite, expired: true },
      }),
    ]
    for (const d of denials) {
      expect(d.allowed).toBe(false)
      if (!d.allowed) {
        expect(d.message.length).toBeGreaterThan(20)
        expect(d.message).not.toMatch(/error|invalid request/i)
      }
    }
  })
})
