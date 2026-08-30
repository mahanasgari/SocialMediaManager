'use client'

import { useEffect, useState } from 'react'
import { Moon, Sun } from 'lucide-react'
import { Button } from '@/components/ui/button'

/**
 * The theme is applied before first paint by an inline script in the root
 * layout; this only flips it afterwards. Reading the preference in an effect and
 * applying it there would flash the wrong theme on every load, which is the most
 * noticeable rough edge a dark mode can have.
 */
export function ThemeToggle() {
  const [dark, setDark] = useState(false)

  useEffect(() => {
    setDark(document.documentElement.classList.contains('dark'))
  }, [])

  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'}
      onClick={() => {
        const next = !dark
        setDark(next)
        document.documentElement.classList.toggle('dark', next)
        try {
          localStorage.setItem('smm-theme', next ? 'dark' : 'light')
        } catch {
          // Private browsing can throw on write. A theme preference is not
          // worth breaking the page over.
        }
      }}
    >
      {/* Both are rendered and cross-faded rather than swapped, so the button
          never reflows and the icon does not pop in a frame late. */}
      <Sun className="size-4 rotate-0 scale-100 transition-transform dark:-rotate-90 dark:scale-0" />
      <Moon className="absolute size-4 rotate-90 scale-0 transition-transform dark:rotate-0 dark:scale-100" />
    </Button>
  )
}
