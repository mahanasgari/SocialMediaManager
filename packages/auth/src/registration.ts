/**
 * Registration modes and the first-run bootstrap.
 *
 * These two rules resolve a contradiction that existed in the plan: the stack
 * specified invite-only registration, while the end-to-end flow began at signup.
 * Both could not be true.
 */

export type RegistrationMode = 'open' | 'invite' | 'closed'

export type RegistrationRequest = {
  mode: RegistrationMode
  /** True when no user exists yet — the deployment has never been used. */
  isFirstUser: boolean
  /** A valid, unexpired, unconsumed invite, if one was presented. */
  invite?: { valid: boolean; expired: boolean; consumed: boolean }
}

export type RegistrationDecision =
  | { allowed: true; reason: 'bootstrap' | 'open' | 'invite' }
  | { allowed: false; code: RegistrationDenial; message: string }

export type RegistrationDenial =
  | 'registration_closed'
  | 'invite_required'
  | 'invite_invalid'
  | 'invite_expired'
  | 'invite_already_used'

/**
 * Decides whether a signup may proceed.
 *
 * THE BOOTSTRAP RULE: on an empty database the first account is always allowed
 * and becomes the organization owner, regardless of mode. Without it, `invite`
 * — the correct default for a self-hosted install — makes a fresh deployment
 * permanently unusable, because there is nobody in existence to send the first
 * invite. The path closes for good once any user exists, so it is not a standing
 * hole.
 */
export function decideRegistration(req: RegistrationRequest): RegistrationDecision {
  if (req.isFirstUser) {
    return { allowed: true, reason: 'bootstrap' }
  }

  switch (req.mode) {
    case 'open':
      return { allowed: true, reason: 'open' }

    case 'closed':
      return {
        allowed: false,
        code: 'registration_closed',
        message: 'This deployment is not accepting new accounts.',
      }

    case 'invite': {
      if (!req.invite) {
        return {
          allowed: false,
          code: 'invite_required',
          message: 'An invitation is required to create an account on this deployment.',
        }
      }
      if (req.invite.consumed) {
        return {
          allowed: false,
          code: 'invite_already_used',
          message: 'This invitation has already been used. Ask for a new one.',
        }
      }
      if (req.invite.expired) {
        return {
          allowed: false,
          code: 'invite_expired',
          message: 'This invitation has expired. Ask for a new one.',
        }
      }
      if (!req.invite.valid) {
        return {
          allowed: false,
          code: 'invite_invalid',
          message: 'This invitation link is not valid.',
        }
      }
      return { allowed: true, reason: 'invite' }
    }
  }
}

/**
 * Whether this signup should create a new organization or join an existing one.
 *
 * Accepting an invite always JOINS — the invite carries the target organization,
 * workspace and role. An invite that created a second organization would silently
 * fragment a team, and the symptom (an empty workspace) looks like a bug in
 * everything except the actual cause.
 */
export function organizationDisposition(
  decision: RegistrationDecision
): 'create' | 'join' | 'none' {
  if (!decision.allowed) return 'none'
  return decision.reason === 'invite' ? 'join' : 'create'
}
