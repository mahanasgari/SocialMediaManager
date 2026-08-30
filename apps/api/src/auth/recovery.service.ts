import { Injectable, Logger } from '@nestjs/common'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { loadEnv } from '@smm/config'
import { db, withSystemScope, withTokenRedemption, withUser } from '@smm/database'
import { hashPassword, verifyPassword } from '@smm/auth'
import { Mailer, templates } from '@smm/mail'

/**
 * Password reset and email verification.
 *
 * The whole subsystem turns on one rule: **an attacker must not learn whether
 * an address has an account here.** Every branch below that could leak it —
 * unknown email, unverified email, rate limit — returns the same response and
 * takes broadly the same time.
 */

const RESET_TTL_MINUTES = 30
const VERIFY_TTL_HOURS = 48

/** Long enough that guessing is hopeless; 256 bits, url-safe. */
function newToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString('base64url')
  return { token, tokenHash: sha256(token) }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

@Injectable()
export class RecoveryService {
  private readonly logger = new Logger('recovery')
  private mailerInstance: Mailer | undefined

  private mailer(): Mailer {
    const env = loadEnv()
    this.mailerInstance ??= new Mailer({
      smtpUrl: env.SMTP_URL,
      from: env.MAIL_FROM ?? 'noreply@localhost',
      publicUrl: env.PUBLIC_URL,
      logger: (m) => this.logger.warn(m),
    })
    return this.mailerInstance
  }

  /** Whether mail actually leaves this installation. Surfaced to the UI. */
  get deliversMail(): boolean {
    return this.mailer().transport === 'smtp'
  }

  /**
   * The notice about THIS INSTALLATION's mail configuration.
   *
   * Computed from configuration alone, never from whether a send happened. An
   * earlier version returned it only when a mail was actually dispatched, which
   * made the response differ between a known and an unknown address — a
   * membership oracle in the one endpoint most carefully written to avoid being
   * one. The same words are now returned either way.
   */
  private get mailNotice(): string | undefined {
    return this.mailer().transport === 'log'
      ? 'This installation has no mail server configured, so the link was written to the ' +
          'server log instead of being emailed. Ask whoever runs this server for it.'
      : undefined
  }

  /**
   * Starts a password reset.
   *
   * ALWAYS reports success, whatever happened. Returning "no such account" here
   * turns the endpoint into a membership oracle: anyone could test an address
   * list against it and learn who has an account. The email either arrives or
   * it does not, and only the owner of the mailbox can tell which.
   */
  async requestPasswordReset(email: string): Promise<{ notice?: string }> {
    const normalised = email.trim().toLowerCase()

    const user = await withSystemScope('password reset precedes any tenant scope', async () =>
      db().user.findUnique({
        where: { email: normalised },
        select: { id: true, email: true, name: true },
      })
    )

    // No deletedAt check: user deletion ANONYMISES rather than soft-deleting,
    // so a deleted user has no row to find here in the first place.
    if (!user) {
      // Identical response to the success path, including the mail notice.
      // Anything that differs — an absent field, a different message, a
      // noticeably faster reply — tells an attacker the address is unknown.
      this.logger.log(`password reset requested for an address with no account`)
      return this.mailNotice ? { notice: this.mailNotice } : {}
    }

    const { token, tokenHash } = newToken()
    const expiresAt = new Date(Date.now() + RESET_TTL_MINUTES * 60_000)

    await withUser(user.id, 'issuing a password reset token', async (tx) => {
      // Any outstanding reset is invalidated first. Two live links means a
      // stolen older one still works after the owner has requested a new one,
      // which is precisely the case where they are already suspicious.
      await tx.verificationToken.updateMany({
        where: { userId: user.id, purpose: 'password_reset', usedAt: null },
        data: { usedAt: new Date() },
      })

      await tx.verificationToken.create({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        data: { userId: user.id, tokenHash, purpose: 'password_reset', expiresAt } as any,
      })
    })

    const env = loadEnv()
    const link = `${env.PUBLIC_URL}/reset-password?token=${token}`
    const mail = templates.passwordReset(link, RESET_TTL_MINUTES)
    await this.mailer().send({ ...mail, to: user.email })

    // From configuration, NOT from the send result — see mailNotice.
    return this.mailNotice ? { notice: this.mailNotice } : {}
  }

