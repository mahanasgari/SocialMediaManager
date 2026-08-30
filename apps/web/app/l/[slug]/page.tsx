import { notFound } from 'next/navigation'
import { apiGet } from '@/lib/server-fetch'
import { LinkButton } from './link-button.client'

type PublicPage = {
  id: string
  slug: string
  title: string
  bio: string | null
  avatarUrl: string | null
  theme: string
  links: Array<{ id: string; label: string; url: string }>
}

/**
 * The public link-in-bio page.
 *
 * Deliberately outside the /w/[workspaceId] shell: no nav, no workspace
 * switcher, no sign-out. A visitor here is not a user of the product, and
 * anything suggesting otherwise would be noise on somebody's bio link.
 */
export default async function PublicLinkPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const page = await apiGet<PublicPage>(`/api/v1/l/${encodeURIComponent(slug)}`)
  if (!page.ok) notFound()

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col items-center px-6 py-16 text-center">
      <h1 className="text-xl font-semibold tracking-tight">{page.data.title}</h1>
      {page.data.bio && <p className="mt-2 text-sm text-muted-foreground">{page.data.bio}</p>}

      <div className="mt-8 w-full space-y-2">
        {page.data.links.map((link) => (
          <LinkButton key={link.id} slug={page.data.slug} linkId={link.id} url={link.url}>
            {link.label}
          </LinkButton>
        ))}
      </div>

      {page.data.links.length === 0 && (
        <p className="mt-8 text-sm text-muted-foreground">Nothing here yet.</p>
      )}
    </main>
  )
}
