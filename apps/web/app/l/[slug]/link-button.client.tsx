'use client'

import type { ReactNode } from 'react'

/**
 * Records the click, then navigates.
 *
 * `keepalive` matters: without it the browser may cancel an in-flight request
 * as the page unloads, and clicks would be undercounted in exactly the way that
 * looks like the feature is broken.
 *
 * The navigation is NOT blocked on the request. A slow counter must never make
 * somebody's bio link feel slow, so the count is best-effort and the href works
 * even with JavaScript disabled.
 */
export function LinkButton({
  slug,
  linkId,
  url,
  children,
}: {
  slug: string
  linkId: string
  url: string
  children: ReactNode
}) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer noopener"
      onClick={() => {
        void fetch(`/api/v1/l/${encodeURIComponent(slug)}/click/${linkId}`, {
          method: 'POST',
          keepalive: true,
        }).catch(() => undefined)
      }}
      className="block w-full rounded-lg border px-4 py-3 text-sm font-medium transition-colors border-border bg-card"
    >
      {children}
    </a>
  )
}
