'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Pause, Play, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Card } from '@/components/ui'

type Account = { id: string; handle: string; displayName: string; provider: string }

const WEEKDAYS = [
  { value: 1, short: 'Mon' },
  { value: 2, short: 'Tue' },
  { value: 3, short: 'Wed' },
  { value: 4, short: 'Thu' },
  { value: 5, short: 'Fri' },
  { value: 6, short: 'Sat' },
  { value: 0, short: 'Sun' },
]

async function send(path: string, method: 'POST' | 'PATCH' | 'DELETE', body?: unknown) {
  const response = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json', 'x-smm-client': 'web' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const parsed = (await response.json().catch(() => null)) as
    | { error?: { message?: string } }
    | Record<string, unknown>
    | null

  if (!response.ok) {
    const message =
      (parsed as { error?: { message?: string } })?.error?.message ?? 'That did not work.'
    return { ok: false as const, message }
  }
  return { ok: true as const, data: parsed }
}

/**
 * Building a rule, with a live preview of what it would do.
 *
 * The preview is the important half. A recurrence rule is a small program
 * somebody writes in a form, and "every 2 weeks on Monday and Thursday" is easy
 * to get wrong in a way nobody notices until the wrong week. Showing the actual
 * next few dates — computed by the same code that will generate the posts —
 * turns a guess into something you can check.
 */
