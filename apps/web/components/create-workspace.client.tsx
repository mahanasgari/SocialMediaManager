'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

/**
 * Creating a workspace.
 *
 * `POST /workspaces` has existed since Phase 1 and had no control anywhere in
 * the product — the only way to make a second workspace was curl. That is the
 * exact shape of thing this project treats as a bug rather than a gap: a
 * working endpoint nobody can reach is indistinguishable, from the outside,
 * from an endpoint that does not work.
 *
 * The timezone is asked for at creation rather than defaulted silently, because
 * it is what every scheduled post in the workspace will be interpreted against
 * and changing it later re-interprets a calendar somebody already built.
 */
export function CreateWorkspaceDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Guessed from the browser, not hard-coded to UTC. It is right nearly always,
  // and it is a prefilled field rather than a hidden default — the person can
  // see what it chose and change it.
  const [timezone, setTimezone] = useState(() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
    } catch {
      return 'UTC'
    }
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form
          action={async (formData: FormData) => {
            setBusy(true)
            setError(null)

            const response = await fetch('/api/v1/workspaces', {
              method: 'POST',
              headers: { 'content-type': 'application/json', 'x-smm-client': 'web' },
              body: JSON.stringify({
                name: String(formData.get('name') ?? '').trim(),
                timezone,
              }),
            })

            if (!response.ok) {
              const body = (await response.json().catch(() => null)) as {
                message?: string
              } | null
              setError(body?.message ?? 'That workspace could not be created.')
              setBusy(false)
              return
            }

            const created = (await response.json()) as { id: string }
            setBusy(false)
            onOpenChange(false)
            // Straight into the new workspace. Creating one and being left
            // where you were is a dead end that reads as a failure.
            router.push(`/w/${created.id}/accounts`)
            router.refresh()
          }}
        >
          <DialogHeader>
            <DialogTitle>New workspace</DialogTitle>
            <DialogDescription>
              A separate calendar, accounts and team. Nothing is shared with your other workspaces.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3 py-4">
            <div>
              <label htmlFor="workspace-name" className="text-sm font-medium">
                Name
              </label>
              <Input
                id="workspace-name"
                name="name"
                required
                maxLength={120}
                autoComplete="off"
                placeholder="Northwind Coffee"
                className="mt-1"
                {...(error ? { 'aria-invalid': true } : {})}
              />
            </div>

            <div>
              <label htmlFor="workspace-timezone" className="text-sm font-medium">
                Timezone
              </label>
              <Input
                id="workspace-timezone"
                value={timezone}
                onChange={(event) => setTimezone(event.target.value)}
                className="mt-1 font-mono text-xs"
                spellCheck={false}
              />
              <p className="mt-1 text-xs text-muted-foreground">
                What times on the calendar mean. Scheduled posts are stored as exact instants, so
                changing this later relabels the calendar rather than moving anything.
              </p>
            </div>

            {error && <p className="text-xs text-destructive">{error}</p>}
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={busy} disabled={busy}>
              Create
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
