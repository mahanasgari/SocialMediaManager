import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/**
 * Merges class names, with later Tailwind utilities winning over earlier ones.
 *
 * `clsx` alone would produce `px-2 px-4` and leave the browser to pick by
 * source order in the stylesheet — which is not the order they appear in the
 * string. `twMerge` understands that `px-2` and `px-4` are the same property
 * and drops the loser.
 *
 * That is what makes `<Button className="px-4">` able to override the variant's
 * own padding. Without it, a caller's className is a suggestion.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
