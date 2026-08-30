'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'

export type CalendarEntry = {
  id: string
  status: string
  excerpt: string
  at: string | null
  timezone: string
  channels: string[]
  summary: string
}

const DAY_MS = 86_400_000

/**
 * Month calendar on a CSS grid.
 *
 * Built directly rather than on a general event-calendar library: a content
 * calendar diverges from one quickly — per-channel status, partial publishing,
 * drag-to-reschedule with a server round trip — and fighting a library's event
 * model costs more than the grid does.
 *
 * Everything renders in the VIEWER'S timezone. The instant is absolute; the
 * author's zone is kept alongside it so "9am" can be shown as the author meant
 * it where that matters.
 */
export function Calendar({
  workspaceId,
  entries,
  month,
}: {
  workspaceId: string
  entries: CalendarEntry[]
  month: string
}) {
  const router = useRouter()
  const [dragging, setDragging] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const anchor = useMemo(() => new Date(`${month}-01T00:00:00`), [month])

  const days = useMemo(() => {
    const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1)
    // Start on Monday: a content week is a working week.
    const offset = (first.getDay() + 6) % 7
    const start = new Date(first.getTime() - offset * DAY_MS)
    return Array.from({ length: 42 }, (_, i) => new Date(start.getTime() + i * DAY_MS))
  }, [anchor])

  const byDay = useMemo(() => {
    const map = new Map<string, CalendarEntry[]>()
    for (const entry of entries) {
      if (!entry.at) continue
      const key = dayKey(new Date(entry.at))
      map.set(key, [...(map.get(key) ?? []), entry])
    }
    return map
  }, [entries])

  async function reschedule(postId: string, day: Date) {
    setError(null)
    const original = entries.find((e) => e.id === postId)
    // Keep the time of day and move only the date — dropping a 9am post onto
    // Thursday should make it 9am Thursday, not midnight.
    const previous = original?.at ? new Date(original.at) : new Date()
    const next = new Date(day)
    next.setHours(previous.getHours(), previous.getMinutes(), 0, 0)

    const response = await fetch(`/api/v1/calendar/${postId}/reschedule`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-smm-client': 'web' },
      body: JSON.stringify({ workspaceId, scheduledAt: next.toISOString() }),
    })

    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as {
        error?: { message?: string }
      } | null
      setError(body?.error?.message ?? 'Could not reschedule that post.')
      return
    }
    router.refresh()
  }

  const monthIndex = anchor.getMonth()

  return (
    <>
      <div className="mb-3 flex items-center justify-between">
        <div className="flex gap-2">
          <MonthLink workspaceId={workspaceId} month={shiftMonth(month, -1)} label="←" />
          <MonthLink workspaceId={workspaceId} month={shiftMonth(month, 1)} label="→" />
        </div>
        <p className="text-sm font-medium">
          {anchor.toLocaleDateString(undefined, {
            month: 'long',
            year: 'numeric',
          })}
        </p>
      </div>

      {error && (
        <p className="mb-2 text-sm" role="alert">
          {error}
        </p>
      )}

      <div
        className="grid grid-cols-7 gap-px overflow-hidden rounded-lg border"
        style={{
          borderColor: 'hsl(var(--border))',
          background: 'hsl(var(--border))',
        }}
      >
        {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => (
          <div
            key={d}
            className="px-2 py-1 text-center text-[11px] font-medium bg-card text-muted-foreground"
          >
            {d}
          </div>
        ))}

        {days.map((day) => {
          const key = dayKey(day)
          const entriesForDay = byDay.get(key) ?? []
          const otherMonth = day.getMonth() !== monthIndex
          const isToday = key === dayKey(new Date())

          return (
            <div
              key={key}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => {
                if (dragging) void reschedule(dragging, day)
                setDragging(null)
              }}
              className="min-h-24 p-1"
              style={{
                background: 'hsl(var(--background))',
                opacity: otherMonth ? 0.45 : 1,
              }}
            >
              <div className="flex items-center justify-between px-1">
                <span
                  className="text-[11px] tabular-nums"
                  style={{
                    color: isToday ? 'hsl(var(--primary))' : 'hsl(var(--muted-foreground))',
                    fontWeight: isToday ? 600 : 400,
                  }}
                >
                  {day.getDate()}
                </span>
              </div>

              <div className="mt-1 space-y-1">
                {entriesForDay.map((entry) => (
                  <div
                    key={entry.id}
                    draggable={
                      entry.status !== 'PUBLISHED' && entry.status !== 'PARTIALLY_PUBLISHED'
                    }
                    onDragStart={() => setDragging(entry.id)}
                    onDragEnd={() => setDragging(null)}
                    title={`${entry.summary}\n${entry.channels.join(', ')}`}
                    className="cursor-grab rounded px-1.5 py-1 text-[11px] leading-tight"
                    style={{
                      background: toneFor(entry.status),
                      color: 'hsl(var(--foreground))',
                    }}
                  >
                    <span className="block truncate font-medium">
                      {entry.at
                        ? new Date(entry.at).toLocaleTimeString(undefined, {
                            hour: '2-digit',
                            minute: '2-digit',
                          })
                        : ''}
                    </span>
                    <span className="block truncate">{entry.excerpt || '(empty)'}</span>
                  </div>
                ))}
              </div>
            </div>
          )
        })}
      </div>

      <p className="mt-2 text-xs text-muted-foreground">
        Drag a scheduled post to another day to move it. Published posts cannot be moved — they
        already exist on the network.
      </p>
    </>
  )
}

function MonthLink({
  workspaceId,
  month,
  label,
}: {
  workspaceId: string
  month: string
  label: string
}) {
  return (
    <a
      href={`/w/${workspaceId}/calendar?month=${month}`}
      className="rounded border px-2 py-1 text-xs border-border"
    >
      {label}
    </a>
  )
}

function dayKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function shiftMonth(month: string, by: number): string {
  const [year, m] = month.split('-').map(Number) as [number, number]
  const date = new Date(year, m - 1 + by, 1)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
}

function toneFor(status: string): string {
  switch (status) {
    case 'PUBLISHED':
      return 'hsl(var(--primary) / 0.15)'
    case 'PARTIALLY_PUBLISHED':
    case 'NEEDS_REVIEW':
    case 'MISSED':
    case 'FAILED':
      return 'hsl(38 92% 50% / 0.2)'
    default:
      return 'hsl(var(--foreground) / 0.07)'
  }
}
