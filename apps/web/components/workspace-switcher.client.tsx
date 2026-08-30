'use client'

import { useRouter, usePathname } from 'next/navigation'
import { Check, ChevronsUpDown } from 'lucide-react'
import type { Workspace } from '@/lib/api'
import { cn } from '@/lib/cn'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

/**
 * Workspace is in the PATH, not in a cookie.
 *
 * Two reasons: a URL you can paste to a colleague lands them in the same
 * workspace, and there is no hidden ambient state that makes "which client am I
 * looking at?" ambiguous. For an agency tool the second point matters —
 * posting to the wrong client's account is the failure everyone fears.
 */
export function WorkspaceSwitcher({
  workspaces,
  current,
}: {
  workspaces: Workspace[]
  current: Workspace
}) {
  const router = useRouter()
  const pathname = usePathname()

  function switchTo(id: string) {
    if (id === current.id) return
    // Keep the current section, so switching lands on Accounts for the new
    // workspace rather than bouncing to the dashboard and losing your place.
    const section = pathname.split('/').slice(4).join('/') || 'dashboard'
    router.push(`/w/${id}/${section}`)
    router.refresh()
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(
          'flex w-full items-center gap-2 rounded-md border border-input bg-transparent',
          'px-2 py-1.5 text-sm shadow-sm transition-colors hover:bg-accent',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          'focus-visible:ring-offset-2 focus-visible:ring-offset-background'
        )}
        aria-label="Switch workspace"
      >
        <span
          className="flex size-5 shrink-0 items-center justify-center rounded bg-primary/10 text-[10px] font-semibold text-primary"
          aria-hidden
        >
          {initials(current.name)}
        </span>
        <span className="min-w-0 flex-1 truncate text-left font-medium">{current.name}</span>
        <ChevronsUpDown className="size-3.5 shrink-0 opacity-50" />
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" className="w-[--radix-dropdown-menu-trigger-width]">
        <DropdownMenuLabel>Workspaces</DropdownMenuLabel>
        {workspaces.map((w) => (
          <DropdownMenuItem key={w.id} onSelect={() => switchTo(w.id)}>
            <span
              className="flex size-5 shrink-0 items-center justify-center rounded bg-muted text-[10px] font-semibold"
              aria-hidden
            >
              {initials(w.name)}
            </span>
            <span className="min-w-0 flex-1 truncate">{w.name}</span>
            {w.id === current.id && <Check className="size-4 shrink-0" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** Up to two letters, so "Client: Tidepool" reads as CT rather than C. */
function initials(name: string): string {
  return name
    .split(/[\s:]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('')
}
