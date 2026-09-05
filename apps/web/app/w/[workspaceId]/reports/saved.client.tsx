'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Bookmark, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/cn'

export type SavedReport = {
  id: string
  name: string
  windowDays: number
  accountIds: string[]
  createdBy: { name: string } | null
}

/**
 * Saved report configurations.
 *
 * These store the QUESTION, not the answer — the window and the filters, re-run
 * against current data every time. "The monthly client report" is then a thing
 * you have rather than a thing you rebuild from memory on the last Friday of
 * the month, and rebuilding it slightly differently each time is exactly how two
 * months of a report stop being comparable.
 */
export function SavedReports({
  workspaceId,
  saved,
  currentDays,
}: {
  workspaceId: string
  saved: SavedReport[]
  currentDays: number
}) {
  const router = useRouter()
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function save() {
    setBusy(true)
    setError(null)

    const response = await fetch('/api/v1/reports/saved', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-smm-client': 'web' },
      body: JSON.stringify({ workspaceId, name: name.trim(), windowDays: currentDays }),
    })
    setBusy(false)

    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as {
        error?: { message?: string }
      } | null
      setError(body?.error?.message ?? 'That could not be saved.')
      return
    }
    setNaming(false)
    setName('')
    router.refresh()
  }

  async function remove(id: string) {
    setBusy(true)
    await fetch(`/api/v1/reports/saved/${id}?workspaceId=${workspaceId}`, {
      method: 'DELETE',
      headers: { 'x-smm-client': 'web' },
    })
    setBusy(false)
    router.refresh()
  }

  return (
    <div className="mt-3">
      <div className="flex flex-wrap items-center gap-1.5">
        {saved.map((report) => (
          <span
            key={report.id}
            className={cn(
              'group inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs',
              report.windowDays === currentDays
                ? 'border-primary/40 bg-primary/10 text-primary'
                : 'border-input text-muted-foreground'
            )}
          >
            <Link
              href={`/w/${workspaceId}/reports?days=${report.windowDays}`}
              title={
                report.createdBy?.name
                  ? `${report.windowDays} days · saved by ${report.createdBy.name}`
                  : `${report.windowDays} days`
              }
            >
              {report.name}
            </Link>
            <button
              type="button"
              aria-label={`Delete ${report.name}`}
              disabled={busy}
              onClick={() => void remove(report.id)}
              className="opacity-0 transition-opacity hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100"
            >
              <X className="size-3" />
            </button>
          </span>
        ))}

        {naming ? (
          <span className="inline-flex items-center gap-1">
            <Input
              value={name}
              autoFocus
              maxLength={120}
              placeholder="Monthly client report"
              className="h-7 w-56 text-xs"
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && name.trim()) void save()
                if (event.key === 'Escape') setNaming(false)
              }}
            />
            <Button
              size="sm"
              className="h-7 px-2"
              disabled={name.trim().length === 0 || busy}
              loading={busy}
              onClick={() => void save()}
            >
              Save
            </Button>
          </span>
        ) : (
          <button
            type="button"
            onClick={() => setNaming(true)}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
          >
            <Bookmark className="size-3" />
            {/* Says what will be saved. "Save report" alone leaves someone
                guessing whether it captures the window they are looking at. */}
            Save this {currentDays}-day view
          </button>
        )}
      </div>

      {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
    </div>
  )
}
