import { forwardRef, type InputHTMLAttributes } from 'react'
import { cn } from '@/lib/cn'

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, type, ...props }, ref) {
    return (
      <input
        type={type}
        ref={ref}
        className={cn(
          'flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm',
          'transition-colors placeholder:text-muted-foreground',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
          'focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50',
          // aria-invalid rather than a prop: the attribute is what screen
          // readers announce, so styling from it means the two can never
          // disagree about whether a field is in error.
          'aria-[invalid=true]:border-destructive aria-[invalid=true]:ring-destructive',
          // 16px on mobile. Anything smaller makes iOS Safari zoom on focus,
          // which then leaves the page scrolled somewhere unexpected.
          'max-sm:text-base',
          'file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground',
          className
        )}
        {...props}
      />
    )
  }
)
