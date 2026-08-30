import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import { forwardRef, type ButtonHTMLAttributes } from 'react'
import { Loader2 } from 'lucide-react'
import { cn } from '@/lib/cn'

/**
 * Variants are data, not branches.
 *
 * `cva` turns the variant matrix into a lookup, which means adding a size never
 * touches the component body and every combination is expressible. The
 * alternative — conditionals inside the JSX — grows quadratically and quietly
 * loses combinations nobody thought to test.
 */
const buttonVariants = cva(
  // Shared by every variant. `whitespace-nowrap` because a button that wraps
  // mid-label reflows the row it sits in; `shrink-0` so it survives a flex
  // parent that would otherwise squash it to its text.
  'inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium ' +
    'transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ' +
    'focus-visible:ring-offset-2 focus-visible:ring-offset-background ' +
    // Pointer events off while disabled so a disabled submit cannot be
    // double-clicked through a tooltip wrapper.
    'disabled:pointer-events-none disabled:opacity-50 ' +
    // Icons inside a button should never capture the click.
    '[&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground shadow-sm hover:bg-primary/90',
        /**
         * For actions that LOSE DATA — delete, purge, revoke. Not for actions
         * that merely failed. Using red for both trains people to ignore it.
         */
        destructive: 'bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90',
        outline:
          'border border-input bg-background shadow-sm hover:bg-accent hover:text-accent-foreground',
        secondary: 'bg-secondary text-secondary-foreground shadow-sm hover:bg-secondary/80',
        ghost: 'hover:bg-accent hover:text-accent-foreground',
        link: 'text-primary underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-9 px-4 py-2',
        sm: 'h-8 rounded-md px-3 text-xs',
        lg: 'h-10 rounded-md px-6',
        /** Square. For a lone icon, where padding would make it a rectangle. */
        icon: 'size-9',
        'icon-sm': 'size-8',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  }
)

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof buttonVariants> & {
    /**
     * Render as the child element instead of a <button>.
     *
     * The reason a "button" that navigates can still be a real <a>: styling a
     * link as a button is fine, replacing it with one is not — middle-click,
     * open-in-new-tab and copy-link-address all stop working.
     */
    asChild?: boolean
    /**
     * Shows a spinner and disables the button.
     *
     * Separate from `disabled` so the two reasons stay distinguishable: busy
     * means "wait", disabled means "you cannot do this".
     */
    loading?: boolean
  }

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, asChild = false, loading = false, disabled, children, ...props },
  ref
) {
  if (asChild) {
    /**
     * Slot requires EXACTLY ONE element child, and it counts the `false` that
     * `{loading && <Loader2/>}` evaluates to. Rendering the spinner branch here
     * would hand it two children and throw at runtime — which is what happened,
     * on a link-shaped button that never needed a spinner in the first place.
     *
     * `asChild` means "become this element". Injecting a sibling into it is not
     * something the caller asked for, so the loading state is simply not
     * available in this mode.
     */
    return (
      <Slot ref={ref} className={cn(buttonVariants({ variant, size }), className)} {...props}>
        {children}
      </Slot>
    )
  }

  return (
    <button
      ref={ref}
      className={cn(buttonVariants({ variant, size }), className)}
      disabled={disabled || loading}
      // Announced to assistive technology, which cannot see a spinner.
      aria-busy={loading || undefined}
      {...props}
    >
      {loading && <Loader2 className="animate-spin" aria-hidden />}
      {children}
    </button>
  )
})

export { buttonVariants }
