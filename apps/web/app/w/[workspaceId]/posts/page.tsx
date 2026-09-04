import Link from 'next/link'
import { AlertCircle, ExternalLink, FileText } from 'lucide-react'
import { apiGet } from '@/lib/server-fetch'
import { EmptyState, ErrorCard, PageHeader } from '@/components/ui'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'

type PostRow = {
  id: string
  status: string
  baseContent: string
  scheduledAt: string | null
  publishedAt: string | null
  createdAt: string
  summary: string
  variants: Array<{
    id: string
    status: string
    remoteUrl: string | null
    lastError: string | null
    socialAccount: { handle: string; provider: string; displayName: string }
  }>
}

/**
 * Status colour carries urgency, not category.
 *
 * Published is quiet — it is the expected outcome and needs no attention.
 * Anything requiring a human decision is loud, because the whole point of this
 * page is finding those without reading every row.
 */
const VARIANT: Record<string, 'default' | 'success' | 'warning' | 'destructive' | 'primary'> = {
  PUBLISHED: 'success',
  SCHEDULED: 'primary',
  PARTIALLY_PUBLISHED: 'warning',
  NEEDS_REVIEW: 'warning',
  MISSED: 'warning',
  FAILED: 'destructive',
  CANCELLED: 'default',
  DRAFT: 'default',
}

type PostsResponse = { items: PostRow[]; nextCursor: string | null }

export default async function PostsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>
  searchParams: Promise<{ cursor?: string }>
}) {
  const { workspaceId } = await params
  const { cursor } = await searchParams

  const posts = await apiGet<PostsResponse>(
    `/api/v1/posts?workspaceId=${workspaceId}${cursor ? `&cursor=${cursor}` : ''}`
  )

  if (!posts.ok) return <ErrorCard message={posts.message} requestId={posts.requestId} />

  return (
    <>
      <PageHeader
        title="Posts"
        description="Everything drafted, scheduled and published."
        action={
          <Button asChild size="sm">
            <Link href={`/w/${workspaceId}/compose`}>Compose</Link>
          </Button>
        }
      />

      {posts.data.items.length === 0 ? (
        <EmptyState
          icon={<FileText className="size-5" />}
          title="Nothing here yet"
          hint="Write something and publish it to one or more channels."
          action={
            <Button asChild size="sm">
              <Link href={`/w/${workspaceId}/compose`}>Compose a post</Link>
            </Button>
          }
        />
      ) : (
        <div className="space-y-3">
          {posts.data.items.map((post) => (
            <Card key={post.id} className="transition-colors hover:border-primary/30">
              <CardContent className="p-4">
                <div className="flex items-start justify-between gap-4">
                  <p className="min-w-0 flex-1 whitespace-pre-wrap text-sm leading-relaxed">
                    {post.baseContent.slice(0, 280)}
                    {post.baseContent.length > 280 && '…'}
                  </p>
                  <Badge variant={VARIANT[post.status] ?? 'default'}>{humanise(post.status)}</Badge>
                </div>

                {/* The TIME, not the status again.
                    The badge already says "Scheduled"; repeating it underneath
                    and then once more per channel said the same word three
                    times and the useful fact — when — none. The API's summary
                    is kept only where it adds a count the badge cannot carry,
                    such as "Published to 2 of 3 channels". */}
                <p className="mt-1.5 text-xs text-muted-foreground">{subtitle(post)}</p>

                <div className="mt-3 space-y-1 border-t pt-2.5">
                  {post.variants.map((v) => (
                    <div key={v.id} className="flex items-baseline justify-between gap-3 text-xs">
                      <span className="min-w-0 truncate text-muted-foreground">
                        {v.socialAccount.displayName}{' '}
                        <span className="opacity-70">{v.socialAccount.handle}</span>
                      </span>
                      <span className="shrink-0">
                        {v.remoteUrl ? (
                          <a
                            href={v.remoteUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline"
                          >
                            View
                            <ExternalLink className="size-3" />
                          </a>
                        ) : v.status !== post.status ? (
                          // Only when this channel DIVERGED from the post as a
                          // whole. Four rows all saying what the badge already
                          // says is noise; one row saying something different
                          // is the reason to look.
                          <span className="text-muted-foreground">{humanise(v.status)}</span>
                        ) : null}
                      </span>
                    </div>
                  ))}

                  {/* Per-channel errors, verbatim from the provider taxonomy.
                      "API Error 400" is exactly what this exists to avoid. */}
                  {post.variants
                    .filter((v) => v.lastError)
                    .map((v) => (
                      <p key={`${v.id}-err`} className="flex gap-1.5 pt-1 text-xs text-destructive">
                        <AlertCircle className="mt-0.5 size-3 shrink-0" />
                        <span>
                          <span className="font-medium">{v.socialAccount.handle}</span>{' '}
                          {v.lastError}
                        </span>
                      </p>
                    ))}
                </div>
              </CardContent>
            </Card>
          ))}

          {/* The reason cursor pagination went in.
              The list was capped at a hundred with no way past it — a workspace
              with five hundred posts could see a hundred, and nothing on screen
              said the other four hundred existed. A cap with no door is a
              silent truncation. */}
          {posts.data.nextCursor && (
            <div className="flex justify-center pt-2">
              <Button asChild variant="outline" size="sm">
                <Link href={`/w/${workspaceId}/posts?cursor=${posts.data.nextCursor}`}>
                  Older posts
                </Link>
              </Button>
            </div>
          )}

          {cursor && (
            <div className="flex justify-center">
              <Link
                href={`/w/${workspaceId}/posts`}
                className="text-xs text-muted-foreground underline underline-offset-2"
              >
                Back to newest
              </Link>
            </div>
          )}
        </div>
      )}
    </>
  )
}

/** PARTIALLY_PUBLISHED -> Partially published. Sentence case, not shouting. */
function humanise(status: string): string {
  const words = status.toLowerCase().replace(/_/g, ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/**
 * The one line worth having under the badge.
 *
 * A time for anything with one, and the API's own sentence otherwise — it is
 * the only thing that can say "published to 2 of 3 channels", which the badge
 * cannot. Falling back to the sentence for a plain scheduled post would just
 * repeat the badge.
 */
function subtitle(post: PostRow): string {
  if (post.status === 'SCHEDULED' && post.scheduledAt) {
    return `Goes out ${format(post.scheduledAt)}`
  }
  if (post.publishedAt) return `Published ${format(post.publishedAt)}`
  return post.summary
}

function format(iso: string): string {
  const date = new Date(iso)
  const days = Math.round((date.getTime() - Date.now()) / 86_400_000)

  // Relative only where it is genuinely easier to read. "in 400 days" is worse
  // than a date; "tomorrow" is better than one.
  if (days === 0) {
    return `today at ${date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`
  }
  if (days === 1) {
    return `tomorrow at ${date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`
  }
  if (days === -1) return 'yesterday'

  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(date.getFullYear() === new Date().getFullYear() ? {} : { year: 'numeric' }),
  })
}
