import Link from 'next/link'
import { apiGet } from '@/lib/server-fetch'
import { getWorkspace } from '@/lib/api'
import { Badge, Card, EmptyState, ErrorCard, Muted, PageHeader } from '@/components/ui'

type ConversationRow = {
  id: string
  kind: 'COMMENT_THREAD' | 'DM' | 'MENTION'
  status: 'OPEN' | 'SNOOZED' | 'ARCHIVED'
  subjectHandle: string
  unreadCount: number
  lastMessageAt: string
  assigneeId: string | null
  socialAccount: { handle: string; provider: string }
  messages: Array<{ body: string; direction: string; authorHandle: string }>
}

const KIND_LABEL: Record<ConversationRow['kind'], string> = {
  COMMENT_THREAD: 'Comment',
  DM: 'Message',
  MENTION: 'Mention',
}

export default async function InboxPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>
  searchParams: Promise<{ status?: string; kind?: string }>
}) {
  const { workspaceId } = await params
  const filters = await searchParams
  const status = filters.status ?? 'OPEN'

  const query = new URLSearchParams({ workspaceId, status })
  if (filters.kind) query.set('kind', filters.kind)

  const [workspace, conversations] = await Promise.all([
    getWorkspace(workspaceId),
    apiGet<ConversationRow[]>(`/api/v1/inbox/conversations?${query.toString()}`),
  ])

  if (!workspace.ok)
    return <ErrorCard message={workspace.message} requestId={workspace.requestId} />
  if (!conversations.ok) {
    return <ErrorCard message={conversations.message} requestId={conversations.requestId} />
  }

  const base = `/w/${workspaceId}/inbox`

  return (
    <>
      <PageHeader
        title="Inbox"
        description="Comments and messages from every connected account, in one place."
      />

      <div className="mb-4 flex flex-wrap gap-2">
        {(['OPEN', 'SNOOZED', 'ARCHIVED'] as const).map((s) => (
          <Link
            key={s}
            href={`${base}?status=${s}${filters.kind ? `&kind=${filters.kind}` : ''}`}
            className="rounded px-2.5 py-1 text-xs transition-colors"
            style={
              status === s
                ? {
                    background: 'hsl(var(--primary) / 0.12)',
                    color: 'hsl(var(--primary))',
                  }
                : {
                    color: 'hsl(var(--muted-foreground))',
                    background: 'hsl(var(--muted-foreground) / 0.08)',
                  }
            }
          >
            {s.charAt(0) + s.slice(1).toLowerCase()}
          </Link>
        ))}

        <span className="mx-1 w-px bg-border" />

        {(['COMMENT_THREAD', 'DM', 'MENTION'] as const).map((k) => (
          <Link
            key={k}
            href={`${base}?status=${status}${filters.kind === k ? '' : `&kind=${k}`}`}
            className="rounded px-2.5 py-1 text-xs transition-colors"
            style={
              filters.kind === k
                ? {
                    background: 'hsl(var(--primary) / 0.12)',
                    color: 'hsl(var(--primary))',
                  }
                : {
                    color: 'hsl(var(--muted-foreground))',
                    background: 'hsl(var(--muted-foreground) / 0.08)',
                  }
            }
          >
            {KIND_LABEL[k]}s
          </Link>
        ))}
      </div>

      {conversations.data.length === 0 ? (
        <EmptyState
          title={status === 'OPEN' ? 'Nothing waiting' : `No ${status.toLowerCase()} conversations`}
          hint={
            status === 'OPEN'
              ? 'Comments and messages appear here once a connected account receives them. ' +
                'Delivery needs an inbound webhook configured for that provider.'
              : `Conversations you ${status === 'SNOOZED' ? 'snooze' : 'archive'} appear here.`
          }
        />
      ) : (
        <div className="space-y-1.5">
          {conversations.data.map((c) => {
            const latest = c.messages[0]
            return (
              <Link key={c.id} href={`${base}/${c.id}`} className="block">
                <Card className="p-3.5 transition-colors hover:border-[hsl(var(--primary)/0.4)]">
                  <div className="flex items-baseline justify-between gap-3">
                    <p className="truncate text-sm font-medium">
                      {c.subjectHandle}
                      {/* Unread count sits on the handle, where the eye already
                          is, rather than in a far-right column nobody scans. */}
                      {c.unreadCount > 0 && (
                        <span className="ml-2 align-middle">
                          <Badge tone="accent">{c.unreadCount} new</Badge>
                        </span>
                      )}
                    </p>
                    <span className="shrink-0 text-xs">
                      <Muted>{relative(c.lastMessageAt)}</Muted>
                    </span>
                  </div>

                  {latest && (
                    <p className="mt-1 truncate text-sm">
                      <Muted>
                        {latest.direction === 'OUT' && 'You: '}
                        {latest.body || '(no text)'}
                      </Muted>
                    </p>
                  )}

                  <div className="mt-2 flex items-center gap-2 text-xs">
                    <Badge>{KIND_LABEL[c.kind]}</Badge>
                    <Muted>
                      {c.socialAccount.handle} · {c.socialAccount.provider}
                    </Muted>
                  </div>
                </Card>
              </Link>
            )
          })}
        </div>
      )}
    </>
  )
}

/**
 * Relative time, rendered on the server.
 *
 * Deliberately coarse — "3h" not "3 hours 14 minutes" — because in a list the
 * only question is how stale something is. Absolute timestamps live in the
 * thread view, where the exact moment starts to matter.
 */
function relative(iso: string): string {
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (seconds < 60) return 'now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`
  if (seconds < 604_800) return `${Math.floor(seconds / 86_400)}d`
  return new Date(iso).toLocaleDateString()
}
