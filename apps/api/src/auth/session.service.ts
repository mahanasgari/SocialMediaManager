import { Injectable } from '@nestjs/common'
import { hashSessionToken, issueSessionToken } from '@smm/auth'
import { db, withSystemScope } from '@smm/database'

/**
 * Session lifecycle against the database.
 *
 * Sessions are authoritative in Postgres rather than encoded in a JWT, so they
 * can be listed in a "your devices" view and revoked immediately. Revocation
 * that only takes effect when a token expires is not revocation.
 *
 * Session and User carry no tenancy column — a session belongs to a person, not
 * a workspace — so these run under a system scope with a stated reason rather
 * than a workspace one.
 */

export type SessionPrincipal = {
  userId: string
  sessionId: string
  email: string
  name: string
}

export type CreateSessionInput = {
  userId: string
  ip?: string | undefined
  userAgent?: string | undefined
  /** Absolute lifetime. Sliding expiry is handled by touch(). */
  ttlDays?: number
}

const DEFAULT_TTL_DAYS = 30

/** How stale `lastSeenAt` may get before a write is worth doing. */
const TOUCH_INTERVAL_MS = 5 * 60_000

@Injectable()
export class SessionService {
  /** Issues a session and returns the plaintext token — the only time it exists. */
  async create(input: CreateSessionInput): Promise<{ token: string; expiresAt: Date }> {
    const { token, hash } = issueSessionToken()
    const expiresAt = new Date(Date.now() + (input.ttlDays ?? DEFAULT_TTL_DAYS) * 86_400_000)

    await withSystemScope('session issuance is per-user, not per-workspace', async () => {
      await db().session.create({
        data: {
          userId: input.userId,
          tokenHash: hash,
          expiresAt,
          ip: input.ip ?? null,
          userAgent: input.userAgent ?? null,
        },
      })
    })

    return { token, expiresAt }
  }

  /**
   * Resolves a presented token to a principal, or null.
   *
   * Looks up by HASH, never by plaintext — the plaintext is not stored, so a
   * database read cannot yield a usable credential.
   */
  async resolve(token: string): Promise<SessionPrincipal | null> {
    const tokenHash = hashSessionToken(token)

    return withSystemScope('session lookup is per-user, not per-workspace', async () => {
      const session = await db().session.findUnique({
        where: { tokenHash },
        select: {
          id: true,
          expiresAt: true,
          revokedAt: true,
          lastSeenAt: true,
          user: { select: { id: true, email: true, name: true, anonymizedAt: true } },
        },
      })

      if (!session) return null
      if (session.revokedAt) return null
      if (session.expiresAt.getTime() <= Date.now()) return null
      // A deleted user's sessions must stop working even if the rows survive.
      if (session.user.anonymizedAt) return null

      if (Date.now() - session.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
        // Fire-and-forget: a failed liveness update must not fail the request.
        void db()
          .session.update({ where: { id: session.id }, data: { lastSeenAt: new Date() } })
          .catch(() => undefined)
      }

      return {
        userId: session.user.id,
        sessionId: session.id,
        email: session.user.email,
        name: session.user.name,
      }
    })
  }

  /** Revokes one session. Idempotent: revoking twice is not an error. */
  async revoke(sessionId: string, userId: string): Promise<void> {
    await withSystemScope('session revocation is per-user', async () => {
      await db().session.updateMany({
        // Scoped by userId so one user cannot revoke another's session by id.
        where: { id: sessionId, userId, revokedAt: null },
        data: { revokedAt: new Date() },
      })
    })
  }

  /** Revokes every session for a user — used on password change. */
  async revokeAll(userId: string, exceptSessionId?: string): Promise<number> {
    return withSystemScope('bulk session revocation is per-user', async () => {
      const result = await db().session.updateMany({
        where: {
          userId,
          revokedAt: null,
          ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}),
        },
        data: { revokedAt: new Date() },
      })
      return result.count
    })
  }

  /** The "your devices" list. Revoked and expired sessions are omitted. */
  async list(userId: string) {
    return withSystemScope('session listing is per-user', async () => {
      return db().session.findMany({
        where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
        select: { id: true, createdAt: true, lastSeenAt: true, ip: true, userAgent: true },
        orderBy: { lastSeenAt: 'desc' },
      })
    })
  }
}
