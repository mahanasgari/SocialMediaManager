import { apiGet } from '@/lib/server-fetch'
import { ErrorCard, PageHeader } from '@/components/ui'
import { Calendar, type CalendarEntry } from './calendar.client'

export default async function CalendarPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>
  searchParams: Promise<{ month?: string }>
}) {
  const { workspaceId } = await params
  const { month } = await searchParams

  const now = new Date()
  const target = month ?? `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  const [year, m] = target.split('-').map(Number) as [number, number]

  // Fetch a padded range: the grid shows trailing days of the previous month and
  // leading days of the next, and a post on one of those should not vanish.
  const from = new Date(year, m - 1, 1).getTime() - 7 * 86_400_000
  const to = new Date(year, m, 0).getTime() + 7 * 86_400_000

  const entries = await apiGet<CalendarEntry[]>(
    `/api/v1/calendar?workspaceId=${workspaceId}&from=${new Date(from).toISOString()}&to=${new Date(to).toISOString()}`
  )

  return (
    <>
      <PageHeader title="Calendar" description="What is going out, and when." />
      {entries.ok ? (
        <Calendar workspaceId={workspaceId} entries={entries.data} month={target} />
      ) : (
        <ErrorCard message={entries.message} requestId={entries.requestId} />
      )}
    </>
  )
}