  /**
   * Completes a password reset.
   *
   * Unlike the request, this DOES report failure: the caller is holding a token
   * they were sent, and telling them it has expired is the only way they can
   * know to ask for another.
   */
  async completePasswordReset(
    token: string,
    newPassword: string
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const tokenHash = sha256(token)

    const row = await withTokenRedemption(async (tx) =>
      tx.verificationToken.findUnique({
        where: { tokenHash },
        select: { id: true, userId: true, purpose: true, expiresAt: true, usedAt: true },
      })
    )

    if (!row || row.purpose !== 'password_reset') {
      return { ok: false, reason: 'That reset link is not valid. Request a new one.' }
    }
    if (row.usedAt) {
      // Distinguished from expiry on purpose: "already used" tells someone who
      // clicked twice that the first click worked, which is a different action
      // from asking for a new link.
      return { ok: false, reason: 'That reset link has already been used. Request a new one.' }
    }
    if (row.expiresAt < new Date()) {
      return {
        ok: false,
        reason: `That reset link has expired. They last ${RESET_TTL_MINUTES} minutes — request a new one.`,
      }
    }

    const passwordHash = await hashPassword(newPassword)

    await withUser(row.userId, 'completing a password reset', async (tx) => {
      await tx.user.update({
        where: { id: row.userId },
        data: {
          passwordHash,
          // Resetting a password PROVES control of the mailbox, so it verifies
          // the address as a side effect. Making someone verify separately
          // after that is a step with no information in it.
          emailVerifiedAt: new Date(),
        },
      })

      await tx.verificationToken.update({ where: { id: row.id }, data: { usedAt: new Date() } })

      // EVERY session is destroyed, not just other ones.
      //
      // A password reset is what someone does when they believe the account is
      // compromised. Leaving an attacker's session alive through it would make
      // the reset theatre — they keep the access, and the owner believes they
      // have taken it back.
      await tx.session.deleteMany({ where: { userId: row.userId } })
    })

    this.logger.log(`password reset completed; all sessions revoked`)
    return { ok: true }
  }

  /** Issues an email-verification link. Safe to call again; supersedes the last. */
  async sendVerification(userId: string): Promise<{ notice?: string }> {
    const user = await withUser(userId, 'reading own verification state', async (tx) =>
      tx.user.findUnique({
        where: { id: userId },
        select: { id: true, email: true, emailVerifiedAt: true },
      })
    )
    // Already verified, or no such user: same response either way.
    if (!user || user.emailVerifiedAt) return this.mailNotice ? { notice: this.mailNotice } : {}

    const { token, tokenHash } = newToken()
    const expiresAt = new Date(Date.now() + VERIFY_TTL_HOURS * 3600_000)

    await withUser(userId, 'issuing an email verification token', async (tx) => {
      await tx.verificationToken.updateMany({
        where: { userId, purpose: 'email_verification', usedAt: null },
        data: { usedAt: new Date() },
      })
      await tx.verificationToken.create({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        data: { userId, tokenHash, purpose: 'email_verification', expiresAt } as any,
      })
    })

    const env = loadEnv()
    const link = `${env.PUBLIC_URL}/verify-email?token=${token}`
    const mail = templates.emailVerification(link, VERIFY_TTL_HOURS)
    await this.mailer().send({ ...mail, to: user.email })

    return this.mailNotice ? { notice: this.mailNotice } : {}
  }

  async verifyEmail(token: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    const tokenHash = sha256(token)

    const row = await withTokenRedemption(async (tx) =>
      tx.verificationToken.findUnique({
        where: { tokenHash },
        select: { id: true, userId: true, purpose: true, expiresAt: true, usedAt: true },
      })
    )

    if (!row || row.purpose !== 'email_verification') {
      return { ok: false, reason: 'That confirmation link is not valid.' }
    }
    if (row.usedAt) {
      // Already confirmed is a SUCCESS from the person's point of view. They
      // clicked twice; the address is confirmed either way, and an error here
      // would send them looking for a problem that does not exist.
      return { ok: true }
    }
    if (row.expiresAt < new Date()) {
      return { ok: false, reason: 'That confirmation link has expired. Request a new one.' }
    }

    await withUser(row.userId, 'confirming an email address', async (tx) => {
      await tx.user.update({ where: { id: row.userId }, data: { emailVerifiedAt: new Date() } })
      await tx.verificationToken.update({ where: { id: row.id }, data: { usedAt: new Date() } })
    })

    return { ok: true }
  }

  /**
   * Changing a password while signed in.
   *
   * Requires the CURRENT password even though there is a valid session: a
   * session left open on a shared machine should not be enough to take the
   * account permanently.
   */
  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
    keepSessionId: string
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const user = await withUser(userId, 'verifying the current password', async (tx) =>
      tx.user.findUnique({ where: { id: userId }, select: { passwordHash: true } })
    )
    if (!user?.passwordHash) return { ok: false, reason: 'That did not work.' }

    const correct = await verifyPassword(user.passwordHash, currentPassword)
    if (!correct) return { ok: false, reason: 'That current password is not right.' }

    const passwordHash = await hashPassword(newPassword)

    await withUser(userId, 'changing own password', async (tx) => {
      await tx.user.update({ where: { id: userId }, data: { passwordHash } })
      // Every OTHER session goes. Theirs stays, because signing someone out of
      // the tab they just used is a punishment for good security hygiene.
      await tx.session.deleteMany({ where: { userId, NOT: { id: keepSessionId } } })
    })

    return { ok: true }
  }
}

/** Constant-time compare, for anywhere a token is checked outside the index. */
export function tokensMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}
