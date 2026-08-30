import { apiGet } from '@/lib/server-fetch'
import { Badge, Card, EmptyState, ErrorCard, Muted, PageHeader } from '@/components/ui'
import { CreatePage, PublishToggle, AddLink, RemoveLink } from './links.client'

type LinkPage = {
  id: string
  slug: string
  title: string
  bio: string | null
  published: boolean
  views: number
  links: Array<{
    id: string
    label: string
    url: string
    clicks: number
    enabled: boolean
    position: number
  }>
}

export default async function LinksPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params
  const pages = await apiGet<LinkPage[]>(`/api/v1/link-pages?workspaceId=${workspaceId}`)

  if (!pages.ok) return <ErrorCard message={pages.message} requestId={pages.requestId} />

  return (
    <>
      <PageHeader
        title="Link in bio"
        description="A public page of links, for the one URL a social profile allows."
      />

      <CreatePage workspaceId={workspaceId} />

      {pages.data.length === 0 ? (
        <div className="mt-6">
          <EmptyState title="No pages yet" hint="Create one above to get a shareable link." />
        </div>
      ) : (
        <div className="mt-6 space-y-3">
          {pages.data.map((page) => {
            const totalClicks = page.links.reduce((sum, l) => sum + l.clicks, 0)
            return (
              <Card key={page.id} className="p-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">
                      {page.title}
                      {!page.published && (
                        <span className="ml-2">
                          <Badge>draft</Badge>
                        </span>
                      )}
                    </p>
                    <p className="truncate font-mono text-xs">
                      <Muted>/l/{page.slug}</Muted>
                    </p>
                    <p className="mt-1 text-xs">
                      <Muted>
                        {page.views} view{page.views === 1 ? '' : 's'} · {totalClicks} click
                        {totalClicks === 1 ? '' : 's'}
                        {/* CTR only once there is something to divide by —
                            "0% CTR" on an unvisited page is noise, not data. */}
                        {page.views > 0
                          ? ` · ${Math.round((totalClicks / page.views) * 100)}% CTR`
                          : ''}
                      </Muted>
                    </p>
                  </div>
                  <PublishToggle
                    workspaceId={workspaceId}
                    pageId={page.id}
                    published={page.published}
                    slug={page.slug}
                  />
                </div>

                <div className="mt-3 space-y-1 border-t pt-2 border-border">
                  {page.links.map((link) => (
                    <div
                      key={link.id}
                      className="flex items-baseline justify-between gap-3 text-xs"
                    >
                      <span className="min-w-0 truncate">
                        {link.label} <Muted>· {link.url}</Muted>
                      </span>
                      <span className="flex shrink-0 items-center gap-2">
                        <Muted>{link.clicks} clicks</Muted>
                        <RemoveLink workspaceId={workspaceId} linkId={link.id} />
                      </span>
                    </div>
                  ))}
                  <div className="pt-2">
                    <AddLink workspaceId={workspaceId} pageId={page.id} />
                  </div>
                </div>
              </Card>
            )
          })}
        </div>
      )}
    </>
  )
}
