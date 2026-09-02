import Link from 'next/link'
import { getAccounts, getMedia, getWorkspace } from '@/lib/api'
import { apiGet } from '@/lib/server-fetch'
import { EmptyState, ErrorCard, PageHeader } from '@/components/ui'
import { Composer } from './composer.client'

type ProviderRow = {
  id: string
  postOptionFields?: {
    name: string
    label: string
    hint?: string
    placeholder?: string
    required?: boolean
  }[]
}

export default async function ComposePage({
  params,
}: {
  params: Promise<{ workspaceId: string }>
}) {
  const { workspaceId } = await params
  const [workspace, accounts, media, providers] = await Promise.all([
    getWorkspace(workspaceId),
    getAccounts(workspaceId),
    getMedia(workspaceId),
    // What each provider needs collected PER POST. Served by the API rather
    // than hard-coded here, for the same reason the capability matrix is: a
    // field list that lives in the browser drifts from the adapter that
    // consumes it, and the symptom is a post the composer accepted and the
    // worker refused.
    apiGet<ProviderRow[]>('/api/v1/social-providers'),
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
          optionFields={
            providers.ok
              ? Object.fromEntries(
                  providers.data.map((p) => [p.id, p.postOptionFields ?? []])
                )
              : {}
          }
        />
      )}
    </>
  )
}
