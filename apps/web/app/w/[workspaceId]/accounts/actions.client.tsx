'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

export function ConnectButton({
  workspaceId,
  provider,
  disabled,
}: {
  workspaceId: string
  provider: string
  disabled: boolean
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  return (
    <div className="shrink-0 text-right">
      <button
        type="button"
        disabled={disabled || busy}
        onClick={async () => {
          setBusy(true)
          setError(null)
          const response = await fetch(`/api/v1/social-accounts/connect/${provider}`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-smm-client': 'web',
            },
            body: JSON.stringify({
              workspaceId,
              returnTo: `/w/${workspaceId}/accounts`,
            }),
          })

          if (!response.ok) {
            const body = (await response.json().catch(() => null)) as {
              error?: { message?: string }
            } | null
            // Surface the API's own message — it names the provider and says
            // whether the problem is "not built" or "not configured", which are
            // different problems for whoever is reading.
            setError(body?.error?.message ?? 'Could not start the connection.')
            setBusy(false)
            return
          }

          // The provider decides where to send the browser. For the mock that is
          // straight back to our own callback, so the full flow — signed state,
          // redirect allowlisting, credential encryption — actually runs.
          const { url } = (await response.json()) as { url: string }
          window.location.href = url
        }}
        className="rounded px-3 py-1.5 text-sm font-medium disabled:opacity-40 bg-primary text-primary-foreground"
      >
        {busy ? 'Connecting…' : 'Connect'}
      </button>
      {error && <p className="mt-1 max-w-[16rem] text-xs text-muted-foreground">{error}</p>}
    </div>
  )
}

export function DisconnectButton({
  workspaceId,
  accountId,
  name,
}: {
  workspaceId: string
  accountId: string
  name: string
}) {
  const router = useRouter()
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)

  if (!confirming) {
    return (
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className="shrink-0 text-sm underline text-muted-foreground"
      >
        Disconnect
      </button>
    )
  }

  return (
    <div className="shrink-0 text-right">
      {/* Inline confirmation rather than confirm(): a browser modal blocks the
          page, and this can say what will actually happen to the data. */}
      <p className="mb-1 text-xs text-muted-foreground">Disconnect {name}? History is kept.</p>
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true)
          await fetch(`/api/v1/social-accounts/${accountId}?workspaceId=${workspaceId}`, {
            method: 'DELETE',
            headers: { 'x-smm-client': 'web' },
          })
          router.refresh()
          setBusy(false)
          setConfirming(false)
        }}
        className="rounded border px-2 py-1 text-xs border-border"
      >
        {busy ? 'Disconnecting…' : 'Confirm'}
      </button>
      <button
        type="button"
        onClick={() => setConfirming(false)}
        className="ml-2 text-xs underline text-muted-foreground"
      >
        Cancel
      </button>
    </div>
  )
}
