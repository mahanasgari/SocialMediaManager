import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'SMM',
  description: 'Self-hosted social media management',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/*
          Theme is resolved before first paint. Reading the preference in an
          effect instead would flash the wrong theme on every load, which is the
          single most noticeable rough edge in a dark-mode implementation.
        */}
        <script
          dangerouslySetInnerHTML={{
            __html: `try{var t=localStorage.getItem('smm-theme');var d=t?t==='dark':matchMedia('(prefers-color-scheme:dark)').matches;if(d)document.documentElement.classList.add('dark')}catch(e){}`,
          }}
        />
      </head>
      <body>{children}</body>
    </html>
  )
}
