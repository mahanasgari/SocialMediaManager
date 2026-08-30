'use client'

import { useState } from 'react'
import Link from 'next/link'

export function ForgotForm({ deliversMail }: { deliversMail: boolean }) {
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState<{ message: string; notice?: string } | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function submit(formData: FormData) {
    setBusy(true)
    setError(null)

    const response = await fetch('/api/v1/auth/forgot-password', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-smm-client': 'web' },
      body: JSON.stringify({ email: String(formData.get('email') ?? '') }),
    })

    const payload = (await response.json().catch(() => null)) as {
      message?: string
      notice?: string
      error?: { message?: string }
    } | null

    if (!response.ok) {
      setError(payload?.error?.message ?? 'Something went wrong. Try again.')
      setBusy(false)
      return
    }

    setSent({
      message: payload?.message ?? 'If that address has an account, a reset link is on its way.',
      ...(payload?.notice ? { notice: payload.notice } : {}),
    })
    setBusy(false)
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-6">
      <h1 className="text-xl font-semibold tracking-tight">Reset your password</h1>

      {!deliversMail && (
        <div className="mt-4 rounded border p-3 text-sm border-border bg-muted/40">
          {/* Said BEFORE the form, not after submitting. The person who needs
              this most is locked out, and letting them submit into a void and
              then wait is the worst possible order to tell them in. */}
          This installation has no mail server configured, so the reset link will be written to the
          server log rather than emailed. You can still request one — but somebody with access to
          the server will have to read it to you.
        </div>
      )}

      {sent ? (
        <>
          <p className="mt-4 text-sm">{sent.message}</p>
          {sent.notice && <p className="mt-2 text-sm text-muted-foreground">{sent.notice}</p>}
          <Link href="/login" className="mt-6 text-sm underline">
            Back to sign in
          </Link>
        </>
      ) : (
        <>
          <p className="mt-1 text-sm text-muted-foreground">
            Enter your email address and we will send a link to set a new one.
          </p>

          <form action={submit} className="mt-6 space-y-3">
            <div>
              <label className="block text-sm font-medium" htmlFor="email">
                Email
              </label>
              <input
                id="email"
                name="email"
                type="email"
                autoComplete="email"
                required
                className="mt-1 w-full rounded border bg-transparent px-3 py-2 text-sm border-border"
              />
            </div>

            {error && (
              <p className="text-sm text-destructive" role="alert">
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={busy}
              className="w-full rounded px-3 py-2 text-sm font-medium transition-opacity disabled:opacity-40 bg-primary text-primary-foreground"
            >
              {busy ? 'Sending...' : 'Send reset link'}
            </button>
          </form>

          <Link href="/login" className="mt-4 text-sm underline">
            Back to sign in
          </Link>
        </>
      )}
    </main>
  )
}
