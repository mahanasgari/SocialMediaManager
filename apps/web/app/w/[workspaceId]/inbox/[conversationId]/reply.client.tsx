'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

export function ReplyBox({
  workspaceId,
  conversationId,
}: {
  workspaceId: string
  conversationId: string
}) {
  const router = useRouter()
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function send() {
    if (!body.trim()) return
    setBusy(true)
    setError(null)

    const response = await fetch(`/api/v1/inbox/conversations/${conversationId}/reply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-smm-client': 'web' },
      body: JSON.stringify({ workspaceId, body }),
    })

    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as {
        error?: { message?: string }
      } | null
      // The provider's own explanation, verbatim. "Could not send" tells the
      // person nothing they can act on, and the reason is the only useful part.
      setError(payload?.error?.message ?? 'That reply was not sent.')
      setBusy(false)
      return
    }

    // Cleared ONLY after the provider accepted it. Clearing optimistically
    // loses what someone wrote the moment a send fails, which is the worst
    // possible time to lose it.
    setBody('')
    setBusy(false)
    router.refresh()
  }

  return (
    <div className="space-y-2">
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          // Enter inserts a newline; the shortcut requires a modifier. A bare
          // Enter that sends is how half-written replies reach an audience.
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void send()
        }}
        placeholder="Write a reply…"
        rows={3}
        disabled={busy}
        className="w-full resize-y rounded border bg-transparent px-3 py-2 text-sm border-border"
      />

      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => void send()}
          disabled={busy || !body.trim()}
          className="rounded px-3 py-1.5 text-sm font-medium transition-opacity disabled:opacity-40 bg-primary text-primary-foreground"
        >
          {busy ? 'Sending…' : 'Send reply'}
        </button>
        <span className="text-xs text-muted-foreground">
          Sends from the connected account. Ctrl/⌘ + Enter to send.
        </span>
      </div>
    </div>
  )
}
