import Link from 'next/link'
import { apiGet } from '@/lib/server-fetch'
import { getWorkspace } from '@/lib/api'
import { Badge, Card, ErrorCard, Muted, PageHeader } from '@/components/ui'

type Overview = {
  generatedAt: string
  scheduler: {
    scheduled: number
    queued: number
    publishing: number
    overdue: number
    oldestOverdueSeconds: number | null
    failed: number
    missed: number
    needsReview: number
    healthy: boolean
  }
  inbound: {
    received: number
    unrouted: number
    pending: number
    failed: number
    recentUnrouted: Array<{
      id: string
      provider: string
      providerAccountId: string | null
      receivedAt: string
    }>
  }
  delivery: {
    total: number
    disabled: number
    failing: number
    undelivered: number
  }
  accounts: {
    total: number
    active: number
    disconnected: number
    needsReauth: number
    expiringSoon: Array<{
      id: string
      handle: string
      provider: string
      expiresAt: string | null
      daysLeft: number | null
    }>
  }
  feeds: { total: number; paused: number; stalled: number }
  providers: {
    implemented: number
    skeleton: number
    configured: number
    unconfigured: Array<{ id: string; label: string; reason: string | null }>
  }
}

export default async function AdminPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params
  const workspace = await getWorkspace(workspaceId)
  if (!workspace.ok)
    return <ErrorCard message={workspace.message} requestId={workspace.requestId} />

  const overview = await apiGet<Overview>(
    `/api/v1/admin/overview?organizationId=${workspace.data.organizationId}`
  )

  // A 404 here means "you are not an organization admin" — the API returns the
  // same shape for that as for an organization that does not exist, and the UI
  // must not leak the difference either.
  if (!overview.ok) {
    return (
      <>
        <PageHeader title="Administration" description="Operational health of this installation." />
        <Card className="p-5">
          <p className="text-sm">
            <Muted>
              This page is for organization owners and administrators. Your role does not include
              it.
            </Muted>
          </p>
        </Card>
      </>
    )
  }

  const o = overview.data

  return (
    <>
      <PageHeader
        title="Administration"
        description="Whether this installation is actually working."
      />

      <div className="space-y-6">
        <Section
          title="Scheduler"
          state={o.scheduler.healthy ? 'ok' : 'attention'}
          note={
            o.scheduler.healthy
              ? 'Publishing on time.'
              : `Oldest overdue post has been waiting ${formatDuration(o.scheduler.oldestOverdueSeconds)}. ` +
                'Check that the worker process is running.'
          }
        >
          <Stat label="Scheduled" value={o.scheduler.scheduled} />
          <Stat label="Queued" value={o.scheduler.queued} />
          <Stat label="In flight" value={o.scheduler.publishing} />
          <Stat
            label="Overdue"
            value={o.scheduler.overdue}
            alarm={!o.scheduler.healthy}
            hint="Past their time and still unpublished."
          />
          <Stat label="Failed" value={o.scheduler.failed} alarm={o.scheduler.failed > 0} />
          <Stat
            label="Missed"
            value={o.scheduler.missed}
            alarm={o.scheduler.missed > 0}
            hint="Past the catch-up window. Needs a human decision."
          />
          <Stat
            label="Needs review"
            value={o.scheduler.needsReview}
            alarm={o.scheduler.needsReview > 0}
            hint="Possible duplicate. Never auto-retried."
          />
        </Section>

        <Section
          title="Inbound events"
          state={o.inbound.unrouted > 0 || o.inbound.failed > 0 ? 'attention' : 'ok'}
          note={
            o.inbound.unrouted > 0
              ? 'Events arrived for accounts nobody has connected. They are dropped, never guessed at — ' +
                'a sustained rise usually means a stale subscription somewhere.'
              : 'Everything received in the last day was routed.'
          }
        >
          <Stat label="Received (24h)" value={o.inbound.received} />
          <Stat label="Unrouted (24h)" value={o.inbound.unrouted} alarm={o.inbound.unrouted > 0} />
          <Stat label="Awaiting dispatch" value={o.inbound.pending} />
          <Stat label="Dispatch failed" value={o.inbound.failed} alarm={o.inbound.failed > 0} />
        </Section>

        {o.inbound.recentUnrouted.length > 0 && (
          <Card className="p-4">
            <p className="text-xs font-medium">
              <Muted>Most recent unrouted events</Muted>
            </p>
            {o.inbound.recentUnrouted.map((e) => (
              <div key={e.id} className="flex justify-between gap-3 py-0.5 text-xs">
                <span>
                  <Muted>
                    {e.provider} · {e.providerAccountId ?? 'no account id in payload'}
                  </Muted>
                </span>
                <span className="shrink-0">
                  <Muted>{new Date(e.receivedAt).toLocaleString()}</Muted>
                </span>
              </div>
            ))}
          </Card>
        )}

        <Section
          title="Outbound webhooks"
          state={o.delivery.disabled > 0 || o.delivery.failing > 0 ? 'attention' : 'ok'}
          note={
            o.delivery.disabled > 0
              ? 'A disabled webhook sends nothing and reports nothing. Fix the endpoint, then re-enable it.'
              : 'No delivery problems.'
          }
        >
          <Stat label="Configured" value={o.delivery.total} />
          <Stat label="Failing" value={o.delivery.failing} alarm={o.delivery.failing > 0} />
          <Stat label="Auto-disabled" value={o.delivery.disabled} alarm={o.delivery.disabled > 0} />
          <Stat label="Undelivered" value={o.delivery.undelivered} />
        </Section>

        <Section
          title="Connected accounts"
          state={
            o.accounts.needsReauth > 0 || o.accounts.expiringSoon.length > 0 ? 'attention' : 'ok'
          }
          note={
            o.accounts.expiringSoon.length > 0
              ? 'A token expiring this week is a scheduled post that fails next week. Now is the cheap moment to fix it.'
              : 'All connected accounts are usable.'
          }
        >
          <Stat label="Active" value={o.accounts.active} />
          <Stat
            label="Needs reconnecting"
            value={o.accounts.needsReauth}
            alarm={o.accounts.needsReauth > 0}
          />
          <Stat label="Disconnected" value={o.accounts.disconnected} />
          <Stat
            label="Expiring in 7 days"
            value={o.accounts.expiringSoon.length}
            alarm={o.accounts.expiringSoon.length > 0}
          />
        </Section>

        {o.accounts.expiringSoon.length > 0 && (
          <Card className="p-4">
            <p className="text-xs font-medium">
              <Muted>Expiring credentials</Muted>
            </p>
            {o.accounts.expiringSoon.map((a) => (
              <div key={a.id} className="flex justify-between gap-3 py-0.5 text-xs">
                <span>
                  {a.handle} <Muted>({a.provider})</Muted>
                </span>
                <span className="shrink-0 text-destructive">
                  {a.daysLeft === null
                    ? 'unknown'
                    : a.daysLeft < 0
                      ? `expired ${Math.abs(a.daysLeft)}d ago`
                      : `${a.daysLeft}d left`}
                </span>
              </div>
            ))}
          </Card>
        )}

        <Section
          title="RSS feeds"
          state={o.feeds.stalled > 0 ? 'attention' : 'ok'}
          note={
            o.feeds.stalled > 0
              ? 'A stalled feed is being retried and failing every time, silently. Check the address.'
              : 'All feeds are fetching.'
          }
        >
          <Stat label="Feeds" value={o.feeds.total} />
          <Stat label="Paused" value={o.feeds.paused} />
          <Stat label="Stalled" value={o.feeds.stalled} alarm={o.feeds.stalled > 0} />
        </Section>

        <Section
          title="Connectors"
          state={o.providers.unconfigured.length > 0 ? 'attention' : 'ok'}
          note={
            o.providers.unconfigured.length > 0
              ? 'These are built but missing credentials — a problem you can fix, unlike a connector that is not written yet.'
              : 'Every implemented connector has what it needs.'
          }
        >
          <Stat label="Implemented" value={o.providers.implemented} />
          <Stat label="Ready to use" value={o.providers.configured} />
          <Stat
            label="Not built yet"
            value={o.providers.skeleton}
            hint="Documented and disabled."
          />
        </Section>

        {o.providers.unconfigured.length > 0 && (
          <Card className="p-4">
            <p className="text-xs font-medium">
              <Muted>Implemented but unconfigured</Muted>
            </p>
            {o.providers.unconfigured.map((p) => (
              <div key={p.id} className="py-0.5 text-xs">
                {p.label} — <Muted>{p.reason ?? 'missing credentials'}</Muted>
              </div>
            ))}
          </Card>
        )}
      </div>

      <p className="mt-6 text-xs">
        <Muted>
          Generated {new Date(o.generatedAt).toLocaleString()}.{' '}
          <Link href={`/w/${workspaceId}/admin`} className="underline">
            Refresh
          </Link>
        </Muted>
      </p>
    </>
  )
}

