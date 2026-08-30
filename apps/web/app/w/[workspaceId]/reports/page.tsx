import { apiGet } from '@/lib/server-fetch'
import { getWorkspace } from '@/lib/api'
import { Card, ErrorCard, Muted, PageHeader } from '@/components/ui'
import { RangePicker, ExportButton } from './report.client'

type Summary = {
  windowDays: number
  totalPosts: number
  totalChannelPosts: number
  byStatus: Record<string, number>
  publishedLate: number
  headline: string
}

const STATUS_ORDER = [
  'PUBLISHED',
  'PARTIALLY_PUBLISHED',
  'SCHEDULED',
  'PENDING_APPROVAL',
  'NEEDS_REVIEW',
  'DRAFT',
  'FAILED',
  'MISSED',
  'CANCELLED',
] as const

const STATUS_LABEL: Record<string, string> = {
  PUBLISHED: 'Published',
  PARTIALLY_PUBLISHED: 'Partially published',
  SCHEDULED: 'Scheduled',
  PENDING_APPROVAL: 'Awaiting approval',
  NEEDS_REVIEW: 'Needs review',
  DRAFT: 'Drafts',
  FAILED: 'Failed',
  MISSED: 'Missed',
  CANCELLED: 'Cancelled',
}

export default async function ReportsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>
  searchParams: Promise<{ days?: string }>
}) {
  const { workspaceId } = await params
  const { days: rawDays } = await searchParams
  const days = clampDays(rawDays)

  const [workspace, summary] = await Promise.all([
    getWorkspace(workspaceId),
    apiGet<Summary>(`/api/v1/reports/summary?workspaceId=${workspaceId}&days=${days}`),
  ])

  if (!workspace.ok)
    return <ErrorCard message={workspace.message} requestId={workspace.requestId} />
  if (!summary.ok) return <ErrorCard message={summary.message} requestId={summary.requestId} />

  const canExport = workspace.data.permissions.includes('reports.export')
  const s = summary.data
  const statuses = STATUS_ORDER.filter((k) => (s.byStatus[k] ?? 0) > 0)

  return (
    <>
      <PageHeader
        title="Reports"
        description="A summary you can hand to someone who does not use this tool."
      />

      <RangePicker workspaceId={workspaceId} days={days} />

      <Card className="mt-4 p-5">
        <p className="text-sm">{s.headline}</p>
        <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Stat label="Posts" value={s.totalPosts} />
          <Stat
            label="Channel posts"
            value={s.totalChannelPosts}
            hint="One post to four channels counts as four."
          />
          <Stat
            label="Published late"
            value={s.publishedLate}
            hint="More than a minute after the scheduled time."
          />
          <Stat label="Window" value={`${s.windowDays}d`} />
        </div>
      </Card>

      <section className="mt-8">
        <h2 className="text-sm font-medium">By status</h2>
        {statuses.length === 0 ? (
          <p className="mt-2 text-sm">
            <Muted>Nothing was created in this window.</Muted>
          </p>
        ) : (
          <Card className="mt-2 divide-y border-border">
            {statuses.map((status) => {
              const count = s.byStatus[status] ?? 0
              const share = s.totalPosts > 0 ? (count / s.totalPosts) * 100 : 0
              return (
                <div key={status} className="flex items-center gap-3 px-4 py-2.5">
                  <span className="w-40 shrink-0 text-sm">{STATUS_LABEL[status] ?? status}</span>
                  {/* A bar rather than a chart library. It answers the only
                      question a status breakdown is asked — which of these is
                      big — and costs no dependency to do it. */}
                  <span
                    className="h-1.5 min-w-[2px] rounded-full"
                    style={{
                      width: `${Math.max(share, 1)}%`,
                      background:
                        status === 'FAILED' || status === 'MISSED'
                          ? 'hsl(var(--destructive))'
                          : 'hsl(var(--primary))',
                    }}
                  />
                  <span className="ml-auto shrink-0 text-sm tabular-nums">{count}</span>
                </div>
              )
            })}
          </Card>
        )}
      </section>

      <section className="mt-8">
        <h2 className="text-sm font-medium">Export</h2>
        <p className="mt-0.5 text-xs">
          <Muted>
            One row per channel post, not per post — a post that went to four channels performed
            four different ways, and collapsing that loses the comparison the export exists to make.
            Unmeasured metrics are left empty rather than written as zero, because a zero gets
            averaged and an empty cell does not.
          </Muted>
        </p>

        <div className="mt-3">
          {canExport ? (
            <ExportButton workspaceId={workspaceId} days={days} />
          ) : (
            <Card className="p-4">
              <p className="text-sm">
                <Muted>Your role can read reports but not export them.</Muted>
              </p>
            </Card>
          )}
        </div>
      </section>

      <p className="mt-8 text-xs">
        <Muted>
          CSV rather than PDF, deliberately. A PDF is a picture of a spreadsheet: it cannot be
          filtered, pivoted or joined to anything, and everyone who receives one asks for the
          numbers instead.
        </Muted>
      </p>
    </>
  )
}

function Stat({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div>
      <p className="text-2xl font-semibold tabular-nums">{value}</p>
      <p className="text-xs font-medium">{label}</p>
      {hint && (
        <p className="mt-0.5 text-xs">
          <Muted>{hint}</Muted>
        </p>
      )}
    </div>
  )
}

/** Mirrors the API's own clamp, so the UI never offers a range it will reject. */
function clampDays(raw: string | undefined): number {
  const n = Number(raw)
  if (!Number.isFinite(n)) return 30
  return Math.min(Math.max(Math.trunc(n), 1), 365)
}
