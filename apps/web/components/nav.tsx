import Link from 'next/link'
import {
  BarChart3,
  CalendarDays,
  CheckCircle2,
  FileText,
  Image as ImageIcon,
  Inbox,
  LayoutDashboard,
  Link2,
  PenSquare,
  Plug,
  Download,
  Tags,
  Settings,
  ShieldCheck,
  Users,
  Webhook,
} from 'lucide-react'
import type { ComponentType, ReactNode } from 'react'
import { cn } from '@/lib/cn'

/**
 * Only sections that actually work appear here.
 *
 * A nav item that goes nowhere is a promise the product does not keep, so
 * nothing is listed before it functions.
 *
 * Grouped because a flat list of fifteen links is a list nobody reads. The
 * groups follow the job rather than the architecture: you are either making
 * something, talking to people, measuring what happened, or setting things up.
 */
type Item = {
  href: string
  label: string
  icon: ComponentType<{ className?: string }>
}

const GROUPS: Array<{ label: string; items: Item[] }> = [
  {
    label: 'Create',
    items: [
      { href: 'dashboard', label: 'Overview', icon: LayoutDashboard },
      { href: 'compose', label: 'Compose', icon: PenSquare },
      { href: 'calendar', label: 'Calendar', icon: CalendarDays },
      { href: 'posts', label: 'Posts', icon: FileText },
      { href: 'media', label: 'Media', icon: ImageIcon },
      { href: 'organise', label: 'Organise', icon: Tags },
    ],
  },
  {
    label: 'Engage',
    items: [
      { href: 'inbox', label: 'Inbox', icon: Inbox },
      { href: 'approvals', label: 'Approvals', icon: CheckCircle2 },
    ],
  },
  {
    label: 'Measure',
    items: [
      { href: 'analytics', label: 'Analytics', icon: BarChart3 },
      { href: 'reports', label: 'Reports', icon: FileText },
      { href: 'links', label: 'Link in bio', icon: Link2 },
    ],
  },
  {
    label: 'Configure',
    items: [
      { href: 'accounts', label: 'Social accounts', icon: Plug },
      { href: 'integrations', label: 'Integrations', icon: Webhook },
      { href: 'team', label: 'Team', icon: Users },
      { href: 'exports', label: 'Export', icon: Download },
      { href: 'settings', label: 'Settings', icon: Settings },
      { href: 'admin', label: 'Administration', icon: ShieldCheck },
    ],
  },
]

export function Nav({
  workspaceId,
  active,
  badges,
}: {
  workspaceId: string
  active: string
  /** Counts keyed by href, e.g. `{ inbox: 3 }`. Zero and absent both render nothing. */
  badges?: Record<string, number>
}) {
  return (
    <nav className="mt-4 space-y-4">
      {GROUPS.map((group) => (
        <div key={group.label}>
          <p className="px-2 pb-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            {group.label}
          </p>
          <div className="space-y-0.5">
            {group.items.map((item) => (
              <NavLink
                key={item.href}
                href={`/w/${workspaceId}/${item.href}`}
                active={active === item.href}
                icon={<item.icon className="size-4 shrink-0" />}
                count={badges?.[item.href]}
              >
                {item.label}
              </NavLink>
            ))}
          </div>
        </div>
      ))}
    </nav>
  )
}

function NavLink({
  href,
  active,
  icon,
  count,
  children,
}: {
  href: string
  active: boolean
  icon: ReactNode
  count?: number | undefined
  children: ReactNode
}) {
  return (
    <Link
      href={href}
      // Announced to a screen reader, which cannot see that this row is tinted.
      aria-current={active ? 'page' : undefined}
      className={cn(
        'flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        active
          ? 'bg-primary/10 font-medium text-primary'
          : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
      )}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {/* Only a positive count. Rendering a zero badge is visual noise that
          trains people to stop looking at badges. */}
      {count !== undefined && count > 0 && (
        <span className="tabular rounded-full bg-primary px-1.5 text-[10px] font-semibold leading-4 text-primary-foreground">
          {count > 99 ? '99+' : count}
        </span>
      )}
    </Link>
  )
}
