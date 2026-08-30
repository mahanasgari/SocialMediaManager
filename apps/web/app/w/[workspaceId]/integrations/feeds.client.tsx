'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Badge, Card, EmptyState, Muted } from '@/components/ui'

type Feed = {
  id: string
  url: string
  name: string
  template: string
  targetAccountIds: string[]
  autoPublish: boolean
  lastFetchedAt: string | null
  pausedAt: string | null
  items: Array<{
    id: string
    title: string
    link: string
    postId: string | null
  }>
}

export function FeedManager({
  workspaceId,
  feeds,
  accounts,
  canManage,
}: {
  workspaceId: string
  feeds: Feed[]
  accounts: Array<{ id: string; handle: string }>
  canManage: boolean
}) {
  const router = useRouter()
  const [adding, setAdding] = useState(false)
  const [form, setForm] = useState({
    name: '',
    url: '',
    template: '{{title}} {{link}}',
    autoPublish: false,
    targetAccountIds: [] as string[],
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function call(path: string, method: string, body: unknown) {
    const response = await fetch(path, {
      method,
      headers: { 'content-type': 'application/json', 'x-smm-client': 'web' },
      body: JSON.stringify(body),
    })
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as {
        error?: { message?: string }
      } | null
      throw new Error(payload?.error?.message ?? 'That did not work.')
    }
  }

  async function create() {
    setBusy(true)
    setError(null)
    try {
      await call('/api/v1/rss-feeds', 'POST', { workspaceId, ...form })
      setForm({
        name: '',
        url: '',
        template: '{{title}} {{link}}',
        autoPublish: false,
        targetAccountIds: [],
      })
      setAdding(false)
      router.refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That did not work.')
    }
    setBusy(false)
  }

  async function setPaused(feed: Feed, paused: boolean) {
    setBusy(true)
    setError(null)
    try {
      await call(`/api/v1/rss-feeds/${feed.id}`, 'PATCH', {
        workspaceId,
        paused,
      })
      router.refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : null)
    }
    setBusy(false)
  }

  async function remove(feed: Feed) {
    setBusy(true)
    try {
      await fetch(`/api/v1/rss-feeds/${feed.id}?workspaceId=${workspaceId}`, {
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
      {feeds.length === 0 && !adding && (
        <EmptyState
          title="No feeds"
          hint="Add a feed to turn new items into drafts automatically. Feeds are polled at most every fifteen minutes."
        />
      )}

      {feeds.map((feed) => (
        <Card key={feed.id} className="p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <p className="truncate text-sm font-medium">{feed.name}</p>
                {feed.pausedAt && <Badge tone="warn">paused</Badge>}
                {feed.autoPublish ? (
                  <Badge tone="accent">auto-publishes</Badge>
                ) : (
                  <Badge>drafts only</Badge>
                )}
              </div>
              <p className="mt-0.5 truncate text-xs">
                <Muted>{feed.url}</Muted>
              </p>
              <p className="mt-1 text-xs">
                <Muted>
                  {feed.lastFetchedAt
                    ? `Last checked ${new Date(feed.lastFetchedAt).toLocaleString()}`
                    : 'Not checked yet — the next sweep will pick it up.'}
                </Muted>
              </p>
            </div>

            {canManage && (
              <div className="flex shrink-0 gap-1.5">
                <SmallButton busy={busy} onClick={() => void setPaused(feed, !feed.pausedAt)}>
                  {feed.pausedAt ? 'Resume' : 'Pause'}
                </SmallButton>
                <SmallButton busy={busy} onClick={() => void remove(feed)}>
                  Remove
                </SmallButton>
              </div>
            )}
          </div>

          {feed.items.length > 0 && (
            <div className="mt-3 border-t pt-2 border-border">
              <p className="text-xs font-medium">
                <Muted>Recent items</Muted>
              </p>
              {feed.items.map((item) => (
                <div
                  key={item.id}
                  className="flex items-center justify-between gap-3 py-0.5 text-xs"
                >
                  <span className="truncate">
                    <Muted>{item.title}</Muted>
                  </span>
                  {/* Links to the draft it created, because "what did this feed
                      actually do" is the only question anyone asks here. */}
                  {item.postId ? (
                    <Link
                      href={`/w/${workspaceId}/posts`}
                      className="shrink-0 underline text-primary"
                    >
                      draft created
                    </Link>
                  ) : (
                    <span className="shrink-0">
                      <Muted>recorded, no target</Muted>
                    </span>
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
            <Field
              id="feed-name"
              label="Name"
              value={form.name}
              onChange={(v) => setForm((f) => ({ ...f, name: v }))}
              placeholder="Company blog"
            />
            <Field
              id="feed-url"
              label="Feed URL"
              value={form.url}
              onChange={(v) => setForm((f) => ({ ...f, url: v }))}
              placeholder="https://example.com/feed.xml"
            />
            <Field
              id="feed-template"
              label="Template"
              value={form.template}
              onChange={(v) => setForm((f) => ({ ...f, template: v }))}
              hint="{{title}} and {{link}} are replaced with the item's values."
            />

            <fieldset>
              <legend className="text-xs font-medium">Publish to</legend>
              {accounts.length === 0 ? (
                <p className="mt-1 text-xs">
                  <Muted>
                    No connected accounts. Items will still be recorded, but there is nowhere to
                    draft them to yet.
                  </Muted>
                </p>
              ) : (
                <div className="mt-1 space-y-1">
                  {accounts.map((a) => (
                    <label key={a.id} className="flex items-center gap-2 text-xs">
                      <input
                        type="checkbox"
                        checked={form.targetAccountIds.includes(a.id)}
                        onChange={(e) =>
                          setForm((f) => ({
                            ...f,
                            targetAccountIds: e.target.checked
                              ? [...f.targetAccountIds, a.id]
                              : f.targetAccountIds.filter((x) => x !== a.id),
                          }))
                        }
                      />
                      {a.handle}
                    </label>
                  ))}
                </div>
              )}
            </fieldset>

            <label className="flex items-start gap-2 text-xs">
              <input
                type="checkbox"
                checked={form.autoPublish}
                onChange={(e) => setForm((f) => ({ ...f, autoPublish: e.target.checked }))}
                className="mt-0.5"
              />
              <span>
                Publish new items automatically
                <br />
                <Muted>
                  Off by default. Auto-publishing from a feed you do not control is how someone
                  else&apos;s headline ends up on your brand account.
                </Muted>
              </span>
            </label>

            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => void create()}
                disabled={busy || !form.name.trim() || !form.url.trim()}
                className="rounded px-3 py-1.5 text-sm font-medium transition-opacity disabled:opacity-40 bg-primary text-primary-foreground"
              >
                {busy ? 'Adding...' : 'Add feed'}
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
            Add feed
          </button>
        ))}
    </div>
  )
}

function Field({
  id,
  label,
  value,
  onChange,
  placeholder,
  hint,
}: {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  hint?: string
}) {
  return (
    <div>
      <label className="block text-xs font-medium" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder ?? ''}
        className="mt-0.5 w-full rounded border bg-transparent px-2 py-1 text-sm border-border"
      />
      {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
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
