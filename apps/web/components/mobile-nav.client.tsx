'use client'

import { useEffect, useState } from 'react'
import { usePathname } from 'next/navigation'
import { Menu } from 'lucide-react'
import type { Workspace } from '@/lib/api'
import { Nav } from '@/components/nav'
import { WorkspaceSwitcher } from '@/components/workspace-switcher.client'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'

/**
 * The sidebar, below `lg`.
 *
 * A drawer rather than a 60-pixel strip of icons: at this width an icon rail
 * loses the labels, and a navigation you have to decode from pictograms is one
 * people stop using.
 */
export function MobileNav({
  workspaceId,
  active,
  badges,
  workspaces,
  current,
}: {
  workspaceId: string
  active: string
  badges?: Record<string, number>
  workspaces: Workspace[]
  current: Workspace
}) {
  const [open, setOpen] = useState(false)
  const pathname = usePathname()

  // Closes on navigation. Without this the drawer stays open over the page it
  // just took you to, and the first thing you do is dismiss it.
  useEffect(() => {
    setOpen(false)
  }, [pathname])

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label="Open navigation">
          <Menu className="size-4" />
        </Button>
      </DialogTrigger>

      <DialogContent className="left-0 top-0 h-full max-h-full w-[17rem] max-w-[85vw] translate-x-0 translate-y-0 overflow-y-auto rounded-none sm:rounded-none">
        {/* Radix requires a title for the accessible name. It is visually
            hidden because the drawer's own contents are self-evident. */}
        <DialogTitle className="sr-only">Navigation</DialogTitle>
        <DialogDescription className="sr-only">
          Switch workspace and move between sections.
        </DialogDescription>

        <WorkspaceSwitcher workspaces={workspaces} current={current} />
        <Nav workspaceId={workspaceId} active={active} {...(badges ? { badges } : {})} />
      </DialogContent>
    </Dialog>
  )
}
