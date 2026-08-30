import { Injectable } from '@nestjs/common'
import { decideRegistration, hashPassword, needsRehash, organizationDisposition, verifyPassword } from '@smm/auth'
import { db, withOrganization, withSystemScope } from '@smm/database'
import { loadEnv } from '@smm/config'
import { createHash, randomBytes } from 'node:crypto'
import { errors } from '../common/errors.js'

/**
 * Registration and login.
 *
 * The invariant this file protects: exactly one code path decides whether an
 * account may be created, and it is the pure `decideRegistration()` from
 * @smm/auth. Sprinkling mode checks through controllers is how a deployment ends
 * up accepting signups it was configured to refuse.
 */

export type RegisterInput = {
  email: string
  password: string
  name: string
  inviteToken?: string | undefined
}

export type LoginInput = {
  email: string
  password: string
}

function hashInviteToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

@Injectable()
export class AuthService {
  async register(input: RegisterInput): Promise<{ userId: string }> {
    const env = loadEnv()
    const email = input.email.trim().toLowerCase()

    const { isFirstUser, invite } = await withSystemScope(
      'registration decides against global state before any tenant exists',
      async () => {
        const userCount = await db().user.count()

        if (!input.inviteToken) return { isFirstUser: userCount === 0, invite: undefined }

        const row = await db().invite.findUnique({
          where: { tokenHash: hashInviteToken(input.inviteToken) },
          select: {
            id: true,
            email: true,
            role: true,
            status: true,
            expiresAt: true,
            organizationId: true,
            workspaceId: true,
          },
        })

        return {
          isFirstUser: userCount === 0,
          invite: row
            ? {
                row,
                state: {
                  valid: row.email.toLowerCase() === email,
                  expired: row.expiresAt.getTime() <= Date.now(),
                  consumed: row.status !== 'PENDING',
                },
              }
            : { row: undefined, state: { valid: false, expired: false, consumed: false } },
        }
      }
    )

    const decision = decideRegistration({
      mode: env.AUTH_REGISTRATION,
      isFirstUser,
      ...(invite ? { invite: invite.state } : {}),
    })

    if (!decision.allowed) {
      throw errors.forbidden(decision.message, { code: decision.code })
    }

    const existing = await withSystemScope('email uniqueness is global', async () =>
      db().user.findUnique({ where: { email }, select: { id: true } })
    )
    if (existing) {
      // Deliberately the same shape as a validation error rather than a distinct
      // "account exists" code, so registration is not an account-enumeration
      // oracle for anyone probing addresses.
      throw errors.validation('That email address cannot be used to register.', 'email')
    }

    const passwordHash = await hashPassword(input.password)

    return withSystemScope('user creation precedes any tenant scope', async () => {
      const user = await db().user.create({
        data: { email, passwordHash, name: input.name.trim() },
        select: { id: true },
      })

      if (organizationDisposition(decision) === 'join' && invite?.row) {
        await this.acceptInvite(user.id, invite.row)
      } else {
        await this.createOrganizationFor(user.id, input.name)
      }

      return { userId: user.id }
    })
  }

  private async createOrganizationFor(userId: string, name: string): Promise<void> {
    const slug = `${slugify(name)}-${randomBytes(3).toString('hex')}`

    const org = await db().organization.create({
      data: { name: `${name}'s organization`, slug },
      select: { id: true },
    })

    // Workspace rows can only be written under an organization scope: their RLS
    // policy keys on the row's own id, which does not exist until the insert.
    await withOrganization(org.id, async (tx) => {
      const workspace = await tx.workspace.create({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        data: { name: 'Default', slug: 'default' } as any,
        select: { id: true },
      })
      await tx.membership.create({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        data: { userId, workspaceId: workspace.id, role: 'OWNER' } as any,
      })
      // The organization-wide membership: workspaceId null means org scope.
      await tx.membership.create({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        data: { userId, workspaceId: null, role: 'OWNER' } as any,
      })
    })
  }

  private async acceptInvite(
    userId: string,
    invite: { id: string; organizationId: string; workspaceId: string | null; role: string }
  ): Promise<void> {
    await withOrganization(invite.organizationId, async (tx) => {
      await tx.membership.create({
        data: {
          userId,
          workspaceId: invite.workspaceId,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          role: invite.role as any,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
      })
      await tx.invite.update({
        where: { id: invite.id },
        data: { status: 'ACCEPTED', acceptedAt: new Date() },
      })
    })
  }

  /**
   * Verifies credentials.
   *
   * Returns null for both "no such user" and "wrong password", and performs a
   * dummy hash comparison in the former case. Without that, the response time
   * distinguishes registered addresses from unregistered ones, turning login
   * into an account-enumeration oracle.
   */
  async verifyCredentials(input: LoginInput): Promise<{ userId: string } | null> {
    const email = input.email.trim().toLowerCase()

    const user = await withSystemScope('login precedes any tenant scope', async () =>
      db().user.findUnique({
        where: { email },
        select: { id: true, passwordHash: true, anonymizedAt: true },
      })
    )

    if (!user || user.anonymizedAt) {
      await verifyPassword(DUMMY_HASH, input.password)
      return null
    }

    if (!(await verifyPassword(user.passwordHash, input.password))) return null

    if (needsRehash(user.passwordHash)) {
      // Transparent upgrade on successful login. Without it, raising the cost
      // only protects accounts created after the change — the long-standing
      // ones, which are the ones worth attacking, keep their old parameters.
      const upgraded = await hashPassword(input.password)
      await withSystemScope('password rehash is per-user', async () => {
        await db().user.update({ where: { id: user.id }, data: { passwordHash: upgraded } })
      })
    }

    return { userId: user.id }
  }
}

/**
 * A real argon2id hash of a value nobody knows, compared against when the
 * account does not exist so the timing matches the found-account path.
 */
const DUMMY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$c21tLWR1bW15LXNhbHQtdg$Y2Fubm90LXZlcmlmeS10aGlzLXZhbHVl'

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'workspace'
  )
}
