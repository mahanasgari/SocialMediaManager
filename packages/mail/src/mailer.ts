import { createTransport, type Transporter } from 'nodemailer'

/**
 * Outbound mail.
 *
 * A self-hosted deployment very often has no SMTP server, and the tempting
 * response — pretend the mail was sent — turns "reset your password" into a
 * feature that silently does nothing. Somebody then waits for an email that was
 * never going to arrive.
 *
 * So there are two transports and the difference is visible to the operator:
 *
 *   - `smtp`    real delivery, configured with SMTP_URL.
 *   - `log`     the message is written to the server log, including the link.
 *               An operator with shell access can still complete the flow, and
 *               the UI SAYS this is what happens rather than implying an email
 *               is on its way.
 *
 * There is deliberately no silent third option.
 */

export type MailTransport = 'smtp' | 'log'

export type Mail = {
  to: string
  subject: string
  /** Plain text. No HTML: these are five-line transactional messages. */
  text: string
}

export type SendResult = {
  transport: MailTransport
  delivered: boolean
  /** Present when the log transport was used, so a caller can say so honestly. */
  notice?: string
}

export type MailerOptions = {
  /** e.g. smtp://user:pass@host:587 or smtps://… for implicit TLS. */
  smtpUrl?: string | undefined
  from: string
  /** Where links point. Used only to make log output actionable. */
  publicUrl: string
  logger?: (message: string) => void
}

export class Mailer {
  private readonly transporter: Transporter | null
  readonly transport: MailTransport

  constructor(private readonly options: MailerOptions) {
    if (options.smtpUrl) {
      this.transporter = createTransport(options.smtpUrl, { from: options.from })
      this.transport = 'smtp'
    } else {
      this.transporter = null
      this.transport = 'log'
    }
  }

  /**
   * Confirms the SMTP server is reachable and the credentials work.
   *
   * Called at boot rather than at first send. An SMTP misconfiguration
   * discovered when someone tries to reset their password is discovered by the
   * one person least able to do anything about it.
   */
  async verify(): Promise<{ ok: boolean; error?: string }> {
    if (!this.transporter) return { ok: true }
    try {
      await this.transporter.verify()
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  async send(mail: Mail): Promise<SendResult> {
    if (!this.transporter) {
      // Logged in full, with the link intact. This is the whole point of the
      // log transport: it must be genuinely usable, not a placeholder.
      const log = this.options.logger ?? ((m: string) => console.warn(m))
      log(
        [
          '',
          '─── MAIL NOT SENT: no SMTP is configured ───────────────────────────',
          `  to      : ${mail.to}`,
          `  subject : ${mail.subject}`,
          '',
          mail.text
            .split('\n')
            .map((line) => `  ${line}`)
            .join('\n'),
          '',
          '  Set SMTP_URL to deliver this by email instead.',
          '────────────────────────────────────────────────────────────────────',
          '',
        ].join('\n')
      )

      return {
        transport: 'log',
        delivered: false,
        notice:
          'This installation has no mail server configured, so the link was written to the ' +
          'server log instead of being emailed. Ask whoever runs this server for it.',
      }
    }

    await this.transporter.sendMail({
      from: this.options.from,
      to: mail.to,
      subject: mail.subject,
      text: mail.text,
    })

    return { transport: 'smtp', delivered: true }
  }
}

/**
 * The transactional messages, in one place.
 *
 * Plain text, short, and each says what to do if it was not expected — because
 * an unexpected password-reset email is the first sign somebody else is trying
 * to get in, and the message is the only place to say so.
 */
export const templates = {
  passwordReset(link: string, expiresInMinutes: number): Mail & { to: string } {
    return {
      to: '',
      subject: 'Reset your password',
      text: [
        'Someone asked to reset the password for this account.',
        '',
        'Open this link to choose a new one:',
        link,
        '',
        `The link stops working in ${expiresInMinutes} minutes, and can only be used once.`,
        '',
        'If this was not you, no action is needed — your password has not changed. ',
        'It is worth knowing that someone tried, though.',
      ].join('\n'),
    }
  },

  emailVerification(link: string, expiresInHours: number): Mail & { to: string } {
    return {
      to: '',
      subject: 'Confirm your email address',
      text: [
        'Confirm this address to finish setting up your account:',
        link,
        '',
        `The link stops working in ${expiresInHours} hours.`,
        '',
        'If you did not create an account, you can ignore this.',
      ].join('\n'),
    }
  },

  invite(link: string, organizationName: string, inviterName: string): Mail & { to: string } {
    return {
      to: '',
      subject: `${inviterName} invited you to ${organizationName}`,
      text: [
        `${inviterName} has invited you to join ${organizationName}.`,
        '',
        'Accept here:',
        link,
        '',
        'If you were not expecting this, you can ignore it.',
      ].join('\n'),
    }
  },
} as const
