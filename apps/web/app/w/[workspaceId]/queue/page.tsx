import { apiGet } from '@/lib/server-fetch'
import { ErrorCard, PageHeader } from '@/components/ui'
import { QueueEditor, type QueueData } from './queue.client'

/**
 * The posting queue.
 *
 * Its own page rather than a settings section: this is something a person
 * revisits and reasons about, not something they set once and forget. It sits
 * next to the calendar in the sidebar because they answer the same question
 * from two directions — the calendar shows what is going out, this shows when
 * anything new will.
 */
export default async function QueuePage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params
  const queue = await apiGet<QueueData>(`/api/v1/posting-slots?workspaceId=${workspaceId}`)

  return (
    <>
      <PageHeader
        title="Posting queue"
        description="The times this workspace publishes. New posts take the next free one."
      />
      {queue.ok ? (
        <QueueEditor workspaceId={workspaceId} data={queue.data} />
      ) : (
        <ErrorCard message={queue.message} requestId={queue.requestId} />
      )}
    </>
  )
}
