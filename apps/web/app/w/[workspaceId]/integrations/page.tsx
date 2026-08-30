import { apiGet } from '@/lib/server-fetch'
import { getAccounts, getWorkspace } from '@/lib/api'
import { EmptyState, ErrorCard, Muted, PageHeader } from '@/components/ui'
import { WebhookManager } from './webhooks.client'
import { FeedManager } from './feeds.client'

type Webhook = {
  id: string
  url: string
  events: string[]
  enabled: boolean
  consecutiveFailures: number
  disabledAt: string | null
  createdAt: string
  deliveries: Array<{
    id: string
    eventType: string
    attempt: number
    responseStatus: number | null
    deliveredAt: string | null
    createdAt: string
  }>
}

type Feed = {
  id: string
  url: string
  name: string
  template: string
  targetAccountIds: string[]
  autoPublish: boolean
  lastFetchedAt: string | null
  pausedAt: string | null
  items: Array<{
    id: string
    title: string
    link: string
    postId: string | null
    createdAt: string
  }>
}

type EventType = { type: string; description: string }

export default async function IntegrationsPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>
}) {
  const { workspaceId } = await params

  const [workspace, webhooks, feeds, eventTypes, accounts] = await Promise.all([
    getWorkspace(workspaceId),
    apiGet<Webhook[]>(`/api/v1/webhooks?workspaceId=${workspaceId}`),
    apiGet<Feed[]>(`/api/v1/rss-feeds?workspaceId=${workspaceId}`),
    apiGet<EventType[]>('/api/v1/integrations/event-types'),
    getAccounts(workspaceId),
  ])

  if (!workspace.ok)
    return <ErrorCard message={workspace.message} requestId={workspace.requestId} />

  const canManage = workspace.data.permissions.includes('integrations.manage')

  return (
    <>
      <PageHeader
        title="Integrations"
        description="Send events to your own systems, and turn feeds into drafts."
      />

      <section>
        <h2 className="text-sm font-semibold">Outbound webhooks</h2>
        <p className="mt-0.5 text-xs">
          <Muted>
            Signed with HMAC-SHA256 over <code>{'`${timestamp}.${rawBody}`'}</code>, sent as{' '}
            <code>x-smm-signature</code>. Delivery is at-least-once, so your handler must be
            idempotent — a repeated event id is normal traffic, not an error.
          </Muted>
        </p>

        <div className="mt-3">
          {!webhooks.ok ? (
            <ErrorCard message={webhooks.message} requestId={webhooks.requestId} />
          ) : (
            <WebhookManager
              workspaceId={workspaceId}
              webhooks={webhooks.data}
              eventTypes={eventTypes.ok ? eventTypes.data : []}
              canManage={canManage}
            />
          )}
        </div>
      </section>

      <section className="mt-8">
        <h2 className="text-sm font-semibold">RSS feeds</h2>
        <p className="mt-0.5 text-xs">
          <Muted>
            New items become <strong>drafts</strong> unless you turn on auto-publish. Publishing
            automatically from a feed you do not control is how someone else&apos;s headline ends up
            on your brand account.
          </Muted>
        </p>

        <div className="mt-3">
          {!feeds.ok ? (
            <ErrorCard message={feeds.message} requestId={feeds.requestId} />
          ) : (
            <FeedManager
              workspaceId={workspaceId}
              feeds={feeds.data}
              accounts={
                accounts.ok ? accounts.data.map((a) => ({ id: a.id, handle: a.handle })) : []
              }
              canManage={canManage}
            />
          )}
        </div>
      </section>

      {!canManage && (
        <div className="mt-6">
          <EmptyState
            title="Read-only"
            hint="Your role can see integrations but not change them. An admin or manager can."
          />
        </div>
      )}
    </>
  )
}
