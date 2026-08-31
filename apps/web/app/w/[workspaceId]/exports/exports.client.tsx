'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card } from '@/components/ui'

/**
 * Requesting an export.
 *
 * Two kinds behind one control, because they are the same act with a different
 * scope and splitting them into two pages would hide the subject export from
 * the person most likely to need it in a hurry.
 *
 * The form does not poll. An export takes as long as the worker's tick, and a
 * spinner that lies about progress is worse than a page you refresh — so the
 * button explains what happens next instead.
 */
export function RequestExport({ workspaceId, busy }: { workspaceId: string; busy: boolean }) {
  const router = useRouter()
  const [kind, setKind] = useState<'WORKSPACE' | 'SUBJECT'>('WORKSPACE')
  const [handle, setHandle] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  return (
    <Card className="p-4">
      <form
        className="space-y-3"
        onSubmit={async (event) => {
          event.preventDefault()
          setSubmitting(true)
          setError(null)

          const response = await fetch('/api/v1/exports', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-smm-client': 'web' },
            body: JSON.stringify({
              workspaceId,
              kind,
              ...(kind === 'SUBJECT' ? { subjectHandle: handle } : {}),
            }),
          })

          setSubmitting(false)

          if (!response.ok) {
            const body = (await response.json().catch(() => null)) as {
              error?: { message?: string }
            } | null
            setError(body?.error?.message ?? 'Could not request the export.')
            return
          }

          setHandle('')
          router.refresh()
        }}
      >
        <fieldset>
          <legend className="text-sm font-medium">What to export</legend>
          <div className="mt-2 space-y-2">
            <label className="flex items-start gap-2.5 text-sm">
              <input
                type="radio"
                name="kind"
                className="mt-0.5 size-4"
                checked={kind === 'WORKSPACE'}
                onChange={() => setKind('WORKSPACE')}
              />
              <span>
                <span className="font-medium">This whole workspace</span>
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  Posts, per-channel variants, a media manifest and metrics. Media files are listed
                  rather than bundled — they are already in your storage, and shipping every video
                  would turn portability into a way to fill a disk.
                </span>
              </span>
            </label>

            <label className="flex items-start gap-2.5 text-sm">
              <input
                type="radio"
                name="kind"
                className="mt-0.5 size-4"
                checked={kind === 'SUBJECT'}
                onChange={() => setKind('SUBJECT')}
              />
              <span>
                <span className="font-medium">Everything about one person</span>
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  Every conversation and message involving one handle, in this workspace only. Other
                  workspaces hold their own records and answer separately.
                </span>
              </span>
            </label>
          </div>
        </fieldset>

        {kind === 'SUBJECT' && (
          <div className="max-w-xs">
            <Label htmlFor="subject-handle">Handle</Label>
            <Input
              id="subject-handle"
              value={handle}
              onChange={(e) => setHandle(e.target.value)}
              placeholder="@someone"
              required
            />
            <p className="mt-1 text-xs text-muted-foreground">
              Matched exactly, ignoring case. A handle is not searched as a prefix — including a
              similarly-named third party in someone&rsquo;s subject request would turn one lawful
              answer into a second disclosure.
            </p>
          </div>
        )}

        <div>
          <Button type="submit" size="sm" disabled={submitting || busy}>
            {submitting ? 'Requesting…' : 'Request export'}
          </Button>
          {busy && (
            // Explained rather than left as a disabled control with no reason,
            // which is the exact dead button the honesty policy rules out.
            <p className="mt-2 text-xs text-muted-foreground">
              An export is already being prepared for this workspace. It will appear below when it
              is ready; refresh to check.
            </p>
          )}
          {error && (
            <p className="mt-2 text-sm text-destructive" role="alert">
              {error}
            </p>
          )}
        </div>
      </form>
    </Card>
  )
}
