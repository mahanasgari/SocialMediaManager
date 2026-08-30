import type { HTMLAttributes } from 'react'
import { cn } from '@/lib/cn'

/**
 * A loading placeholder.
 *
 * Sized to match the content it stands in for, so the page does not jump when
 * the real thing arrives. A spinner in the same place would say "something is
 * happening" without saying what shape it will be.
 */
export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('animate-pulse rounded-md bg-muted', className)}
      // Announced as busy rather than read out as empty content.
      aria-hidden
      {...props}
    />
  )
}
