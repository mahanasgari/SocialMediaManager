import type { CSSProperties, ReactNode } from 'react'
import { AlertTriangle, Inbox } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Card as BaseCard } from '@/components/ui/card'
import { Badge as BaseBadge } from '@/components/ui/badge'

/**
 * App-level composites.
 *
 * The primitives in `components/ui/` are generic. These are the handful of
 * shapes this product repeats on every page — a page header, an empty state, an
 * error card — and having them here means a page never re-lays-out the same
 * arrangement slightly differently.
 *
 * The older `tone` and `style` APIs are kept so existing pages keep working
 * while they migrate. Both are marked below.
 */

export function Card({
  children,
  className = '',
  style,
}: {
  children: ReactNode
  className?: string
  /** @deprecated Prefer a Tailwind class. Kept for pages not yet migrated. */
  style?: CSSProperties
}) {
  return (
    <BaseCard className={className} {...(style ? { style } : {})}>
      {children}
    </BaseCard>
  )
}

export function Muted({ children }: { children: ReactNode }) {
  return <span className="text-muted-foreground">{children}</span>
}

/** Maps the old three-value tone onto the primitive's variants. */
const TONE = {
  neutral: 'default',
  accent: 'primary',
  warn: 'warning',
  success: 'success',
  danger: 'destructive',
} as const

export function Badge({
  children,
  tone = 'neutral',
  className,
}: {
  children: ReactNode
  tone?: keyof typeof TONE
  className?: string
}) {
  return (
    <BaseBadge variant={TONE[tone]} {...(className ? { className } : {})}>
      {children}
    </BaseBadge>
  )
}

/**
 * What to show when there is nothing.
 *
 * An empty state has to answer two questions — is this broken, and what do I do
 * now — so `hint` is required rather than optional. A bare "No results" answers
 * neither and is why empty screens feel like errors.
 */
export function EmptyState({
  title,
  hint,
  action,
  icon,
}: {
  title: string
  hint: string
  action?: ReactNode
  icon?: ReactNode
}) {
  return (
    <BaseCard className="flex flex-col items-center px-6 py-12 text-center">
      <div className="mb-3 flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
        {icon ?? <Inbox className="size-5" />}
      </div>
      <p className="text-sm font-medium">{title}</p>
      <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">{hint}</p>
      {action && <div className="mt-4">{action}</div>}
    </BaseCard>
  )
}

export function PageHeader({
  title,
  description,
  action,
}: {
  title: string
  description?: string
  action?: ReactNode
}) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  )
}

/**
 * A failed request.
 *
 * The request id is shown, and shown SELECTABLE, because it is the only thing
 * that connects what someone saw to a line in the server log. An error page
 * without one turns every support conversation into a guess about timing.
 */
export function ErrorCard({ message, requestId }: { message: string; requestId?: string }) {
  return (
    <BaseCard className="border-destructive/30 bg-destructive/5 p-5" role="alert">
      <div className="flex gap-3">
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
        <div className="min-w-0">
          <p className="text-sm font-medium text-destructive">{message}</p>
          {requestId && (
            <p className="mt-1.5 text-xs text-muted-foreground">
              Reference{' '}
              <code className="select-all rounded bg-muted px-1 py-0.5 font-mono">{requestId}</code>
            </p>
          )}
        </div>
      </div>
    </BaseCard>
  )
}

/**
 * A single figure.
 *
 * Tabular numerals, so a row of these lines up digit-for-digit. Proportional
 * digits make a set of stats impossible to compare at a glance, which is the
 * only thing a set of stats is for.
 */
export function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string
  value: string | number
  hint?: string
  tone?: 'default' | 'warning' | 'destructive'
}) {
  return (
    <div>
      <p
        className={cn(
          'tabular text-2xl font-semibold tracking-tight',
          tone === 'warning' && 'text-warning',
          tone === 'destructive' && 'text-destructive'
        )}
      >
        {value}
      </p>
      <p className="mt-0.5 text-xs font-medium">{label}</p>
      {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}

/**
 * A metric that may genuinely not exist.
 *
 * Renders an em dash for null, never a zero. The distinction the whole
 * nullability discipline rests on: a measured zero is data, an unmeasured
 * metric is not, and "0 impressions" on a platform that never reports
 * impressions is a lie about a number nobody counted.
 */
export function Metric({ value }: { value: number | null | undefined }) {
  if (value === null || value === undefined) {
    return (
      <span className="text-muted-foreground" title="Not reported by this platform">
        —
      </span>
    )
  }
  return <span className="tabular">{value.toLocaleString()}</span>
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
