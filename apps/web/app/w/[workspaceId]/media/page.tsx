import Link from 'next/link'
import { apiGet } from '@/lib/server-fetch'
import { Card, ErrorCard, Muted, PageHeader, formatBytes } from '@/components/ui'
import { Button } from '@/components/ui/button'
import { DeleteMedia, Uploader, type MediaRow } from './uploader.client'

type MediaResponse = { items: MediaRow[]; nextCursor: string | null }

export default async function MediaPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>
  searchParams: Promise<{ cursor?: string }>
}) {
  const { workspaceId } = await params
  const { cursor } = await searchParams

  const media = await apiGet<MediaResponse>(
    `/api/v1/media?workspaceId=${workspaceId}${cursor ? `&cursor=${cursor}` : ''}`
  )

  return (
    <>
      <PageHeader title="Media" description="Images and video available to your posts." />

      <Uploader workspaceId={workspaceId} />

      {!media.ok ? (
        <div className="mt-4">
          <ErrorCard message={media.message} requestId={media.requestId} />
        </div>
      ) : media.data.items.length === 0 ? (
        <p className="mt-6 text-sm">
          <Muted>{cursor ? 'Nothing further back.' : 'Nothing uploaded yet.'}</Muted>
        </p>
      ) : (
        <>
          <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {media.data.items.map((m) => (
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

          {/* Same door the posts list has. A library that stops at one page with
              nothing on screen saying so is a silent truncation, and a media
              library is exactly where a workspace accumulates hundreds of rows. */}
          {media.data.nextCursor && (
            <div className="mt-4 flex justify-center">
              <Button asChild variant="outline" size="sm">
                <Link href={`/w/${workspaceId}/media?cursor=${media.data.nextCursor}`}>
                  Older uploads
                </Link>
              </Button>
            </div>
          )}

          {cursor && (
            <div className="mt-3 flex justify-center">
              <Link
                href={`/w/${workspaceId}/media`}
                className="text-xs text-muted-foreground underline underline-offset-2"
              >
                Back to newest
              </Link>
            </div>
          )}
        </>
      )}
    </>
  )
}
