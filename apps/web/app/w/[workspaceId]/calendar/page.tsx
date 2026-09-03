import { apiGet } from '@/lib/server-fetch'
import { ErrorCard, PageHeader } from '@/components/ui'
import { Calendar, type CalendarEntry, type CalendarView } from './calendar.client'

const DAY_MS = 86_400_000
const VIEWS: CalendarView[] = ['month', 'week', 'day', 'list']

/**
 * The range each view needs, as absolute instants.
 *
 * Computed here rather than in the browser so the data arrives with the page,
 * and computed from the ANCHOR rather than from "now" so paging back a week
 * does not quietly re-centre on today.
 */
function rangeFor(view: CalendarView, anchor: Date): { from: Date; to: Date } {
  if (view === 'day') {
    const start = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate())
    return { from: start, to: new Date(start.getTime() + DAY_MS) }
  }

  if (view === 'week') {
    // Monday-first: a content week is a working week.
    const offset = (anchor.getDay() + 6) % 7
    const start = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() - offset)
    return { from: start, to: new Date(start.getTime() + 7 * DAY_MS) }
  }

  if (view === 'list') {
    // Forward-looking. A list is for "what is coming", and one that opens on
    // last month's published posts answers a question nobody asked.
    const start = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate())
    return { from: start, to: new Date(start.getTime() + 60 * DAY_MS) }
  }

  // Month, padded either side: the grid shows trailing days of the previous
  // month and leading days of the next, and a post on one of those must not
  // vanish.
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1)
  const last = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0)
  return {
    from: new Date(first.getTime() - 7 * DAY_MS),
    to: new Date(last.getTime() + 7 * DAY_MS),
  }
}

export default async function CalendarPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>
  searchParams: Promise<{ month?: string; date?: string; view?: string }>
}) {
  const { workspaceId } = await params
  const { month, date, view: rawView } = await searchParams

  const view: CalendarView = VIEWS.includes(rawView as CalendarView)
    ? (rawView as CalendarView)
    : 'month'

  // `date` drives week, day and list; `month` drives the month grid. Keeping
  // both means switching views does not lose where someone was looking.
  const now = new Date()
  const anchor = date
    ? new Date(`${date}T00:00:00`)
    : month
      ? new Date(`${month}-01T00:00:00`)
      : now

  const { from, to } = rangeFor(view, anchor)

  const entries = await apiGet<CalendarEntry[]>(
    `/api/v1/calendar?workspaceId=${workspaceId}&from=${from.toISOString()}&to=${to.toISOString()}`
  )

  return (
    <>
      <PageHeader title="Calendar" description="What is going out, and when." />
      {entries.ok ? (
        <Calendar
          workspaceId={workspaceId}
          entries={entries.data}
          view={view}
          anchor={anchor.toISOString()}
        />
      ) : (
        <ErrorCard message={entries.message} requestId={entries.requestId} />
      )}
    </>
  )
}
