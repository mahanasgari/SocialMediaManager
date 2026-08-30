'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

const ROLES = [
  'ADMIN',
  'MANAGER',
  'EDITOR',
  'AUTHOR',
  'APPROVER',
  'ANALYST',
  'CLIENT',
  'VIEWER',
] as const

export function InviteForm({ workspaceId }: { workspaceId: string }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [token, setToken] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const link = token ? `${window.location.origin}/register?invite=${token}` : null

  return (
    <>
      <form
        className="flex flex-wrap items-end gap-2"
        action={async (formData: FormData) => {
          setBusy(true)
          setError(null)
          setToken(null)

          const response = await fetch(`/api/v1/workspaces/${workspaceId}/invites`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-smm-client': 'web',
            },
            body: JSON.stringify({
              email: String(formData.get('email') ?? ''),
              role: String(formData.get('role') ?? 'EDITOR'),
            }),
          })

          if (!response.ok) {
            const body = (await response.json().catch(() => null)) as {
              error?: { message?: string }
            } | null
            setError(body?.error?.message ?? 'Could not create the invite.')
            setBusy(false)
            return
          }

          const result = (await response.json()) as { token: string }
          setToken(result.token)
          setBusy(false)
          router.refresh()
        }}
      >
        <label className="flex-1">
          <span className="text-xs font-medium">Email</span>
          <input
            name="email"
            type="email"
            required
            placeholder="teammate@example.com"
            className="mt-1 w-full rounded border bg-transparent px-3 py-2 text-sm outline-none border-border"
          />
        </label>

        <label>
          <span className="text-xs font-medium">Role</span>
          <select
            name="role"
            defaultValue="EDITOR"
            className="mt-1 rounded border bg-transparent px-3 py-2 text-sm outline-none border-border"
          >
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </label>

        <button
          type="submit"
          disabled={busy}
          className="rounded px-3 py-2 text-sm font-medium disabled:opacity-60 bg-primary text-primary-foreground"
        >
          {busy ? 'Creating…' : 'Create invite'}
        </button>
      </form>

      {error && <p className="mt-2 text-sm text-muted-foreground">{error}</p>}

      {link && (
        <div className="mt-3 rounded border p-3 border-border bg-card">
          <p className="text-xs font-medium">Copy this link now — it is not shown again.</p>
          <div className="mt-2 flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded px-2 py-1 text-xs bg-muted">
              {link}
            </code>
            <button
              type="button"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(link)
                  setCopied(true)
                  setTimeout(() => setCopied(false), 2000)
                } catch {
                  // Clipboard access can be denied; the link is selectable
                  // anyway, so this is not worth an error state.
                }
              }}
              className="shrink-0 rounded border px-2 py-1 text-xs border-border"
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            Email delivery is not built yet, so send this yourself.
          </p>
        </div>
      )}
    </>
  )
}
