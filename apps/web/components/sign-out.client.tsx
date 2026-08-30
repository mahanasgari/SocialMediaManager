'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { LogOut } from 'lucide-react'

/**
 * Signing out, and actually going somewhere afterwards.
 *
 * This was a plain form posting to /api/v1/auth/logout. That endpoint answers
 * 204, and a browser does not navigate on 204 — so the session was destroyed
 * and the page stayed exactly where it was, still showing the signed-in
 * application. You clicked Sign out and nothing appeared to happen.
 *
 * Found by an end-to-end test waiting for a redirect that never came.
 *
 * `refresh()` after the push matters as much as the push: server components
 * cache per route, and without it the shell can re-render from a cached payload
 * built while the session was still valid.
 */
export function SignOut() {
  const router = useRouter()
  const [busy, setBusy] = useState(false)

  return (
    <button
      type="button"
      disabled={busy}
      onClick={async () => {
        setBusy(true)
        // Failure is ignored deliberately. If the request did not land, the
        // cookie may still be live — but leaving someone stranded on a page
        // they believe is signed out is worse than sending them to /login,
        // where the next action re-authenticates anyway.
        await fetch('/api/v1/auth/logout', {
          method: 'POST',
          headers: { 'x-smm-client': 'web' },
        }).catch(() => undefined)

        router.push('/login')
        router.refresh()
      }}
      className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground disabled:opacity-60"
    >
      <LogOut className="size-4 shrink-0" />
      {busy ? 'Signing out…' : 'Sign out'}
    </button>
  )
}
