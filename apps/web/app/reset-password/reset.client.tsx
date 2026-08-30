'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'

export function ResetForm({ token }: { token: string }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')

  // Checked here as well as on the server. Not security — it is so someone who
  // mistypes finds out before spending a single-use token they would then have
  // to request again.
  const mismatch = confirm.length > 0 && password !== confirm
  const tooShort = password.length > 0 && password.length < 8

  async function submit() {
    setBusy(true)
    setError(null)

    const response = await fetch('/api/v1/auth/reset-password', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-smm-client': 'web' },
      body: JSON.stringify({ token, password }),
    })

    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as {
        error?: { message?: string }
      } | null
      setError(payload?.error?.message ?? 'That did not work.')
      setBusy(false)
      return
    }

    setDone(true)
    setBusy(false)
  }

  if (done) {
    return (
      <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-6">
        <h1 className="text-xl font-semibold tracking-tight">Password changed</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Every session has been signed out, including any you did not recognise. Sign in with your
          new password to continue.
        </p>
        <button
          type="button"
          onClick={() => router.push('/login')}
          className="mt-6 w-full rounded px-3 py-2 text-sm font-medium bg-primary text-primary-foreground"
        >
          Sign in
        </button>
      </main>
    )
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-6">
      <h1 className="text-xl font-semibold tracking-tight">Choose a new password</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        At least 8 characters. A long phrase you can remember beats a short cryptic one.
      </p>

      <div className="mt-6 space-y-3">
        <Field
          id="password"
          label="New password"
          value={password}
          onChange={setPassword}
          error={tooShort ? 'Use at least 8 characters.' : null}
        />
        <Field
          id="confirm"
          label="Confirm new password"
          value={confirm}
          onChange={setConfirm}
          error={mismatch ? 'These do not match.' : null}
        />

        {error && (
          <p className="text-sm text-destructive" role="alert">
            {error}
            {/* A spent or expired token cannot be recovered from on this page,
                so the way out is offered with the error rather than left for
                the reader to work out. */}
            <br />
            <Link href="/forgot-password" className="underline">
              Request a new link
            </Link>
          </p>
        )}

        <button
          type="button"
          onClick={() => void submit()}
          disabled={busy || password.length < 8 || password !== confirm}
          className="w-full rounded px-3 py-2 text-sm font-medium transition-opacity disabled:opacity-40 bg-primary text-primary-foreground"
        >
          {busy ? 'Saving...' : 'Set new password'}
        </button>
      </div>
    </main>
  )
}

function Field({
  id,
  label,
  value,
  onChange,
  error,
}: {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  error: string | null
}) {
  return (
    <div>
      <label className="block text-sm font-medium" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        type="password"
        autoComplete="new-password"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full rounded border bg-transparent px-3 py-2 text-sm border-border"
      />
      {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
    </div>
  )
}
