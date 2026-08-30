import { apiGet } from '@/lib/server-fetch'
import { Card, EmptyState, ErrorCard, Muted, PageHeader } from '@/components/ui'

type Overview = {
  windowDays: number
  publishedCount: number
  activeAccounts: number
  measuredCount: number
  totals: Record<string, number | null>
  top: Array<{
    variantId: string
    excerpt: string
    handle: string
    remoteUrl: string | null
    engagementRate: number | null
    reach: number | null
    likes: number | null
  }>
}

type AccountRow = {
  accountId: string
  handle: string
  provider: string
  published: number
  impressions: number | null
  likes: number | null
}

const METRICS = ['impressions', 'reach', 'likes', 'comments', 'shares', 'clicks'] as const

export default async function AnalyticsPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>
}) {
  const { workspaceId } = await params
  const [overview, accounts] = await Promise.all([
    apiGet<Overview>(`/api/v1/analytics/overview?workspaceId=${workspaceId}&days=30`),
    apiGet<AccountRow[]>(`/api/v1/analytics/accounts?workspaceId=${workspaceId}&days=30`),
  ])

  if (!overview.ok) return <ErrorCard message={overview.message} requestId={overview.requestId} />

  return (
    <>
      <PageHeader title="Analytics" description={`Last ${overview.data.windowDays} days.`} />

      {overview.data.publishedCount === 0 ? (
        <EmptyState
          title="Nothing published yet"
          hint="Metrics start arriving about an hour after your first post goes out."
        />
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
            {METRICS.map((key) => (
              <Card key={key} className="p-3">
                <p className="text-lg font-semibold tabular-nums">
                  {/* A dash, not a zero. Null means the network never reported
                      this — claiming "0 impressions" would be a measurement
                      nobody took. */}
                  {overview.data.totals[key] == null
                    ? '—'
                    : overview.data.totals[key]!.toLocaleString()}
                </p>
                <p className="text-[11px] capitalize">
                  <Muted>{key}</Muted>
                </p>
              </Card>
            ))}
          </div>

          <p className="mt-2 text-xs">
            <Muted>
              {overview.data.measuredCount} of {overview.data.publishedCount} published posts have
              metrics so far. A dash means the network does not report that number.
            </Muted>
          </p>

          {overview.data.top.length > 0 && (
            <section className="mt-8">
              <h2 className="text-sm font-medium">Top posts</h2>
              <div className="mt-2 space-y-2">
                {overview.data.top.map((p) => (
                  <Card key={p.variantId} className="flex items-start justify-between gap-4 p-4">
                    <div className="min-w-0">
                      <p className="truncate text-sm">{p.excerpt}</p>
                      <p className="text-xs">
                        <Muted>{p.handle}</Muted>
                      </p>
                    </div>
                    <div className="shrink-0 text-right text-xs">
                      <p className="tabular-nums">
                        {p.engagementRate == null ? '—' : `${p.engagementRate}%`}
                      </p>
                      <p>
                        <Muted>engagement</Muted>
                      </p>
                    </div>
                  </Card>
                ))}
              </div>
            </section>
          )}

          <section className="mt-8">
            <h2 className="text-sm font-medium">By account</h2>
            <Card className="mt-2 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-muted-foreground">
                    <th className="px-4 py-2 text-left text-xs font-medium">Account</th>
                    <th className="px-4 py-2 text-right text-xs font-medium">Posts</th>
                    <th className="px-4 py-2 text-right text-xs font-medium">Impressions</th>
                    <th className="px-4 py-2 text-right text-xs font-medium">Likes</th>
                  </tr>
                </thead>
                <tbody>
                  {accounts.ok &&
                    accounts.data.map((a) => (
                      <tr key={a.accountId} className="border-t border-border">
                        <td className="px-4 py-2">{a.handle}</td>
                        <td className="px-4 py-2 text-right tabular-nums">{a.published}</td>
                        <td className="px-4 py-2 text-right tabular-nums">
                          {a.impressions == null ? '—' : a.impressions.toLocaleString()}
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums">
                          {a.likes == null ? '—' : a.likes.toLocaleString()}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </Card>
          </section>
        </>
      )}
    </>
  )
}
