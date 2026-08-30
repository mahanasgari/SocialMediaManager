import { redirect } from 'next/navigation'
import { headers } from 'next/headers'
import Link from 'next/link'
import { LogOut } from 'lucide-react'
import { getMe, getWorkspaces } from '@/lib/api'
import { apiGet } from '@/lib/server-fetch'
import { Nav } from '@/components/nav'
import { WorkspaceSwitcher } from '@/components/workspace-switcher.client'
import { ThemeToggle } from '@/components/theme-toggle.client'
import { MobileNav } from '@/components/mobile-nav.client'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { TooltipProvider } from '@/components/ui/tooltip'

export default async function WorkspaceLayout({
  children,
  params,
}: {
  children: React.ReactNode
  params: Promise<{ workspaceId: string }>
}) {
  const { workspaceId } = await params

  const me = await getMe()
  if (!me.ok) redirect('/login')

  const workspaces = await getWorkspaces()
  if (!workspaces.ok) redirect('/login')

  const current = workspaces.data.find((w) => w.id === workspaceId)
  // A workspace you are not a member of is indistinguishable from one that does
  // not exist — the API returns 404 for both, and the UI must not leak the
  // difference by behaving differently.
  if (!current) redirect(workspaces.data[0] ? `/w/${workspaces.data[0].id}/dashboard` : '/login')

  const pathname = (await headers()).get('x-pathname') ?? ''
  // Index 3, not 4: "/w/:id/posts" splits to ['', 'w', ':id', 'posts']. Index 4
  // is always undefined, so `active` was permanently 'dashboard' and Overview
  // stayed highlighted no matter where you were.
  const active = pathname.split('/')[3] ?? 'dashboard'

  // Fetched here so the badge is on every page, not only the inbox. A count you
  // have to navigate to in order to see is a count that does not do its job.
  //
  // Failure is swallowed: an unread badge is not worth taking down the whole
  // shell for, and the inbox itself will report the error properly.
  const counts = await apiGet<{ open: number; unread: number }>(
    `/api/v1/inbox/counts?workspaceId=${workspaceId}`
  )
  const badges = counts.ok ? { inbox: counts.data.unread } : undefined

  const sidebar = (
    <>
      <div className="mt-4">
        <WorkspaceSwitcher workspaces={workspaces.data} current={current} />
      </div>
      <Nav workspaceId={workspaceId} active={active} {...(badges ? { badges } : {})} />
    </>
  )

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex min-h-screen">
        {/* Fixed and independently scrollable. A sidebar that scrolls with the
            page puts the navigation out of reach exactly when a long list has
            made you want it. */}
        <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col overflow-y-auto border-r bg-card px-3 py-4 lg:flex">
          <div className="flex items-center justify-between px-2">
            <Link
              href={`/w/${workspaceId}/dashboard`}
              className="flex items-center gap-2 text-sm font-semibold tracking-tight"
            >
              <span
                className="flex size-6 items-center justify-center rounded-md bg-primary text-[11px] font-bold text-primary-foreground"
                aria-hidden
              >
                S
              </span>
              SMM
            </Link>
            <ThemeToggle />
          </div>

          {sidebar}

          <div className="mt-auto border-t pt-3">
            <div className="flex items-center gap-2 px-2 py-1">
              <Avatar className="size-7">
                <AvatarFallback>{me.data.email.slice(0, 2).toUpperCase()}</AvatarFallback>
              </Avatar>
              <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                {me.data.email}
              </p>
            </div>
            <form action="/api/v1/auth/logout" method="post">
              <button
                type="submit"
                className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
              >
                <LogOut className="size-4 shrink-0" />
                Sign out
              </button>
            </form>
          </div>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          {/* Below `lg` the sidebar collapses into a sheet. A 60-pixel-wide
              column of icons is worse than either. */}
          <header className="sticky top-0 z-30 flex items-center gap-3 border-b bg-background/80 px-4 py-2.5 backdrop-blur lg:hidden">
            <MobileNav
              workspaceId={workspaceId}
              active={active}
              {...(badges ? { badges } : {})}
              workspaces={workspaces.data}
              current={current}
            />
            <span className="text-sm font-semibold">SMM</span>
            <div className="ml-auto">
              <ThemeToggle />
            </div>
          </header>

          <main className="min-w-0 flex-1 px-4 py-6 sm:px-6 lg:px-8">
            <div className="mx-auto max-w-5xl">{children}</div>
          </main>
        </div>
      </div>
    </TooltipProvider>
  )
}
