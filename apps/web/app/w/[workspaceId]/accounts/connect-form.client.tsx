'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

type Field = {
  name: string
  label: string
  type: string
  hint?: string
  placeholder?: string
}

/**
 * The connect form for any provider that needs values before connecting.
 *
 * Two different flows share it, because they collect the same way and differ
 * only in what happens after:
 *
 *   - `credentials` — the values ARE the credential (a Bluesky app password, a
 *     Telegram bot token). Submitted, verified, done. No redirect exists.
 *   - `oauth` with fields — the values are needed to BUILD the authorize URL.
 *     Mastodon registers its app per instance, so there is nothing to redirect
 *     to until someone names one.
 *
 * Fields are rendered from the provider's own declaration, so a new connector
 * of either kind needs no change here.
 */
export function ConnectForm({
  workspaceId,
  provider,
  label,
  fields,
  authStyle,
  disabled,
}: {
  workspaceId: string
  provider: string
  label: string
  fields: Field[]
  authStyle: 'oauth' | 'credentials'
  disabled: boolean
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [values, setValues] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    setBusy(true)
    setError(null)

    const response = await fetch(
      authStyle === 'credentials'
        ? `/api/v1/social-accounts/connect/${provider}/credentials`
        : `/api/v1/social-accounts/connect/${provider}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-smm-client': 'web' },
        body: JSON.stringify(
          authStyle === 'credentials'
            ? { workspaceId, credentials: values }
            : {
                workspaceId,
                fields: values,
                returnTo: `/w/${workspaceId}/accounts`,
              }
        ),
      }
    )

    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as {
        error?: { message?: string }
      } | null
      // The provider's own message. It distinguishes a wrong password from a
      // revoked one from an unreachable instance, and those are different
      // problems for whoever is reading.
      setError(body?.error?.message ?? `Could not connect to ${label}.`)
      setBusy(false)
      return
    }

    // An OAuth provider hands back a URL: the browser goes to the instance to
    // authorise, and comes back through our callback. A credentials provider is
    // already finished by this point.
    if (authStyle === 'oauth') {
      const payload = (await response.json().catch(() => null)) as {
        url?: string
      } | null
      if (payload?.url) {
        window.location.href = payload.url
        return
      }
      setError('The provider did not return a sign-in link.')
      setBusy(false)
      return
    }

    // Cleared only on success, so a failed attempt does not make someone
    // re-type a token they pasted from another window.
    setValues({})
    setOpen(false)
    setBusy(false)
    router.refresh()
  }

  if (!open) {
    return (
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen(true)}
        className="shrink-0 rounded border px-3 py-1.5 text-sm transition-opacity disabled:opacity-40 border-border"
      >
        Connect
      </button>
    )
  }

  return (
    <div className="w-full max-w-sm shrink-0 space-y-2">
      {fields.map((field) => (
        <div key={field.name}>
          <label className="block text-xs font-medium" htmlFor={`${provider}-${field.name}`}>
            {field.label}
          </label>
          <input
            id={`${provider}-${field.name}`}
            type={field.type === 'password' ? 'password' : 'text'}
            // Password managers offering to save a bot token, and browsers
            // autofilling an unrelated login into it, are both worse than no
            // help at all here.
            autoComplete="off"
            placeholder={field.placeholder ?? ''}
            value={values[field.name] ?? ''}
            onChange={(e) => setValues((v) => ({ ...v, [field.name]: e.target.value }))}
            disabled={busy}
            className="mt-0.5 w-full rounded border bg-transparent px-2 py-1 text-sm border-border"
          />
          {field.hint && <p className="mt-0.5 text-xs text-muted-foreground">{field.hint}</p>}
        </div>
      ))}

      {error && (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      )}

      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => void submit()}
          disabled={busy || fields.some((f) => !values[f.name]?.trim())}
          className="rounded px-3 py-1.5 text-sm font-medium transition-opacity disabled:opacity-40 bg-primary text-primary-foreground"
        >
          {busy ? 'Checking...' : authStyle === 'oauth' ? 'Continue' : 'Connect'}
        </button>
        <button
          type="button"
          onClick={() => {
            setOpen(false)
            setError(null)
          }}
          disabled={busy}
          className="rounded px-2 py-1.5 text-sm text-muted-foreground"
        >
          Cancel
        </button>
      </div>

      <p className="text-xs text-muted-foreground">
        {authStyle === 'oauth'
          ? `You will be sent to ${label} to authorise, then brought back here.`
          : `Verified with ${label} before anything is saved, and encrypted at rest.`}
      </p>
    </div>
  )
}
