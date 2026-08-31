'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Trash2, Archive, ArchiveRestore } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Card } from '@/components/ui'

/**
 * The four forms and their previews.
 *
 * All of them post through the same origin-proxied `/api/v1`, so there is no
 * token to attach and no CORS to configure — the session cookie rides along
 * because the browser thinks it is talking to one server, which it is.
 */

type ApiError = { error?: { message?: string } }

async function send(
  path: string,
  method: 'POST' | 'PATCH' | 'DELETE',
  body?: unknown
): Promise<{ ok: true; data: unknown } | { ok: false; message: string }> {
  const response = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json', 'x-smm-client': 'web' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })

  if (!response.ok) {
    const parsed = (await response.json().catch(() => null)) as ApiError | null
    return { ok: false, message: parsed?.error?.message ?? 'That did not work.' }
  }
  return { ok: true, data: await response.json().catch(() => null) }
}

function FormError({ message }: { message: string | null }) {
  if (!message) return null
  return (
    <p className="mt-2 text-sm text-destructive" role="alert">
      {message}
    </p>
  )
}

// ---------------------------------------------------------------------------

export function CampaignForm({ workspaceId }: { workspaceId: string }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  return (
    <Card className="mb-4 p-4">
      <form
        className="grid gap-3 sm:grid-cols-[1fr_auto_auto_auto]"
        action={async (form: FormData) => {
          setBusy(true)
          setError(null)

          const starts = String(form.get('startsAt') ?? '')
          const ends = String(form.get('endsAt') ?? '')

          const result = await send('/api/v1/campaigns', 'POST', {
            workspaceId,
            name: String(form.get('name') ?? ''),
            color: String(form.get('color') ?? '#6366f1'),
            ...(starts ? { startsAt: starts } : {}),
            ...(ends ? { endsAt: ends } : {}),
          })

          setBusy(false)
          if (!result.ok) return setError(result.message)
          router.refresh()
        }}
      >
        <div>
          <Label htmlFor="campaign-name">Campaign name</Label>
          <Input id="campaign-name" name="name" required maxLength={120} placeholder="Autumn launch" />
        </div>
        <div>
          <Label htmlFor="campaign-starts">Starts</Label>
          <Input id="campaign-starts" name="startsAt" type="date" />
        </div>
        <div>
          <Label htmlFor="campaign-ends">Ends</Label>
          <Input id="campaign-ends" name="endsAt" type="date" />
        </div>
        <div>
          <Label htmlFor="campaign-color">Colour</Label>
          <Input
            id="campaign-color"
            name="color"
            type="color"
            defaultValue="#6366f1"
            className="h-9 w-16 p-1"
          />
        </div>
        <div className="sm:col-span-4">
          <Button type="submit" disabled={busy} size="sm">
            {busy ? 'Creating…' : 'Create campaign'}
          </Button>
          <FormError message={error} />
        </div>
      </form>
    </Card>
  )
}

export function ArchiveCampaign({
  workspaceId,
  id,
  archived,
}: {
  workspaceId: string
  id: string
  archived: boolean
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)

  return (
    <Button
      variant="ghost"
      size="icon-sm"
      disabled={busy}
      title={archived ? 'Restore' : 'Archive'}
      aria-label={archived ? 'Restore campaign' : 'Archive campaign'}
      onClick={async () => {
        setBusy(true)
        await send(`/api/v1/campaigns/${id}`, 'PATCH', { workspaceId, archived: !archived })
        setBusy(false)
        router.refresh()
      }}
    >
      {archived ? <ArchiveRestore className="size-4" /> : <Archive className="size-4" />}
    </Button>
  )
}

/**
 * Deletion, with the consequence stated before the click.
 *
 * Two presses rather than a `confirm()` dialog: a browser modal blocks the
 * whole tab and cannot say anything specific. The second press is also
 * destructive-red, so the state is visible rather than merely armed.
 */
export function DeleteThing({
  workspaceId,
  resource,
  id,
  confirm,
}: {
  workspaceId: string
  resource: string
  id: string
  confirm: string
}) {
  const router = useRouter()
  const [armed, setArmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (armed) {
    return (
      <span className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">{confirm}</span>
        <Button
          variant="destructive"
          size="sm"
          disabled={busy}
          onClick={async () => {
            setBusy(true)
            const result = await send(
              `/api/v1/${resource}/${id}?workspaceId=${workspaceId}`,
              'DELETE'
            )
            setBusy(false)
            if (!result.ok) {
              setError(result.message)
              return
            }
            router.refresh()
          }}
        >
          {busy ? 'Deleting…' : 'Delete'}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setArmed(false)}>
          Cancel
        </Button>
        <FormError message={error} />
      </span>
    )
  }

  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label="Delete"
      title="Delete"
      onClick={() => setArmed(true)}
    >
      <Trash2 className="size-4" />
    </Button>
  )
}

