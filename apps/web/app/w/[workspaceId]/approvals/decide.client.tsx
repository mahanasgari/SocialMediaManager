'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

export function DecideButtons({ workspaceId, postId }: { workspaceId: string; postId: string }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [requesting, setRequesting] = useState(false)
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)

  async function decide(decision: 'APPROVED' | 'CHANGES_REQUESTED') {
    setBusy(true)
    setError(null)

    const response = await fetch(`/api/v1/approvals/posts/${postId}/decide`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-smm-client': 'web' },
      body: JSON.stringify({ workspaceId, decision, note: note || undefined }),
    })

    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as {
        error?: { message?: string }
      } | null
      setError(body?.error?.message ?? 'Could not record that decision.')
      setBusy(false)
      return
    }

    setBusy(false)
    setRequesting(false)
    setNote('')
    router.refresh()
  }

  return (
    <>
      {requesting ? (
        <div className="space-y-2">
          {/* A rejection without a reason sends the author back to a draft with
              no idea what to change, so the note is prompted for rather than
              buried behind an optional field. */}
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            placeholder="What needs changing?"
            className="w-full rounded border bg-transparent px-3 py-2 text-sm outline-none border-border"
          />
          <div className="flex gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => decide('CHANGES_REQUESTED')}
              className="rounded border px-3 py-1.5 text-sm disabled:opacity-50 border-border"
            >
              {busy ? 'Sending…' : 'Send back for changes'}
            </button>
            <button
              type="button"
              onClick={() => setRequesting(false)}
              className="text-sm underline text-muted-foreground"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => decide('APPROVED')}
            className="rounded px-3 py-1.5 text-sm font-medium disabled:opacity-50 bg-primary text-primary-foreground"
          >
            {busy ? 'Working…' : 'Approve'}
          </button>
          <button
            type="button"
            onClick={() => setRequesting(true)}
            className="text-sm underline text-muted-foreground"
          >
            Request changes
          </button>
        </div>
      )}

      {error && (
        <p className="mt-2 text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
    </>
  )
}
