'use client'

import { useState } from 'react'
import Link from 'next/link'

const RANGES = [
  { days: 7, label: '7 days' },
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
  { days: 365, label: '12 months' },
] as const

export function RangePicker({ workspaceId, days }: { workspaceId: string; days: number }) {
  return (
    <div className="flex flex-wrap gap-2">
      {RANGES.map((r) => (
        <Link
          key={r.days}
          href={`/w/${workspaceId}/reports?days=${r.days}`}
          className="rounded px-2.5 py-1 text-xs transition-colors"
          style={
            days === r.days
              ? {
                  background: 'hsl(var(--primary) / 0.12)',
                  color: 'hsl(var(--primary))',
                }
              : {
                  color: 'hsl(var(--muted-foreground))',
                  background: 'hsl(var(--muted-foreground) / 0.08)',
                }
          }
        >
          {r.label}
        </Link>
      ))}
    </div>
  )
}

/**
 * Downloads the CSV.
 *
 * Fetched and turned into a blob rather than opened as a plain link, for one
 * reason: a link navigates, and if the request fails the person lands on a page
 * of raw JSON instead of getting a file. This way a failure stays on the page
 * and says what went wrong.
 */
export function ExportButton({ workspaceId, days }: { workspaceId: string; days: number }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function download() {
    setBusy(true)
    setError(null)

    try {
      const response = await fetch(
        `/api/v1/reports/posts.csv?workspaceId=${workspaceId}&days=${days}`,
        { headers: { 'x-smm-client': 'web' } }
      )

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as {
          error?: { message?: string }
        } | null
        setError(payload?.error?.message ?? 'The export could not be generated.')
        setBusy(false)
        return
      }

      const blob = await response.blob()
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `posts-${new Date().toISOString().slice(0, 10)}.csv`
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      // Released immediately. A blob URL held after the click keeps the whole
      // file in memory for the life of the tab.
      URL.revokeObjectURL(url)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The export could not be downloaded.')
    }

    setBusy(false)
  }

  return (
    <div>
      <button
        type="button"
        onClick={() => void download()}
        disabled={busy}
        className="rounded px-3 py-1.5 text-sm font-medium transition-opacity disabled:opacity-40 bg-primary text-primary-foreground"
      >
        {busy ? 'Preparing...' : `Download CSV (${days} days)`}
      </button>

      {error && (
        <p className="mt-2 text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