// ---------------------------------------------------------------------------

export function LabelForm({ workspaceId }: { workspaceId: string }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  return (
    <Card className="mb-4 p-4">
      <form
        className="flex flex-wrap items-end gap-3"
        action={async (form: FormData) => {
          setBusy(true)
          setError(null)
          const result = await send('/api/v1/labels', 'POST', {
            workspaceId,
            name: String(form.get('name') ?? ''),
            color: String(form.get('color') ?? '#64748b'),
          })
          setBusy(false)
          if (!result.ok) return setError(result.message)
          router.refresh()
        }}
      >
        <div>
          <Label htmlFor="label-name">Label name</Label>
          <Input id="label-name" name="name" required maxLength={60} placeholder="Product news" />
        </div>
        <div>
          <Label htmlFor="label-color">Colour</Label>
          <Input
            id="label-color"
            name="color"
            type="color"
            defaultValue="#64748b"
            className="h-9 w-16 p-1"
          />
        </div>
        <Button type="submit" disabled={busy} size="sm">
          {busy ? 'Adding…' : 'Add label'}
        </Button>
        <FormError message={error} />
      </form>
    </Card>
  )
}

// ---------------------------------------------------------------------------

export function TemplateForm({ workspaceId }: { workspaceId: string }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [body, setBody] = useState('')

  // Extracted in the browser as you type. The same function the API runs on
  // write, from the same package — so what this shows is what will be stored,
  // not a second implementation that agrees most of the time.
  const found = [...body.matchAll(/\{\{\s*([a-zA-Z0-9_-]+)\s*\}\}/g)].map((m) => m[1]!)
  const variables = [...new Set(found)]

  return (
    <Card className="mb-4 p-4">
      <form
        className="space-y-3"
        action={async (form: FormData) => {
          setBusy(true)
          setError(null)
          const result = await send('/api/v1/templates', 'POST', {
            workspaceId,
            name: String(form.get('name') ?? ''),
            description: String(form.get('description') ?? '') || undefined,
            body,
          })
          setBusy(false)
          if (!result.ok) return setError(result.message)
          setBody('')
          router.refresh()
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="template-name">Template name</Label>
            <Input id="template-name" name="name" required maxLength={120} />
          </div>
          <div>
            <Label htmlFor="template-description">Description</Label>
            <Input id="template-description" name="description" maxLength={500} />
          </div>
        </div>

        <div>
          <Label htmlFor="template-body">Body</Label>
          <Textarea
            id="template-body"
            required
            rows={4}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="New on the blog: {{title}} — {{url}}"
          />
          <p className="mt-1 text-xs text-muted-foreground">
            Anything in {'{{double braces}}'} becomes a field to fill in when you use this.
          </p>
        </div>

        {variables.length > 0 && (
          <p className="text-xs text-muted-foreground">
            Will ask for: <span className="font-mono">{variables.join(', ')}</span>
          </p>
        )}

        <Button type="submit" disabled={busy || body.length === 0} size="sm">
          {busy ? 'Saving…' : 'Save template'}
        </Button>
        <FormError message={error} />
      </form>
    </Card>
  )
}

/**
 * Fills a template's variables and shows the result.
 *
 * Rendering happens on the SERVER even though the substitution is trivial and
 * the package is browser-importable, because `commit` also increments the usage
 * counter and that is not a number a client should be trusted to set.
 */
export function TemplatePreview({
  workspaceId,
  id,
  variables,
}: {
  workspaceId: string
  id: string
  variables: string[]
}) {
  const [values, setValues] = useState<Record<string, string>>({})
  const [result, setResult] = useState<{ text: string; missing: string[] } | null>(null)
  const [busy, setBusy] = useState(false)

  if (variables.length === 0) return null

  return (
    <div className="mt-3 border-t pt-3">
      <div className="flex flex-wrap gap-2">
        {variables.map((name) => (
          <div key={name}>
            <Label htmlFor={`${id}-${name}`}>{name}</Label>
            <Input
              id={`${id}-${name}`}
              value={values[name] ?? ''}
              onChange={(e) => setValues((v) => ({ ...v, [name]: e.target.value }))}
              className="h-8 text-xs"
            />
          </div>
        ))}
        <div className="flex items-end">
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              const response = await send(`/api/v1/templates/${id}/render`, 'POST', {
                workspaceId,
                values,
                commit: true,
              })
              setBusy(false)
              if (response.ok) {
                setResult(response.data as { text: string; missing: string[] })
              }
            }}
          >
            {busy ? 'Rendering…' : 'Preview'}
          </Button>
        </div>
      </div>

      {result && (
        <div className="mt-3">
          {result.missing.length > 0 && (
            // Stated, not silently blanked. A template published with holes in
            // it is the mail-merge failure everybody has seen.
            <p className="mb-1 text-xs text-warning">
              Still needs {result.missing.join(', ')} — the placeholders are left in below.
            </p>
          )}
          <pre data-testid="render-output" className="overflow-x-auto whitespace-pre-wrap rounded-md border bg-background px-3 py-2 text-xs">
            {result.text}
          </pre>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------

export function PresetForm({ workspaceId }: { workspaceId: string }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  return (
    <Card className="mb-4 p-4">
      <form
        className="space-y-3"
        action={async (form: FormData) => {
          setBusy(true)
          setError(null)
          const result = await send('/api/v1/utm-presets', 'POST', {
            workspaceId,
            name: String(form.get('name') ?? ''),
            source: String(form.get('source') ?? ''),
            medium: String(form.get('medium') ?? ''),
            campaign: String(form.get('campaign') ?? '') || undefined,
            isDefault: form.get('isDefault') === 'on',
          })
          setBusy(false)
          if (!result.ok) return setError(result.message)
          router.refresh()
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <Label htmlFor="preset-name">Preset name</Label>
            <Input id="preset-name" name="name" required maxLength={120} placeholder="Default" />
          </div>
          <div>
            <Label htmlFor="preset-source">utm_source</Label>
            <Input
              id="preset-source"
              name="source"
              required
              maxLength={120}
              defaultValue="{{network}}"
            />
          </div>
          <div>
            <Label htmlFor="preset-medium">utm_medium</Label>
            <Input id="preset-medium" name="medium" required maxLength={120} defaultValue="social" />
          </div>
          <div>
            <Label htmlFor="preset-campaign">utm_campaign</Label>
            <Input id="preset-campaign" name="campaign" maxLength={120} placeholder="optional" />
          </div>
        </div>

        <p className="text-xs text-muted-foreground">
          Values can contain {'{{variables}}'}. {'{{network}}'} is filled per channel, which is the
          point of utm_source — one fixed value produces a report saying traffic came from
          &ldquo;social&rdquo;.
        </p>

        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="isDefault" className="size-4" />
          Use this by default for new posts
        </label>

        <Button type="submit" disabled={busy} size="sm">
          {busy ? 'Saving…' : 'Save preset'}
        </Button>
        <FormError message={error} />
      </form>
    </Card>
  )
}

/** Applies a preset to a scrap of text so you can see the URLs it produces. */
export function PresetPreview({
  workspaceId,
  id,
  variables,
}: {
  workspaceId: string
  id: string
  variables: string[]
}) {
  const [text, setText] = useState('Read the announcement: https://example.com/blog/launch')
  const [context, setContext] = useState<Record<string, string>>({})
  const [result, setResult] = useState<{
    text: string
    tagged: number
    skipped: Array<{ url: string; reason: string }>
    missing: string[]
  } | null>(null)
  const [busy, setBusy] = useState(false)

  return (
    <div className="mt-3 border-t pt-3">
      <Label htmlFor={`${id}-text`}>Try it</Label>
      <Textarea
        id={`${id}-text`}
        rows={2}
        value={text}
        onChange={(e) => setText(e.target.value)}
        className="text-xs"
      />

      <div className="mt-2 flex flex-wrap items-end gap-2">
        {variables.map((name) => (
          <div key={name}>
            <Label htmlFor={`${id}-ctx-${name}`}>{name}</Label>
            <Input
              id={`${id}-ctx-${name}`}
              value={context[name] ?? ''}
              onChange={(e) => setContext((c) => ({ ...c, [name]: e.target.value }))}
              className="h-8 text-xs"
              placeholder={name === 'network' ? 'bluesky' : ''}
            />
          </div>
        ))}
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={async () => {
            setBusy(true)
            const response = await send(`/api/v1/utm-presets/${id}/apply`, 'POST', {
              workspaceId,
              text,
              context,
            })
            setBusy(false)
            if (response.ok) setResult(response.data as typeof result)
          }}
        >
          {busy ? 'Applying…' : 'Apply'}
        </Button>
      </div>

      {result && (
        <div className="mt-3 space-y-1.5">
          {result.missing.length > 0 && (
            <p className="text-xs text-warning">
              No value for {result.missing.join(', ')} — those parameters were left off rather than
              written as template text into somebody&rsquo;s analytics.
            </p>
          )}
          <pre data-testid="utm-output" className="overflow-x-auto whitespace-pre-wrap break-all rounded-md border bg-background px-3 py-2 text-xs">
            {result.text}
          </pre>
          <p className="text-xs text-muted-foreground">
            {result.tagged} link{result.tagged === 1 ? '' : 's'} tagged
            {result.skipped.length > 0 && `, ${result.skipped.length} left alone`}
          </p>
          {result.skipped.map((s) => (
            <p key={s.url} className="text-xs text-muted-foreground">
              <span className="font-mono">{s.url}</span> — {s.reason}
            </p>
          ))}
        </div>
      )}
    </div>
  )
}
