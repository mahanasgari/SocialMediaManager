import Link from 'next/link'
import { AlertTriangle, ArrowRight, CalendarClock, Plug, Users } from 'lucide-react'
import { apiGet } from '@/lib/server-fetch'
import { getAccounts, getHealth, getMembers, getWorkspace } from '@/lib/api'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ErrorCard, PageHeader } from '@/components/ui'
import { cn } from '@/lib/cn'

type PostRow = {
  id: string
  status: string
  baseContent: string
  scheduledAt: string | null
  publishedAt: string | null
  summary: string
  variants: Array<{
    status: string
    lastError: string | null
    socialAccount: { handle: string }
  }>
}

export default async function Dashboard({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params
  const [workspace, accounts, members, health, posts] = await Promise.all([
    getWorkspace(workspaceId),
    getAccounts(workspaceId),
    getMembers(workspaceId),
    getHealth(),
    apiGet<{ items: PostRow[] }>(`/api/v1/posts?workspaceId=${workspaceId}`),
  ])

  if (!workspace.ok)
    return <ErrorCard message={workspace.message} requestId={workspace.requestId} />

  const needsAttention = accounts.ok
    ? accounts.data.filter((a) => a.status === 'NEEDS_REAUTH' || a.status === 'DISCONNECTED')
    : []

  const all = posts.ok ? posts.data.items : []
  const now = Date.now()

  const upcoming = all
    .filter((p) => p.status === 'SCHEDULED' && p.scheduledAt && Date.parse(p.scheduledAt) > now)
    .sort((a, b) => Date.parse(a.scheduledAt!) - Date.parse(b.scheduledAt!))
    .slice(0, 5)

  // Surfaced together because they need the same thing from a human: a
  // decision. Neither is auto-retried.
  const needsDecision = all.filter(
    (p) => p.status === 'FAILED' || p.status === 'MISSED' || p.status === 'NEEDS_REVIEW'
  )

  const activeAccounts = accounts.ok
    ? accounts.data.filter((a) => a.status === 'ACTIVE').length
    : null

  return (
    <>
      <PageHeader
        title={workspace.data.name}
        description={`${workspace.data.timezone} · you are ${article(workspace.data.role)} ${workspace.data.role.toLowerCase()}`}
        action={
          <Button asChild size="sm">
            <Link href={`/w/${workspaceId}/compose`}>Compose</Link>
          </Button>
        }
      />

      {/* Both banners come FIRST, before any statistic. A broken connection or a
          missed post silently stops publishing, and a number further down the
          page does not get looked at until someone already noticed. */}
      {needsAttention.length > 0 && (
        <Banner
          tone="warning"
          // The VERB agrees too. "1 account need reconnecting" is the classic
          // half-done pluralisation that only ever suffixes the noun.
          title={
            needsAttention.length === 1
              ? '1 account needs reconnecting'
              : `${needsAttention.length} accounts need reconnecting`
          }
          body={
            needsAttention[0]?.statusReason ??
            'Scheduled posts to these accounts will fail until they are reconnected.'
          }
          href={`/w/${workspaceId}/accounts`}
          cta="Review accounts"
        />
      )}

      {needsDecision.length > 0 && (
        <Banner
          tone="destructive"
          title={
            needsDecision.length === 1
              ? '1 post needs a decision'
              : `${needsDecision.length} posts need a decision`
          }
          body="Failed, missed, or held for review. None of these are retried automatically — the right action is editorial."
          href={`/w/${workspaceId}/posts`}
          cta="Open posts"
        />
      )}

      <div className="grid gap-3 sm:grid-cols-3">
        <StatCard
          icon={<Plug className="size-4" />}
          label="Connected accounts"
          value={activeAccounts}
          href={`/w/${workspaceId}/accounts`}
        />
        <StatCard
          icon={<CalendarClock className="size-4" />}
          label="Scheduled"
          value={all.filter((p) => p.status === 'SCHEDULED').length}
          href={`/w/${workspaceId}/calendar`}
        />
        <StatCard
          icon={<Users className="size-4" />}
          label="Team members"
          value={members.ok ? members.data.length : null}
          href={`/w/${workspaceId}/team`}
        />
      </div>

      <section className="mt-8">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-medium">Up next</h2>
          <Link
            href={`/w/${workspaceId}/calendar`}
            className="text-xs text-muted-foreground underline-offset-4 hover:underline"
          >
            Calendar
          </Link>
        </div>

        <Card>
          {upcoming.length === 0 ? (
            <CardContent className="p-6 text-center text-sm text-muted-foreground">
              Nothing scheduled.{' '}
              <Link href={`/w/${workspaceId}/compose`} className="text-primary hover:underline">
                Write something
              </Link>
              .
            </CardContent>
          ) : (
            <ul className="divide-y">
              {upcoming.map((post) => (
                <li key={post.id} className="flex items-center gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm">{post.baseContent}</p>
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">
                      {post.variants.map((v) => v.socialAccount.handle).join(', ')}
                    </p>
                  </div>
                  <time
                    className="shrink-0 text-xs text-muted-foreground"
                    dateTime={post.scheduledAt ?? undefined}
                  >
                    {when(post.scheduledAt)}
                  </time>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </section>

      <section className="mt-8">
        <h2 className="mb-2 text-sm font-medium">System</h2>
        <Card>
          <CardContent className="p-4">
            {health.ok ? (
              <ul className="space-y-2 text-sm">
                {health.data.dependencies.map((d) => (
                  <li key={d.name} className="flex items-center justify-between gap-3">
                    <span className="flex items-center gap-2">
                      <span
                        className={cn(
                          'size-1.5 rounded-full',
                          d.ok ? 'bg-success' : 'bg-destructive'
                        )}
                        aria-hidden
                      />
                      {d.name}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {d.ok ? 'ok' : 'unreachable'}
                      {typeof d.latencyMs === 'number' ? ` · ${d.latencyMs}ms` : ''}
                    </span>
                  </li>
                ))}
                <li className="flex items-center justify-between gap-3">
                  <span className="flex items-center gap-2">
                    <span
                      className={cn(
                        'size-1.5 rounded-full',
                        health.data.security.rowLevelSecurity === 'enforced'
                          ? 'bg-success'
                          : 'bg-destructive'
                      )}
                      aria-hidden
                    />
                    row-level security
                  </span>
                  {/* Shown because this is precisely the control that can look
                      correctly configured while being silently bypassed. */}
                  <Badge
                    variant={
                      health.data.security.rowLevelSecurity === 'enforced'
                        ? 'success'
                        : 'destructive'
                    }
                  >
                    {health.data.security.rowLevelSecurity}
                  </Badge>
                </li>
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">{health.message}</p>
            )}
          </CardContent>
        </Card>
      </section>
    </>
  )
}

function Banner({
  tone,
  title,
  body,
  href,
  cta,
}: {
  tone: 'warning' | 'destructive'
  title: string
  body: string
  href: string
  cta: string
}) {
  return (
    <Card
      className={cn(
        'mb-4',
        tone === 'warning'
          ? 'border-warning/30 bg-warning/5'
          : 'border-destructive/30 bg-destructive/5'
      )}
    >
      <CardContent className="flex flex-wrap items-start gap-3 p-4">
        <AlertTriangle
          className={cn(
            'mt-0.5 size-4 shrink-0',
            tone === 'warning' ? 'text-warning' : 'text-destructive'
          )}
        />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{title}</p>
          <p className="mt-0.5 text-sm text-muted-foreground">{body}</p>
        </div>
        <Button asChild variant="outline" size="sm">
          <Link href={href}>
            {cta}
            <ArrowRight />
          </Link>
        </Button>
      </CardContent>
    </Card>
  )
}

/**
 * `null` renders an em dash, never a zero.
 *
 * The count is unknown when its request failed, and "0 connected accounts" for
 * a workspace with six of them is worse than admitting we could not tell.
 */
function StatCard({
  icon,
  label,
  value,
  href,
}: {
  icon: React.ReactNode
  label: string
  value: number | null
  href: string
}) {
  return (
    <Link href={href} className="group rounded-lg focus-visible:outline-none">
      <Card className="transition-colors group-hover:border-primary/40">
        <CardContent className="p-4">
          <div className="flex items-center gap-2 text-muted-foreground">
            {icon}
            <span className="text-xs font-medium">{label}</span>
          </div>
          <p className="tabular mt-2 text-2xl font-semibold tracking-tight">
            {value === null ? '—' : value}
          </p>
        </CardContent>
      </Card>
    </Link>
  )
}

/** Relative for anything within a week; an absolute date after that. */
function when(iso: string | null): string {
  if (!iso) return ''
  const diff = Date.parse(iso) - Date.now()
  const minutes = Math.round(diff / 60_000)
  if (minutes < 60) return `in ${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `in ${hours}h`
  const days = Math.round(hours / 24)
  if (days < 7) return `in ${days}d`
  return new Date(iso).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  })
}

function article(role: string): string {
  return /^[AEIOU]/.test(role) ? 'an' : 'a'
}
