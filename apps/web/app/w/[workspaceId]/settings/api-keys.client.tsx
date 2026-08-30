'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

const SCOPES = [
  'posts:read',
  'posts:write',
  'accounts:read',
  'analytics:read',
  'media:write',
] as const

export function CreateApiKey({ workspaceId }: { workspaceId: string }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [issued, setIssued] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [scopes, setScopes] = useState<string[]>(['posts:read'])

  return (
    <>
      <form
        className="space-y-3"
        action={async (formData: FormData) => {
          setBusy(true)
          setError(null)
          setIssued(null)

          const response = await fetch('/api/v1/api-keys', {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-smm-client': 'web',
            },
            body: JSON.stringify({
              workspaceId,
              name: String(formData.get('name') ?? ''),
              scopes,
            }),
          })

          if (!response.ok) {
            const body = (await response.json().catch(() => null)) as {
              error?: { message?: string }
            } | null
            setError(body?.error?.message ?? 'Could not create the key.')
            setBusy(false)
            return
          }

          const result = (await response.json()) as { key: string }
          setIssued(result.key)
          setBusy(false)
          router.refresh()
        }}
      >
        <label className="block max-w-sm">
          <span className="text-xs font-medium">Name</span>
          <input
            name="name"
            required
            placeholder="CI publisher"
            className="mt-1 w-full rounded border bg-transparent px-3 py-2 text-sm outline-none border-border"
          />
        </label>

        <fieldset>
          <legend className="text-xs font-medium">Scopes</legend>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {/* A key is not a person: it has no role and inherits none, so a
                leaked key is bounded by what it was issued for. */}
            A key can do exactly what its scopes allow — it does not inherit your role.
          </p>
          <div className="mt-1 flex flex-wrap gap-1">
            {SCOPES.map((s) => {
              const on = scopes.includes(s)
              return (
                <button
                  key={s}
                  type="button"
                  onClick={() =>
                    setScopes((prev) => (on ? prev.filter((x) => x !== s) : [...prev, s]))
                  }
                  className="rounded border px-2 py-1 font-mono text-xs"
                  style={{
                    borderColor: on ? 'hsl(var(--primary))' : 'hsl(var(--border))',
                    color: on ? 'hsl(var(--primary))' : 'hsl(var(--muted-foreground))',
                  }}
                >
                  {s}
                </button>
              )
            })}
          </div>
        </fieldset>

        <button
          type="submit"
          disabled={busy || scopes.length === 0}
          className="rounded px-3 py-2 text-sm font-medium disabled:opacity-50 bg-primary text-primary-foreground"
        >
          {busy ? 'Creating…' : 'Create key'}
        </button>
      </form>

      {error && (
        <p className="mt-2 text-sm" role="alert">
          {error}
        </p>
      )}

      {issued && (
        <div className="mt-3 rounded border p-3 border-border bg-card">
          <p className="text-xs font-medium">
            Copy this now — it is hashed and cannot be shown again.
          </p>
          <div className="mt-2 flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded px-2 py-1 font-mono text-xs bg-muted">
              {issued}
            </code>
            <button
              type="button"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(issued)
                  setCopied(true)
                  setTimeout(() => setCopied(false), 2000)
                } catch {
                  // Clipboard can be denied; the value is selectable anyway.
                }
              }}
              className="shrink-0 rounded border px-2 py-1 text-xs border-border"
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
        </div>
      )}
    </>
  )
}

export function RevokeKey({ workspaceId, keyId }: { workspaceId: string; keyId: string }) {
  const router = useRouter()
  const [confirming, setConfirming] = useState(false)

  return confirming ? (
    <span className="text-xs">
      <button
        type="button"
        onClick={async () => {
          await fetch(`/api/v1/api-keys/${keyId}?workspaceId=${workspaceId}`, {
            method: 'DELETE',
            headers: { 'x-smm-client': 'web' },
          })
          router.refresh()
        }}
        className="underline"
      >
        Confirm
      </button>
      <button
        type="button"
        onClick={() => setConfirming(false)}
        className="ml-2 underline text-muted-foreground"
      >
        Cancel
      </button>
    </span>
  ) : (
    <button
      type="button"
      onClick={() => setConfirming(true)}
      className="text-xs underline text-muted-foreground"
    >
      Revoke
    </button>
  )
}
