'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Check, Copy, Eye, EyeOff } from 'lucide-react'
import { Badge, Card, Muted } from '@/components/ui'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

export type ConnectorSetting = {
  key: string
  provider: string
  label: string
  secret: boolean
  help?: string
  source: 'ui' | 'environment' | 'unset'
  hint: string | null
  updatedAt: string | null
  updatedBy: string | null
}

export type ConnectorProvider = {
  id: string
  label: string
  configured: boolean
  state: string
}

/**
 * Connector credentials, one card per provider.
 *
 * The screen is built around the two things people actually get wrong.
 *
 * The first is the redirect URI. Every provider console demands an exact match
 * and rejects a mismatch with an error that does not say which side is wrong,
 * so it is shown ready to copy rather than described in documentation nobody
 * has open.
 *
 * The second is not knowing where a value is already coming from. A field that
 * looks empty but is being satisfied by an environment variable invites someone
 * to type a value in, override it without realising, and then have no way to
 * explain why clearing the field did not restore the old behaviour. So the
 * source is on the badge, always.
 */
export function Connectors({
  organizationId,
  redirectUriBase,
  settings,
  providers,
  editable,
  readOnlyReason,
}: {
  organizationId: string
  redirectUriBase: string
  settings: ConnectorSetting[]
  providers: ConnectorProvider[]
  editable: boolean
  readOnlyReason?: string
}) {
  const byProvider = providers.map((provider) => ({
    provider,
    fields: settings.filter((setting) => setting.provider === provider.id),
  }))

  return (
    <div className="space-y-4">
      {!editable && readOnlyReason && (
        <Card className="border-warning/40 bg-warning/5 p-3 text-sm">{readOnlyReason}</Card>
      )}

      {byProvider.map(({ provider, fields }) => (
        <Card key={provider.id} className="p-4">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-medium">{provider.label}</h3>
            {provider.configured ? (
              <Badge tone="success">Ready to connect</Badge>
            ) : (
              <Badge tone="warn">Needs credentials</Badge>
            )}
          </div>

          <RedirectUri value={`${redirectUriBase}/${provider.id}`} />

          <div className="mt-4 space-y-4">
            {fields.map((field) => (
              <Field
                key={field.key}
                field={field}
                organizationId={organizationId}
                editable={editable}
              />
            ))}
          </div>
        </Card>
      ))}
    </div>
  )
}

/**
 * The redirect URI, copyable.
 *
 * Read-only and shown in full rather than truncated: a URI that is elided in
 * the middle cannot be checked by eye against what is pasted in the provider's
 * console, which is the entire task this is here to support.
 */
function RedirectUri({ value }: { value: string }) {
  const [copied, setCopied] = useState(false)

  return (
    <div className="mt-3">
      <div className="text-xs">
        <Muted>Redirect URI — paste this into the provider&apos;s app settings</Muted>
      </div>
      <div className="mt-1 flex items-center gap-2">
        <code className="min-w-0 flex-1 overflow-x-auto rounded border border-input bg-muted/40 px-2 py-1.5 text-xs">
          {value}
        </code>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            void navigator.clipboard.writeText(value).then(() => {
              setCopied(true)
              setTimeout(() => setCopied(false), 1500)
            })
          }}
        >
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
    </div>
  )
}

function Field({
  field,
  organizationId,
  editable,
}: {
  field: ConnectorSetting
  organizationId: string
  editable: boolean
}) {
  const router = useRouter()
  const [value, setValue] = useState('')
  const [reveal, setReveal] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function send(method: 'PUT' | 'DELETE') {
    setBusy(true)
    setError(null)

    const response = await fetch(
      `/api/v1/connector-settings/${field.key}?organizationId=${organizationId}`,
      {
        method,
        headers: { 'content-type': 'application/json', 'x-smm-client': 'web' },
        ...(method === 'PUT' ? { body: JSON.stringify({ value }) } : {}),
      }
    )

    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { message?: string } | null
      setError(body?.message ?? 'That did not save. Try again.')
      setBusy(false)
      return
    }

    setValue('')
    setBusy(false)
    // Re-read from the server rather than patching local state: `configured`
    // and `source` are both computed server-side, and guessing at them here is
    // how a screen starts disagreeing with what the API will actually do.
    router.refresh()
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={field.key} className="text-sm font-medium">
          {field.label}
        </label>
        <SourceBadge source={field.source} />
        <code className="text-[11px] text-muted-foreground">{field.key}</code>
      </div>

      {field.help && (
        <p className="mt-1 text-xs">
          <Muted>{field.help}</Muted>
        </p>
      )}

      {field.hint && (
        <p className="mt-1 text-xs">
          <Muted>
            Currently <code className="font-mono">{field.hint}</code>
            {field.updatedBy ? ` — set by ${field.updatedBy}` : ''}
            {field.updatedAt ? ` on ${new Date(field.updatedAt).toLocaleDateString()}` : ''}
          </Muted>
        </p>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Input
          id={field.key}
          // Secrets are password fields by default but can be revealed, because
          // the most common failure is a mistyped or partially-pasted value and
          // a field you cannot read makes that impossible to spot.
          type={field.secret && !reveal ? 'password' : 'text'}
          className="max-w-md flex-1"
          autoComplete="off"
          spellCheck={false}
          disabled={!editable || busy}
          placeholder={
            field.source === 'unset' ? 'Not set' : `Replace the ${sourceWord(field.source)} value`
          }
          value={value}
          onChange={(event) => setValue(event.target.value)}
          {...(error ? { 'aria-invalid': true } : {})}
        />

        {field.secret && (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={reveal ? 'Hide value' : 'Show value'}
            onClick={() => setReveal((previous) => !previous)}
          >
            {reveal ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
          </Button>
        )}

        <Button
          type="button"
          size="sm"
          disabled={!editable || busy || value.trim().length === 0}
          loading={busy}
          onClick={() => void send('PUT')}
        >
          Save
        </Button>

        {field.source === 'ui' && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={!editable || busy}
            onClick={() => void send('DELETE')}
          >
            Clear
          </Button>
        )}
      </div>

      {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
    </div>
  )
}

function SourceBadge({ source }: { source: ConnectorSetting['source'] }) {
  if (source === 'ui') return <Badge tone="success">Set here</Badge>
  // Not an error and not a warning. An environment variable is a perfectly good
  // — arguably better — way to supply a secret, and a deployment doing it that
  // way should not be nagged. It only needs to be visible.
  if (source === 'environment') return <Badge tone="neutral">From environment</Badge>
  return <Badge tone="warn">Not set</Badge>
}

function sourceWord(source: ConnectorSetting['source']): string {
  return source === 'environment' ? 'environment' : 'saved'
}