export function ScheduleForm({
  workspaceId,
  accounts,
  accountsUnavailable,
}: {
  workspaceId: string
  accounts: Account[]
  accountsUnavailable: boolean
}) {
  const router = useRouter()

  const [freq, setFreq] = useState<'DAILY' | 'WEEKLY' | 'MONTHLY'>('WEEKLY')
  const [interval, setInterval] = useState(1)
  const [byWeekday, setByWeekday] = useState<number[]>([1])
  const [byMonthDay, setByMonthDay] = useState(1)
  const [time, setTime] = useState('09:00')
  // The browser's own zone as the default. It is what the person means far more
  // often than UTC, and getting it wrong by defaulting to UTC shifts every post
  // by hours for most of the world.
  const [timezone, setTimezone] = useState('UTC')
  const [startsOn, setStartsOn] = useState('')
  const [endsOn, setEndsOn] = useState('')
  const [name, setName] = useState('')
  const [content, setContent] = useState('')
  const [selected, setSelected] = useState<string[]>([])

  const [preview, setPreview] = useState<{ summary: string; occurrences: string[]; note: string | null } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC')
    setStartsOn(new Date().toISOString().slice(0, 10))
  }, [])

  const rule = () => {
    const [hour, minute] = time.split(':').map(Number)
    return {
      workspaceId,
      freq,
      interval,
      byWeekday: freq === 'WEEKLY' ? byWeekday : [],
      ...(freq === 'MONTHLY' ? { byMonthDay } : {}),
      hour: hour ?? 9,
      minute: minute ?? 0,
      timezone,
      startsOn,
      ...(endsOn ? { endsOn } : {}),
    }
  }

  // Re-previewed whenever the pattern changes, so the dates on screen always
  // describe the form as it stands rather than as it was.
  useEffect(() => {
    if (!startsOn || !timezone) return
    let cancelled = false

    const timer = setTimeout(async () => {
      const result = await send('/api/v1/recurrences/preview', 'POST', { ...rule(), count: 5 })
      if (cancelled) return
      if (result.ok) {
        setPreview(result.data as { summary: string; occurrences: string[]; note: string | null })
      }
    }, 250)

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
    // Depends on the rule fields rather than on `rule`, which is a new object
    // every render and would re-fire this on every keystroke in any field.
  }, [freq, interval, byWeekday.join(','), byMonthDay, time, timezone, startsOn, endsOn])

  const toggleDay = (day: number) =>
    setByWeekday((current) =>
      current.includes(day) ? current.filter((d) => d !== day) : [...current, day].sort()
    )

  return (
    <Card className="p-4">
      <form
        className="space-y-4"
        onSubmit={async (event) => {
          event.preventDefault()
          setBusy(true)
          setError(null)

          const result = await send('/api/v1/recurrences', 'POST', {
            ...rule(),
            name,
            content,
            accountIds: selected,
          })

          setBusy(false)
          if (!result.ok) return setError(result.message)

          setName('')
          setContent('')
          setSelected([])
          router.refresh()
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="schedule-name">Schedule name</Label>
            <Input
              id="schedule-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={120}
              placeholder="Weekly digest"
            />
          </div>
          <div>
            <Label htmlFor="schedule-timezone">Time zone</Label>
            <Input
              id="schedule-timezone"
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              required
              placeholder="Europe/Berlin"
            />
          </div>
        </div>

        <div>
          <Label htmlFor="schedule-content">What to post</Label>
          <Textarea
            id="schedule-content"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            required
            rows={3}
          />
        </div>

        <fieldset>
          <legend className="text-sm font-medium">How often</legend>
          <div className="mt-2 flex flex-wrap items-end gap-3">
            <div>
              <Label htmlFor="schedule-freq">Repeats</Label>
              <select
                id="schedule-freq"
                value={freq}
                onChange={(e) => setFreq(e.target.value as typeof freq)}
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
              >
                <option value="DAILY">Daily</option>
                <option value="WEEKLY">Weekly</option>
                <option value="MONTHLY">Monthly</option>
              </select>
            </div>

            <div className="w-24">
              <Label htmlFor="schedule-interval">Every</Label>
              <Input
                id="schedule-interval"
                type="number"
                min={1}
                max={52}
                value={interval}
                onChange={(e) => setInterval(Math.max(1, Number(e.target.value)))}
              />
            </div>

            <div className="w-32">
              <Label htmlFor="schedule-time">At</Label>
              <Input
                id="schedule-time"
                type="time"
                value={time}
                onChange={(e) => setTime(e.target.value)}
                required
              />
            </div>
          </div>

          {freq === 'WEEKLY' && (
            <div className="mt-3">
              <Label>On these days</Label>
              <div className="mt-1 flex flex-wrap gap-1">
                {WEEKDAYS.map((day) => (
                  <button
                    key={day.value}
                    type="button"
                    onClick={() => toggleDay(day.value)}
                    aria-pressed={byWeekday.includes(day.value)}
                    className={
                      byWeekday.includes(day.value)
                        ? 'rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground'
                        : 'rounded-md border border-input px-2.5 py-1 text-xs hover:bg-accent'
                    }
                  >
                    {day.short}
                  </button>
                ))}
              </div>
            </div>
          )}

          {freq === 'MONTHLY' && (
            <div className="mt-3 w-40">
              <Label htmlFor="schedule-monthday">Day of month</Label>
              <select
                id="schedule-monthday"
                value={byMonthDay}
                onChange={(e) => setByMonthDay(Number(e.target.value))}
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
              >
                {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
                <option value={-1}>Last day</option>
              </select>
              {byMonthDay > 28 && byMonthDay !== -1 && (
                // Said before it happens, not discovered in February. Skipping
                // is the honest behaviour, but only if somebody knows.
                <p className="mt-1 text-xs text-warning">
                  Months without a {byMonthDay}
                  {byMonthDay === 31 ? 'st' : 'th'} are skipped. Choose “Last day” to post in
                  every month.
                </p>
              )}
            </div>
          )}
        </fieldset>

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="schedule-starts">Starts on</Label>
            <Input
              id="schedule-starts"
              type="date"
              value={startsOn}
              onChange={(e) => setStartsOn(e.target.value)}
              required
            />
          </div>
          <div>
            <Label htmlFor="schedule-ends">Ends on (optional)</Label>
            <Input
              id="schedule-ends"
              type="date"
              value={endsOn}
              onChange={(e) => setEndsOn(e.target.value)}
            />
          </div>
        </div>

        <fieldset>
          <legend className="text-sm font-medium">Post to</legend>
          {accountsUnavailable ? (
            <p className="mt-1 text-xs text-destructive">
              Could not load your connected accounts, so a schedule cannot be created right now.
            </p>
          ) : accounts.length === 0 ? (
            <p className="mt-1 text-xs text-muted-foreground">
              No accounts are connected yet. Connect one first — a schedule with nowhere to post
              would produce posts that cannot go out.
            </p>
          ) : (
            <div className="mt-2 flex flex-wrap gap-2">
              {accounts.map((account) => (
                <label
                  key={account.id}
                  className="flex items-center gap-2 rounded-md border border-input px-2.5 py-1.5 text-xs"
                >
                  <input
                    type="checkbox"
                    className="size-3.5"
                    checked={selected.includes(account.id)}
                    onChange={() =>
                      setSelected((current) =>
                        current.includes(account.id)
                          ? current.filter((id) => id !== account.id)
                          : [...current, account.id]
                      )
                    }
                  />
                  {account.handle}
                </label>
              ))}
            </div>
          )}
        </fieldset>

        {/* The preview. Computed by the same code that generates the posts, so
            what is shown is what will happen rather than a second guess at it. */}
        {preview && (
          <div className="rounded-md border bg-muted/40 p-3">
            <p className="text-xs font-medium">{preview.summary}</p>
            {preview.note ? (
              <p className="mt-1 text-xs text-warning">{preview.note}</p>
            ) : (
              <ul className="mt-1.5 space-y-0.5" data-testid="schedule-preview">
                {preview.occurrences.map((iso) => (
                  <li key={iso} className="text-xs text-muted-foreground">
                    {new Date(iso).toLocaleString(undefined, {
                      timeZone: timezone,
                      weekday: 'short',
                      day: 'numeric',
                      month: 'short',
                      hour: '2-digit',
                      minute: '2-digit',
                      hour12: false,
                    })}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        <div>
          <Button
            type="submit"
            size="sm"
            disabled={busy || selected.length === 0 || content.length === 0}
          >
            {busy ? 'Creating…' : 'Create schedule'}
          </Button>
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

export function PauseSchedule({
  workspaceId,
  id,
  active,
}: {
  workspaceId: string
  id: string
  active: boolean
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)

  return (
    <Button
      variant="ghost"
      size="icon-sm"
      disabled={busy}
      title={active ? 'Pause' : 'Resume'}
      aria-label={active ? 'Pause schedule' : 'Resume schedule'}
      onClick={async () => {
        setBusy(true)
        await send(`/api/v1/recurrences/${id}`, 'PATCH', { workspaceId, active: !active })
        setBusy(false)
        router.refresh()
      }}
    >
      {active ? <Pause className="size-4" /> : <Play className="size-4" />}
    </Button>
  )
}

/**
 * Deleting a schedule, with the choice about its posts made explicit.
 *
 * Two genuinely different intentions hide behind one button. "Stop making new
 * ones" is the common one; "and clear the calendar" is occasionally meant and
 * never guessable. Keeping the posts is the default because it is recoverable —
 * you can delete them afterwards — whereas the other way round is not.
 */
export function DeleteSchedule({
  workspaceId,
  id,
  name,
  postCount,
}: {
  workspaceId: string
  id: string
  name: string
  postCount: number
}) {
  const router = useRouter()
  const [armed, setArmed] = useState(false)
  const [busy, setBusy] = useState(false)

  const remove = async (futurePosts: 'keep' | 'delete') => {
    setBusy(true)
    await send(
      `/api/v1/recurrences/${id}?workspaceId=${workspaceId}&futurePosts=${futurePosts}`,
      'DELETE'
    )
    setBusy(false)
    router.refresh()
  }

  if (armed) {
    return (
      <span className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">
          Delete “{name}”? It has created {postCount} post{postCount === 1 ? '' : 's'}.
        </span>
        <Button variant="destructive" size="sm" disabled={busy} onClick={() => remove('keep')}>
          Delete, keep posts
        </Button>
        <Button variant="outline" size="sm" disabled={busy} onClick={() => remove('delete')}>
          Delete and clear upcoming
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setArmed(false)}>
          Cancel
        </Button>
      </span>
    )
  }

  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label="Delete schedule"
      title="Delete"
      onClick={() => setArmed(true)}
    >
      <Trash2 className="size-4" />
    </Button>
  )
}
