import { apiGet } from '@/lib/server-fetch'
import { getWorkspace } from '@/lib/api'
import { Badge, Card, EmptyState, ErrorCard, Muted, PageHeader } from '@/components/ui'
import { DecideButtons } from './decide.client'

type ApprovalRow = {
  id: string
  mode: 'ANY' | 'ALL'
  note: string | null
  createdAt: string
  awaitingYou: boolean
  post: { id: string; baseContent: string; scheduledAt: string | null }
  steps: Array<{
    approverId: string
    decision: 'PENDING' | 'APPROVED' | 'CHANGES_REQUESTED'
    note: string | null
    decidedAt: string | null
  }>
}

export default async function ApprovalsPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>
}) {
  const { workspaceId } = await params
  const [workspace, queue] = await Promise.all([
    getWorkspace(workspaceId),
    apiGet<ApprovalRow[]>(`/api/v1/approvals?workspaceId=${workspaceId}`),
  ])

  if (!workspace.ok)
    return <ErrorCard message={workspace.message} requestId={workspace.requestId} />
  if (!queue.ok) return <ErrorCard message={queue.message} requestId={queue.requestId} />

  const canApprove = workspace.data.permissions.includes('content.approve')
  // Yours first: a queue that buries the thing waiting on you under everything
  // waiting on everyone is a queue people stop opening.
  const sorted = [...queue.data].sort((a, b) => Number(b.awaitingYou) - Number(a.awaitingYou))

  return (
    <>
      <PageHeader title="Approvals" description="Posts waiting for a decision." />

      {sorted.length === 0 ? (
        <EmptyState title="Nothing waiting" hint="Submitted drafts appear here for review." />
      ) : (
        <div className="space-y-2">
          {sorted.map((a) => {
            const decided = a.steps.filter((s) => s.decision !== 'PENDING').length
            return (
              <Card key={a.id} className="p-4">
                <div className="flex items-start justify-between gap-4">
                  <p className="min-w-0 flex-1 whitespace-pre-wrap text-sm">
                    {a.post.baseContent.slice(0, 280)}
                    {a.post.baseContent.length > 280 && '…'}
                  </p>
                  {a.awaitingYou && <Badge tone="accent">needs you</Badge>}
                </div>

                {a.note && (
                  <p className="mt-2 text-xs">
                    <Muted>“{a.note}”</Muted>
                  </p>
                )}

                <p className="mt-2 text-xs">
                  <Muted>
                    {decided} of {a.steps.length} approvers have decided
                    {a.mode === 'ALL' ? ' · everyone must approve' : ' · any one can approve'}
                    {a.post.scheduledAt
                      ? ` · scheduled ${new Date(a.post.scheduledAt).toLocaleString()}`
                      : ''}
                  </Muted>
                </p>

                {canApprove && a.awaitingYou && (
                  <div className="mt-3">
                    <DecideButtons workspaceId={workspaceId} postId={a.post.id} />
                  </div>
                )}
              </Card>
            )
          })}
        </div>
      )}
    </>
  )
}
