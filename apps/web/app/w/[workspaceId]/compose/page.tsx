import Link from 'next/link'
import { getAccounts, getMedia, getWorkspace } from '@/lib/api'
import { EmptyState, ErrorCard, PageHeader } from '@/components/ui'
import { Composer } from './composer.client'

export default async function ComposePage({
  params,
}: {
  params: Promise<{ workspaceId: string }>
}) {
  const { workspaceId } = await params
  const [workspace, accounts, media] = await Promise.all([
    getWorkspace(workspaceId),
    getAccounts(workspaceId),
    getMedia(workspaceId),
  ])

  if (!workspace.ok)
    return <ErrorCard message={workspace.message} requestId={workspace.requestId} />
  if (!accounts.ok) return <ErrorCard message={accounts.message} requestId={accounts.requestId} />

  const publishable = accounts.data.filter((a) => a.status === 'ACTIVE')

  return (
    <>
      <PageHeader title="Compose" description="Write once, publish to several channels." />

      {publishable.length === 0 ? (
        <EmptyState
          title="No channels to publish to"
          hint="Connect an account first. The mock provider needs no credentials and behaves like a real one, including failures."
          action={
            <Link href={`/w/${workspaceId}/accounts`} className="text-sm underline text-primary">
              Connect an account
            </Link>
          }
        />
      ) : (
        <Composer
          workspaceId={workspaceId}
          accounts={publishable}
          media={media.ok ? media.data : []}
        />
      )}
    </>
  )
}
