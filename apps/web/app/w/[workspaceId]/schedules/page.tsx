import { apiGet } from '@/lib/server-fetch'
import { Badge, Card, EmptyState, ErrorCard, Muted, PageHeader } from '@/components/ui'
import { ScheduleForm, PauseSchedule, DeleteSchedule } from './schedules.client'

type Schedule = {
  id: string
  name: string
  freq: 'DAILY' | 'WEEKLY' | 'MONTHLY'
  interval: number
  byWeekday: number[]
  byMonthDay: number | null
  hour: number
  minute: number
  timezone: string
  startsOn: string
  endsOn: string | null
  content: string
  accountIds: string[]
  active: boolean
  expandedUntil: string | null
  postCount: number
  summary: string
  nextRuns: string[]
}

type Account = { id: string; handle: string; displayName: string; provider: string }

/**
 * Shown in the rule's own zone, not the reader's.
 *
 * A schedule written as "09:00 Europe/Berlin" and displayed as "08:00" to
 * somebody in London is technically correct and completely useless — they
 * cannot tell whether the rule is wrong or the display is. The zone is named
 * alongside so there is no ambiguity either way.
 */
function inRuleZone(iso: string, timezone: string): string {
  return new Date(iso).toLocaleString(undefined, {
    timeZone: timezone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

export default async function SchedulesPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>
}) {
  const { workspaceId } = await params

  const [schedules, accounts] = await Promise.all([
    apiGet<Schedule[]>(`/api/v1/recurrences?workspaceId=${workspaceId}`),
    apiGet<Account[]>(`/api/v1/social-accounts?workspaceId=${workspaceId}`),
  ])

  if (!schedules.ok) return <ErrorCard message={schedules.message} requestId={schedules.requestId} />

  const active = schedules.data.filter((s) => s.active)
  const paused = schedules.data.filter((s) => !s.active)

  return (
    <>
      <PageHeader
        title="Repeating schedules"
        description="A rule that keeps the calendar filled. Posts appear as ordinary scheduled posts, so you can edit or move any one of them without touching the schedule."
      />

      <ScheduleForm
        workspaceId={workspaceId}
        accounts={accounts.ok ? accounts.data : []}
        accountsUnavailable={!accounts.ok}
      />

      {schedules.data.length === 0 ? (
        <div className="mt-6">
          <EmptyState
            title="No repeating schedules"
            hint="Set one up above for anything that goes out on a rhythm — a weekly digest, a daily tip. The time is kept in the zone you choose, so it stays put across a clock change."
          />
        </div>
      ) : (
        <div className="mt-6 space-y-6">
          <div className="space-y-3">
            {active.map((schedule) => (
              <Card key={schedule.id} data-card="schedule" className="p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{schedule.name}</p>
                    <p className="mt-0.5 text-xs">
                      <Muted>{schedule.summary}</Muted>
                    </p>
                    <p className="mt-2 max-w-prose whitespace-pre-wrap text-sm text-muted-foreground">
                      {schedule.content.length > 180
                        ? `${schedule.content.slice(0, 180)}…`
                        : schedule.content}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <PauseSchedule workspaceId={workspaceId} id={schedule.id} active />
                    <DeleteSchedule
                      workspaceId={workspaceId}
                      id={schedule.id}
                      name={schedule.name}
                      postCount={schedule.postCount}
                    />
                  </div>
                </div>

                {schedule.nextRuns.length > 0 ? (
                  <div className="mt-3 border-t pt-3">
                    <p className="text-xs font-medium">Next</p>
                    <ul className="mt-1 space-y-0.5">
                      {schedule.nextRuns.map((run) => (
                        <li key={run} className="text-xs">
                          <Muted>{inRuleZone(run, schedule.timezone)}</Muted>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : (
                  // Named rather than left as an empty section. A schedule that
                  // will never fire again looks identical to one that is simply
                  // between runs, and the difference matters.
                  <p className="mt-3 border-t pt-3 text-xs text-warning">
                    This schedule has no further runs. Its end date may have passed, or it may
                    fall on a day the month does not have.
                  </p>
                )}

                <p className="mt-2 text-xs">
                  <Muted>
                    {schedule.postCount} post{schedule.postCount === 1 ? '' : 's'} created so far
                  </Muted>
                </p>
              </Card>
            ))}
          </div>

          {paused.length > 0 && (
            <div>
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Paused
              </p>
              <div className="space-y-2">
                {paused.map((schedule) => (
                  <Card
                    key={schedule.id}
                    data-card="schedule"
                    className="flex flex-wrap items-center gap-3 p-3 opacity-75"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm">
                        {schedule.name} <Badge>paused</Badge>
                      </p>
                      <p className="text-xs">
                        <Muted>{schedule.summary}</Muted>
                      </p>
                    </div>
                    <PauseSchedule workspaceId={workspaceId} id={schedule.id} active={false} />
                    <DeleteSchedule
                      workspaceId={workspaceId}
                      id={schedule.id}
                      name={schedule.name}
                      postCount={schedule.postCount}
                    />
                  </Card>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </>
  )
}
