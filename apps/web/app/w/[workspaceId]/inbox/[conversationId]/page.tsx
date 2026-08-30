import Link from 'next/link'
import { apiGet } from '@/lib/server-fetch'
import { getWorkspace } from '@/lib/api'
import { Badge, Card, ErrorCard, Muted, PageHeader } from '@/components/ui'
import { ReplyBox } from './reply.client'
import { ConversationActions } from './actions.client'

type Conversation = {
  id: string
  kind: 'COMMENT_THREAD' | 'DM' | 'MENTION'
  status: 'OPEN' | 'SNOOZED' | 'ARCHIVED'
  subjectHandle: string
  assigneeId: string | null
  socialAccount: { id: string; handle: string; provider: string }
  messages: Array<{
    id: string
    direction: string
    authorHandle: string
    body: string
    providerCreatedAt: string
  }>
}

type ProviderDescriptor = {
  id: string
  label: string
  capabilities: Record<string, boolean>
}

export default async function ConversationPage({
  params,
}: {
  params: Promise<{ workspaceId: string; conversationId: string }>
}) {
  const { workspaceId, conversationId } = await params

  const [workspace, conversation, providers] = await Promise.all([
    getWorkspace(workspaceId),
    apiGet<Conversation>(
      `/api/v1/inbox/conversations/${conversationId}?workspaceId=${workspaceId}`
    ),
    apiGet<ProviderDescriptor[]>('/api/v1/social-providers'),
  ])

  if (!workspace.ok)
    return <ErrorCard message={workspace.message} requestId={workspace.requestId} />
  if (!conversation.ok) {
    return <ErrorCard message={conversation.message} requestId={conversation.requestId} />
  }

  const thread = conversation.data
  const canReply = workspace.data.permissions.includes('inbox.reply')
  const canManage = workspace.data.permissions.includes('inbox.manage')

  // Whether replying is POSSIBLE is a property of the provider, and it is read
  // from the live capability matrix rather than assumed. A reply box on a
  // provider that cannot send one is exactly the dead button the quality bar
  // rules out.
  const provider = providers.ok
    ? providers.data.find((p) => p.id === thread.socialAccount.provider)
    : undefined
  const capability = thread.kind === 'DM' ? 'dm' : 'replies'
  const providerSupportsReply = provider?.capabilities[capability] === true

  return (
    <>
      <div className="mb-2">
        <Link href={`/w/${workspaceId}/inbox`} className="text-xs underline">
          <Muted>← Back to inbox</Muted>
        </Link>
      </div>

      <PageHeader
        title={thread.subjectHandle}
        description={`${thread.socialAccount.handle} · ${thread.socialAccount.provider}`}
      />

      <div className="mb-4 flex items-center gap-2">
        <Badge>{thread.kind === 'DM' ? 'Message' : 'Comment'}</Badge>
        <Badge tone={thread.status === 'OPEN' ? 'accent' : 'neutral'}>
          {thread.status.charAt(0) + thread.status.slice(1).toLowerCase()}
        </Badge>
        {canManage && (
          <ConversationActions
            workspaceId={workspaceId}
            conversationId={thread.id}
            status={thread.status}
          />
        )}
      </div>

      <div className="space-y-2">
        {thread.messages.map((message) => {
          const outgoing = message.direction === 'OUT'
          return (
            <Card
              key={message.id}
              className="p-3.5"
              // Outgoing messages are indented and tinted. Direction is the
              // first thing you need to read in a thread, and colour carries it
              // faster than a label does.
              style={
                outgoing
                  ? {
                      marginLeft: '2rem',
                      background: 'hsl(var(--primary) / 0.06)',
                    }
                  : { marginRight: '2rem' }
              }
            >
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-xs font-medium">
                  {outgoing ? 'You' : message.authorHandle}
                </span>
                <span className="text-xs">
                  <Muted>{new Date(message.providerCreatedAt).toLocaleString()}</Muted>
                </span>
              </div>
              <p className="mt-1.5 whitespace-pre-wrap text-sm">{message.body || '(no text)'}</p>
            </Card>
          )
        })}
      </div>

      <div className="mt-4">
        {!canReply ? (
          <Card className="p-3.5">
            <p className="text-sm">
              <Muted>Your role can read this conversation but not reply to it.</Muted>
            </p>
          </Card>
        ) : !providerSupportsReply ? (
          <Card className="p-3.5">
            <p className="text-sm">
              <Muted>
                {provider?.label ?? thread.socialAccount.provider} does not support replying through
                its API. Open the conversation on {provider?.label ?? 'the platform'} to respond.
              </Muted>
            </p>
          </Card>
        ) : (
          <ReplyBox workspaceId={workspaceId} conversationId={thread.id} />
        )}
      </div>
    </>
  )
}
