'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

export function CreatePage({ workspaceId }: { workspaceId: string }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  return (
    <>
      <form
        className="flex flex-wrap items-end gap-2"
        action={async (formData: FormData) => {
          setBusy(true)
          setError(null)

          const response = await fetch('/api/v1/link-pages', {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-smm-client': 'web',
            },
            body: JSON.stringify({
              workspaceId,
              slug: String(formData.get('slug') ?? '').toLowerCase(),
              title: String(formData.get('title') ?? ''),
              bio: String(formData.get('bio') ?? '') || undefined,
            }),
          })

          if (!response.ok) {
            const body = (await response.json().catch(() => null)) as {
              error?: { message?: string }
            } | null
            setError(body?.error?.message ?? 'Could not create the page.')
            setBusy(false)
            return
          }

          setBusy(false)
          router.refresh()
        }}
      >
        <label>
          <span className="text-xs font-medium">Title</span>
          <input
            name="title"
            required
            placeholder="Northwind"
            className="mt-1 block rounded border bg-transparent px-3 py-2 text-sm outline-none border-border"
          />
        </label>
        <label>
          <span className="text-xs font-medium">Link</span>
          <div className="mt-1 flex items-center">
            <span className="text-sm text-muted-foreground">/l/</span>
            <input
              name="slug"
              required
              pattern="[a-z0-9][a-z0-9-]{1,38}[a-z0-9]"
              placeholder="northwind"
              className="ml-1 rounded border bg-transparent px-3 py-2 text-sm outline-none border-border"
            />
          </div>
        </label>
        <label className="flex-1">
          <span className="text-xs font-medium">Bio</span>
          <input
            name="bio"
            placeholder="Optional"
            className="mt-1 w-full rounded border bg-transparent px-3 py-2 text-sm outline-none border-border"
          />
        </label>
        <button
          type="submit"
          disabled={busy}
          className="rounded px-3 py-2 text-sm font-medium disabled:opacity-50 bg-primary text-primary-foreground"
        >
          {busy ? 'Creating…' : 'Create page'}
        </button>
      </form>

      {error && (
        <p className="mt-2 text-sm" role="alert">
          {error}
        </p>
      )}
    </>
  )
}

export function PublishToggle({
  workspaceId,
  pageId,
  published,
  slug,
}: {
  workspaceId: string
  pageId: string
  published: boolean
  slug: string
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)

  return (
    <div className="shrink-0 text-right">
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true)
          await fetch(`/api/v1/link-pages/${pageId}`, {
            method: 'PATCH',
            headers: {
              'content-type': 'application/json',
              'x-smm-client': 'web',
            },
            body: JSON.stringify({ workspaceId, published: !published }),
          })
          setBusy(false)
          router.refresh()
        }}
        className="rounded border px-2 py-1 text-xs disabled:opacity-50 border-border"
      >
        {busy ? '…' : published ? 'Unpublish' : 'Publish'}
      </button>
      {published && (
        <a
          href={`/l/${slug}`}
          target="_blank"
          rel="noreferrer"
          className="mt-1 block text-xs underline text-primary"
        >
          View
        </a>
      )}
    </div>
  )
}

export function AddLink({ workspaceId, pageId }: { workspaceId: string; pageId: string }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-xs underline text-muted-foreground"
      >
        Add a link
      </button>
    )
  }

  return (
    <form
      className="flex flex-wrap items-end gap-2"
      action={async (formData: FormData) => {
        setBusy(true)
        await fetch(`/api/v1/link-pages/${pageId}/links`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-smm-client': 'web',
          },
          body: JSON.stringify({
            workspaceId,
            label: String(formData.get('label') ?? ''),
            url: String(formData.get('url') ?? ''),
          }),
        })
        setBusy(false)
        setOpen(false)
        router.refresh()
      }}
    >
      <input
        name="label"
        required
        placeholder="Label"
        className="rounded border bg-transparent px-2 py-1 text-xs outline-none border-border"
      />
      <input
        name="url"
        type="url"
        required
        placeholder="https://…"
        className="flex-1 rounded border bg-transparent px-2 py-1 text-xs outline-none border-border"
      />
      <button type="submit" disabled={busy} className="text-xs underline">
        {busy ? 'Adding…' : 'Add'}
      </button>
      <button
        type="button"
        onClick={() => setOpen(false)}
        className="text-xs underline text-muted-foreground"
      >
        Cancel
      </button>
    </form>
  )
}

export function RemoveLink({ workspaceId, linkId }: { workspaceId: string; linkId: string }) {
  const router = useRouter()
  return (
    <button
      type="button"
      onClick={async () => {
        await fetch(`/api/v1/links/${linkId}?workspaceId=${workspaceId}`, {
          method: 'DELETE',
          headers: { 'x-smm-client': 'web' },
        })
        router.refresh()
      }}
      className="underline text-muted-foreground"
    >
      Remove
    </button>
  )
}