function Section({
  title,
  state,
  note,
  children,
}: {
  title: string
  state: 'ok' | 'attention'
  note: string
  children: React.ReactNode
}) {
  return (
    <section>
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-semibold">{title}</h2>
        {/* A judgement, not just numbers. An operator view exists to say
            whether something needs attention. */}
        {state === 'attention' ? (
          <Badge tone="warn">needs attention</Badge>
        ) : (
          <Badge>healthy</Badge>
        )}
      </div>
      <p className="mt-0.5 text-xs">
        <Muted>{note}</Muted>
      </p>
      <Card className="mt-2 p-4">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">{children}</div>
      </Card>
    </section>
  )
}

function Stat({
  label,
  value,
  hint,
  alarm,
}: {
  label: string
  value: number
  hint?: string
  alarm?: boolean
}) {
  return (
    <div>
      <p
        className="text-xl font-semibold tabular-nums"
        style={alarm ? { color: 'hsl(var(--destructive))' } : undefined}
      >
        {value}
      </p>
      <p className="text-xs font-medium">{label}</p>
      {hint && (
        <p className="mt-0.5 text-xs">
          <Muted>{hint}</Muted>
        </p>
      )}
    </div>
  )
}

function formatDuration(seconds: number | null): string {
  if (seconds === null) return 'no time'
  if (seconds < 90) return `${seconds} seconds`
  if (seconds < 5400) return `${Math.round(seconds / 60)} minutes`
  return `${Math.round(seconds / 3600)} hours`
}
