import { apiGet } from '@/lib/server-fetch'
import { Card, ErrorCard, Muted, PageHeader, formatBytes } from '@/components/ui'
import { DeleteMedia, Uploader, type MediaRow } from './uploader.client'

export default async function MediaPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params
  const media = await apiGet<MediaRow[]>(`/api/v1/media?workspaceId=${workspaceId}`)

  return (
    <>
      <PageHeader title="Media" description="Images and video available to your posts." />

      <Uploader workspaceId={workspaceId} />

      {!media.ok ? (
        <div className="mt-4">
          <ErrorCard message={media.message} requestId={media.requestId} />
        </div>
      ) : media.data.length === 0 ? (
        <p className="mt-6 text-sm">
          <Muted>Nothing uploaded yet.</Muted>
        </p>
      ) : (
        <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {media.data.map((m) => (
            <Card key={m.id} className="p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{m.filename}</p>
                  <p className="text-xs">
                    <Muted>
                      {m.mime.replace(/^(image|video)\//, '')}
                      {m.width && m.height ? ` · ${m.width}×${m.height}` : ''} ·{' '}
                      {formatBytes(m.bytes)}
                    </Muted>
                  </p>
                </div>
                <DeleteMedia workspaceId={workspaceId} mediaId={m.id} />
              </div>
              {m.altText && (
                <p className="mt-2 text-xs">
                  <Muted>{m.altText}</Muted>
                </p>
              )}
            </Card>
          ))}
        </div>
      )}
    </>
  )
}
