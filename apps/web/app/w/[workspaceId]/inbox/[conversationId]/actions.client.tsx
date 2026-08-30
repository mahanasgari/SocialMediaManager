'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

export function ConversationActions({
  workspaceId,
  conversationId,
  status,
}: {
  workspaceId: string
  conversationId: string
  status: 'OPEN' | 'SNOOZED' | 'ARCHIVED'
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)

  async function set(next: 'OPEN' | 'SNOOZED' | 'ARCHIVED') {
    setBusy(true)
    await fetch(`/api/v1/inbox/conversations/${conversationId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-smm-client': 'web' },
      body: JSON.stringify({ workspaceId, status: next }),
    })
    setBusy(false)
    router.refresh()
  }

  return (
    <div className="flex gap-1.5">
      {status !== 'ARCHIVED' && (
        <ActionButton busy={busy} onClick={() => void set('ARCHIVED')}>
          Archive
        </ActionButton>
      )}
      {status !== 'SNOOZED' && status !== 'ARCHIVED' && (
        <ActionButton busy={busy} onClick={() => void set('SNOOZED')}>
          Snooze
        </ActionButton>
      )}
      {status !== 'OPEN' && (
        <ActionButton busy={busy} onClick={() => void set('OPEN')}>
          Reopen
        </ActionButton>
      )}
    </div>
  )
}

function ActionButton({
  busy,
  onClick,
  children,
}: {
  busy: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className="rounded border px-2 py-0.5 text-xs transition-opacity disabled:opacity-40 border-border text-muted-foreground"
    >
      {children}
    </button>
  )
}
