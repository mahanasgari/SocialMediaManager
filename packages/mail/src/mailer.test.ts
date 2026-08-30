import { describe, expect, it, vi } from 'vitest'
import { Mailer, templates } from './mailer.js'

const base = { from: 'noreply@example.com', publicUrl: 'https://smm.example.com' }

describe('transport selection', () => {
  it('uses the log transport when no SMTP is configured', () => {
    expect(new Mailer({ ...base, smtpUrl: undefined }).transport).toBe('log')
  })

  it('uses SMTP when a URL is supplied', () => {
    expect(new Mailer({ ...base, smtpUrl: 'smtp://user:pass@localhost:2525' }).transport).toBe(
      'smtp'
    )
  })

  it('treats an empty string as unconfigured, not as a URL', () => {
    // An env var set to '' is the normal way a .env file expresses "not set",
    // and treating it as a connection string produces an obscure failure at the
    // first send instead of the honest log transport.
    expect(new Mailer({ ...base, smtpUrl: '' }).transport).toBe('log')
  })
})

describe('the log transport', () => {
  it('reports NOT delivered, rather than claiming success', async () => {
    // The whole reason it exists. Reporting success would turn "reset your
    // password" into a feature that silently does nothing, and somebody would
    // wait for an email that was never going to arrive.
    const mailer = new Mailer({ ...base, logger: () => {} })
    const result = await mailer.send({ to: 'a@b.c', subject: 'x', text: 'y' })

    expect(result.delivered).toBe(false)
    expect(result.transport).toBe('log')
  })

  it('returns a notice that tells the reader what to do', async () => {
    const mailer = new Mailer({ ...base, logger: () => {} })
    const result = await mailer.send({ to: 'a@b.c', subject: 'x', text: 'y' })

    expect(result.notice).toMatch(/no mail server/i)
    expect(result.notice).toMatch(/server log/i)
  })

  it('writes the FULL body, so the link is actually usable', async () => {
    // A log line saying "an email would have been sent" helps nobody. The
    // operator has to be able to read the link out.
    const lines: string[] = []
    const mailer = new Mailer({ ...base, logger: (m) => lines.push(m) })

    await mailer.send({
      to: 'grace@example.com',
      subject: 'Reset your password',
      text: 'Open this link:\nhttps://smm.example.com/reset-password?token=abc123',
    })

    const output = lines.join('\n')
    expect(output).toContain('grace@example.com')
    expect(output).toContain('Reset your password')
    expect(output).toContain('https://smm.example.com/reset-password?token=abc123')
  })

  it('says how to fix it', async () => {
    const lines: string[] = []
    const mailer = new Mailer({ ...base, logger: (m) => lines.push(m) })
    await mailer.send({ to: 'a@b.c', subject: 'x', text: 'y' })
    expect(lines.join('\n')).toContain('SMTP_URL')
  })

  it('verify() succeeds, because there is nothing to reach', async () => {
    const mailer = new Mailer({ ...base, logger: () => {} })
    await expect(mailer.verify()).resolves.toEqual({ ok: true })
  })

  it('reports an unreachable SMTP server rather than throwing at boot', async () => {
    // Port 1 is reserved and never listening. A boot check that throws takes
    // the whole API down over a mail misconfiguration; one that reports lets
    // the operator see it and keep publishing.
    const mailer = new Mailer({ ...base, smtpUrl: 'smtp://127.0.0.1:1', logger: () => {} })
    const result = await mailer.verify()
    expect(result.ok).toBe(false)
    expect(result.error).toBeTruthy()
  }, 20_000)
})

describe('templates', () => {
  it('includes the link and the expiry in a reset message', () => {
    const mail = templates.passwordReset('https://smm.example.com/reset-password?token=t', 30)
    expect(mail.text).toContain('https://smm.example.com/reset-password?token=t')
    expect(mail.text).toContain('30 minutes')
  })

  it('tells the reader what to do if they did not ask for it', () => {
    // An unexpected password-reset email is the first sign somebody else is
    // trying to get in, and this message is the only place to say so.
    const mail = templates.passwordReset('https://x/y', 30)
    expect(mail.text).toMatch(/not you/i)
    expect(mail.text).toMatch(/has not changed/i)
  })

  it('says a reset link is single-use, so a second click is not a surprise', () => {
    expect(templates.passwordReset('https://x/y', 30).text).toMatch(/once/i)
  })

  it('builds a verification message with hours, not minutes', () => {
    const mail = templates.emailVerification('https://x/y', 48)
    expect(mail.text).toContain('48 hours')
    expect(mail.subject).toMatch(/confirm/i)
  })

  it('names the inviter and the organization in an invite', () => {
    // "You have been invited" from nobody in particular reads as spam.
    const mail = templates.invite('https://x/y', 'Northwind', 'Grace Hopper')
    expect(mail.subject).toContain('Grace Hopper')
    expect(mail.subject).toContain('Northwind')
    expect(mail.text).toContain('https://x/y')
  })

  it('produces plain text only, with no HTML to render differently anywhere', () => {
    for (const mail of [
      templates.passwordReset('https://x/y', 30),
      templates.emailVerification('https://x/y', 48),
      templates.invite('https://x/y', 'Org', 'Someone'),
    ]) {
      expect(mail.text).not.toMatch(/<[a-z]+[\s>]/i)
    }
  })
})

describe('SMTP transport', () => {
  it('sends through nodemailer and reports delivery', async () => {
    const mailer = new Mailer({ ...base, smtpUrl: 'smtp://127.0.0.1:2525' })
    const sendMail = vi.fn().mockResolvedValue({ messageId: 'x' })
    // Replacing the transporter rather than standing up an SMTP server: the
    // thing worth asserting is that a configured mailer reports delivery and
    // passes the message through unchanged.
    ;(mailer as unknown as { transporter: { sendMail: unknown } }).transporter = { sendMail }

    const result = await mailer.send({ to: 'a@b.c', subject: 'Subject', text: 'Body' })

    expect(result).toEqual({ transport: 'smtp', delivered: true })
    expect(sendMail).toHaveBeenCalledWith({
      from: 'noreply@example.com',
      to: 'a@b.c',
      subject: 'Subject',
      text: 'Body',
    })
  })
})
