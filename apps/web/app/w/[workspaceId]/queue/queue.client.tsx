'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Clock, Plus, Sparkles, X } from 'lucide-react'
import { Card, EmptyState, Muted } from '@/components/ui'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/cn'

type Slot = { id: string; dayOfWeek: number; hour: number; minute: number }

export type QueueData = {
  timezone: string
  slots: Slot[]
  upcoming: string[]
  canManage: boolean
  suggested: { dayOfWeek: number; hour: number; minute: number }[]
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
/** Monday first: a content week is a working week. */
const ORDER = [1, 2, 3, 4, 5, 6, 0]

export function QueueEditor({ workspaceId, data }: { workspaceId: string; data: QueueData }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState<number | null>(null)
  const [time, setTime] = useState('09:00')

  async function add(dayOfWeek: number, value: string) {
    const [hour, minute] = value.split(':').map(Number)
    if (hour === undefined || minute === undefined || Number.isNaN(hour) || Number.isNaN(minute)) {
      setError('That is not a time.')
      return
    }

    setBusy(true)
    setError(null)
    const response = await fetch('/api/v1/posting-slots', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-smm-client': 'web' },
      body: JSON.stringify({ workspaceId, dayOfWeek, hour, minute }),
    })
    setBusy(false)

    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as {
        error?: { message?: string }
      } | null
      setError(body?.error?.message ?? 'That time could not be added.')
      return
    }
    setAdding(null)
    router.refresh()
  }

  async function remove(id: string) {
    setBusy(true)
    await fetch(`/api/v1/posting-slots/${id}?workspaceId=${workspaceId}`, {
      method: 'DELETE',
      headers: { 'x-smm-client': 'web' },
    })
    setBusy(false)
    router.refresh()
  }

  async function useSuggested() {
    setBusy(true)
    setError(null)
    // Sequential rather than parallel: the endpoint refuses a duplicate, and a
    // burst of parallel writes would race that check into a confusing partial
    // result.
    for (const slot of data.suggested) {
      await fetch('/api/v1/posting-slots', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-smm-client': 'web' },
        body: JSON.stringify({ workspaceId, ...slot }),
      })
    }
    setBusy(false)
    router.refresh()
  }

  const byDay = new Map<number, Slot[]>()
  for (const slot of data.slots) {
    byDay.set(slot.dayOfWeek, [...(byDay.get(slot.dayOfWeek) ?? []), slot])
  }

  return (
    <div className="space-y-6">
      {data.slots.length === 0 ? (
        <EmptyState
          title="No posting times yet"
          hint="Add the times this workspace publishes and new posts will take the next free one, instead of you picking a date and time for every single post."
          action={
            data.canManage ? (
              <Button size="sm" onClick={() => void useSuggested()} loading={busy}>
                <Sparkles className="size-3.5" />
                Use a weekday schedule
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div>
          <p className="text-sm">
            <Muted>
              Times are in {data.timezone}, this workspace&apos;s timezone. They stay put across
              daylight-saving changes — 09:00 remains 09:00.
            </Muted>
          </p>

          <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {ORDER.map((day) => {
              const slots = (byDay.get(day) ?? []).sort(
                (a, b) => a.hour - b.hour || a.minute - b.minute
              )
              return (
                <Card key={day} className="p-3">
                  <p className="text-xs font-medium">{DAYS[day]}</p>

                  <div className="mt-2 space-y-1">
                    {slots.length === 0 && (
                      <p className="text-xs text-muted-foreground">Nothing scheduled</p>
                    )}
                    {slots.map((slot) => (
                      <div
                        key={slot.id}
                        className="group flex items-center justify-between rounded-md border border-input px-2 py-1"
                      >
                        <span className="tabular text-xs">
                          {String(slot.hour).padStart(2, '0')}:
                          {String(slot.minute).padStart(2, '0')}
                        </span>
                        {data.canManage && (
                          <button
                            type="button"
                            aria-label={`Remove ${DAYS[day]} ${slot.hour}:${slot.minute}`}
                            disabled={busy}
                            onClick={() => void remove(slot.id)}
                            className="text-muted-foreground opacity-0 transition-opacity hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100"
                          >
                            <X className="size-3.5" />
                          </button>
                        )}
                      </div>
                    ))}
                  </div>

                  {data.canManage &&
                    (adding === day ? (
                      <div className="mt-2 flex gap-1">
                        <input
                          type="time"
                          value={time}
                          autoFocus
                          onChange={(event) => setTime(event.target.value)}
                          className="h-7 w-full rounded-md border border-input bg-transparent px-1.5 text-xs"
                        />
                        <Button size="sm" className="h-7 px-2" onClick={() => void add(day, time)}>
                          Add
                        </Button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setAdding(day)}
                        className="mt-2 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                      >
                        <Plus className="size-3" />
                        Add time
                      </button>
                    ))}
                </Card>
              )
            })}
          </div>
        </div>
      )}

      {error && <p className="text-xs text-destructive">{error}</p>}

      {data.upcoming.length > 0 && (
        <div>
          <p className="flex items-center gap-1.5 text-sm font-medium">
            <Clock className="size-3.5" />
            Next times a post would go out
          </p>
          {/* The question anyone actually has on this screen. A grid of
              "Tue 09:00" rows does not answer "so when does my next post
              publish?" — these are real instants, already skipping anything
              taken. */}
          <ol className="mt-2 space-y-1">
            {data.upcoming.map((iso, index) => (
              <li
                key={iso}
                className={cn('text-sm', index === 0 ? 'font-medium' : 'text-muted-foreground')}
              >
                {new Date(iso).toLocaleString(undefined, {
                  weekday: 'short',
                  day: 'numeric',
                  month: 'short',
                  hour: '2-digit',
                  minute: '2-digit',
                })}
                {index === 0 && <span className="ml-2 text-xs text-primary">next</span>}
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  )
}
