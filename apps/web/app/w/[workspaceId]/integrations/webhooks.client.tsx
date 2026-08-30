'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Badge, Card, EmptyState, Muted } from '@/components/ui'

type Webhook = {
  id: string
  url: string
  events: string[]
  enabled: boolean
  consecutiveFailures: number
  disabledAt: string | null
  deliveries: Array<{
    id: string
    eventType: string
    attempt: number
    responseStatus: number | null
    deliveredAt: string | null
  }>
}

type EventType = { type: string; description: string }

export function WebhookManager({
  workspaceId,
  webhooks,
  eventTypes,
  canManage,
}: {
  workspaceId: string
  webhooks: Webhook[]
  eventTypes: EventType[]
  canManage: boolean
}) {
  const router = useRouter()
  const [adding, setAdding] = useState(false)
  const [url, setUrl] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** Shown once, then gone. Held in state and never re-fetched. */
  const [newSecret, setNewSecret] = useState<{
    url: string
    secret: string
  } | null>(null)
  const [testResult, setTestResult] = useState<Record<string, string>>({})

  async function call(path: string, method: string, body: unknown) {
    const response = await fetch(path, {
      method,
      headers: { 'content-type': 'application/json', 'x-smm-client': 'web' },
      body: JSON.stringify(body),
    })
    const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null
    if (!response.ok) {
      throw new Error(
        (payload?.['error'] as { message?: string } | undefined)?.message ?? 'That did not work.'
      )
    }
    return payload
  }

  async function create() {
    setBusy(true)
    setError(null)
    try {
      const result = await call('/api/v1/webhooks', 'POST', {
        workspaceId,
        url,
        events: selected,
      })
      setNewSecret({ url, secret: String(result?.['signingSecret'] ?? '') })
      setUrl('')
      setSelected([])
      setAdding(false)
      router.refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That did not work.')
    }
    setBusy(false)
  }

  async function toggle(hook: Webhook) {
    setBusy(true)
    setError(null)
    try {
      await call(`/api/v1/webhooks/${hook.id}`, 'PATCH', {
        workspaceId,
        enabled: !hook.enabled,
      })
      router.refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : null)
    }
    setBusy(false)
  }

  async function sendTest(hook: Webhook) {
    setBusy(true)
    setTestResult((t) => ({ ...t, [hook.id]: 'Sending...' }))
    try {
      const result = await call(`/api/v1/webhooks/${hook.id}/test`, 'POST', {
        workspaceId,
      })
      setTestResult((t) => ({
        ...t,
        [hook.id]: String(result?.['message'] ?? ''),
      }))
    } catch (e) {
      setTestResult((t) => ({
        ...t,
        [hook.id]: e instanceof Error ? e.message : 'Failed.',
      }))
    }
    setBusy(false)
  }

  async function remove(hook: Webhook) {
    setBusy(true)
    try {
      await fetch(`/api/v1/webhooks/${hook.id}?workspaceId=${workspaceId}`, {
        method: 'DELETE',
        headers: { 'x-smm-client': 'web' },
      })
      router.refresh()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-2">
      {newSecret && (
        <Card className="p-4 bg-primary/5">
          <p className="text-sm font-medium">Signing secret for {newSecret.url}</p>
          <p className="mt-1 text-xs">
            <Muted>
              Copy it now. It is not shown again, and the only recovery is to rotate — which is what
              makes it a secret rather than a value sitting in a page anyone can screenshot.
            </Muted>
          </p>
          <code className="mt-2 block break-all rounded border p-2 text-xs border-border">
            {newSecret.secret}
          </code>
          <button
            type="button"
            onClick={() => setNewSecret(null)}
            className="mt-2 text-xs underline text-muted-foreground"
          >
            I have copied it
          </button>
        </Card>
      )}

      {webhooks.length === 0 && !adding && (
        <EmptyState
          title="No webhooks"
          hint="Add one to receive an HTTP POST whenever a post publishes, fails, or misses its window."
        />
      )}

      {webhooks.map((hook) => (
        <Card key={hook.id} className="p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <p className="truncate text-sm font-medium">{hook.url}</p>
                {!hook.enabled && <Badge tone="warn">disabled</Badge>}
              </div>
              <p className="mt-0.5 text-xs">
                <Muted>{hook.events.join(', ')}</Muted>
              </p>
              {hook.disabledAt && (
                <p className="mt-1 text-xs text-destructive">
                  Auto-disabled after {hook.consecutiveFailures} consecutive failures. Fix the
                  endpoint, then re-enable — the failure count resets when you do.
                </p>
              )}
              {testResult[hook.id] && (
                <p className="mt-1 text-xs">
                  <Muted>{testResult[hook.id]}</Muted>
                </p>
              )}
            </div>

            {canManage && (
              <div className="flex shrink-0 gap-1.5">
                <SmallButton busy={busy} onClick={() => void sendTest(hook)}>
                  Send test
                </SmallButton>
                <SmallButton busy={busy} onClick={() => void toggle(hook)}>
                  {hook.enabled ? 'Disable' : 'Enable'}
                </SmallButton>
                <SmallButton busy={busy} onClick={() => void remove(hook)}>
                  Delete
                </SmallButton>
              </div>
            )}
          </div>

          {hook.deliveries.length > 0 && (
            <div className="mt-3 border-t pt-2 border-border">
              <p className="text-xs font-medium">
                <Muted>Recent deliveries</Muted>
              </p>
              {hook.deliveries.map((d) => (
                <div key={d.id} className="flex items-center justify-between gap-3 py-0.5 text-xs">
                  <span className="truncate">
                    <Muted>{d.eventType}</Muted>
                  </span>
                  {d.deliveredAt ? (
                    <Badge>{String(d.responseStatus ?? 'sent')}</Badge>
                  ) : (
                    // The attempt number, not a bare "failed": attempt 1 versus
                    // attempt 5 is a blip versus an endpoint about to be
                    // auto-disabled.
                    <Badge tone="warn">attempt {d.attempt}</Badge>
                  )}
                </div>
              ))}
            </div>
          )}
        </Card>
      ))}

      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}

      {canManage &&
        (adding ? (
          <Card className="space-y-3 p-4">
            <div>
              <label className="block text-xs font-medium" htmlFor="hook-url">
                Endpoint URL
              </label>
              <input
                id="hook-url"
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://example.com/hooks/smm"
                className="mt-0.5 w-full rounded border bg-transparent px-2 py-1 text-sm border-border"
              />
            </div>

            <fieldset>
              <legend className="text-xs font-medium">Events</legend>
              <div className="mt-1 space-y-1">
                {eventTypes.map((e) => (
                  <label key={e.type} className="flex items-start gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={selected.includes(e.type)}
                      onChange={(ev) =>
                        setSelected((s) =>
                          ev.target.checked ? [...s, e.type] : s.filter((x) => x !== e.type)
                        )
                      }
                      className="mt-0.5"
                    />
                    <span>
                      <code>{e.type}</code> — <Muted>{e.description}</Muted>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>

            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => void create()}
                disabled={busy || !url.trim() || selected.length === 0}
                className="rounded px-3 py-1.5 text-sm font-medium transition-opacity disabled:opacity-40 bg-primary text-primary-foreground"
              >
                {busy ? 'Creating...' : 'Create webhook'}
              </button>
              <button
                type="button"
                onClick={() => setAdding(false)}
                className="px-2 py-1.5 text-sm text-muted-foreground"
              >
                Cancel
              </button>
            </div>
          </Card>
        ) : (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="rounded border px-3 py-1.5 text-sm border-border"
          >
            Add webhook
          </button>
        ))}
    </div>
  )
}

function SmallButton({
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
