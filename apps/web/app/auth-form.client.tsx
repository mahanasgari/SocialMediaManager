'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { AlertCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent } from '@/components/ui/card'

/**
 * Client component, so it posts through the browser to the same origin — the
 * proxy in next.config.mjs forwards /api/* to the API service. Same-origin is
 * what lets the session cookie be SameSite=Lax with no CORS and no token
 * scheme; see SECURITY.md section 3.
 */
export function AuthForm({ mode }: { mode: 'login' | 'register' }) {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const isRegister = mode === 'register'

  async function submit(formData: FormData) {
    setBusy(true)
    setError(null)

    const body: Record<string, string> = {
      email: String(formData.get('email') ?? ''),
      password: String(formData.get('password') ?? ''),
    }
    if (isRegister) body['name'] = String(formData.get('name') ?? '')

    const response = await fetch(`/api/v1/auth/${mode}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-smm-client': 'web' },
      body: JSON.stringify(body),
    })

    if (response.ok) {
      // The ROOT, not /dashboard. There is no top-level dashboard route — every
      // page lives under /w/:workspaceId — and `/` is the only place that knows
      // which workspace to resolve to. Pushing /dashboard landed every
      // successful sign-in on a 404.
      router.push('/')
      router.refresh()
      return
    }

    // Surface the API's own message. It is written for a person, and inventing
    // a friendlier one here would lose the specifics that make it actionable.
    const payload = (await response.json().catch(() => null)) as
      | { error?: { message?: string } }
      | null
    setError(payload?.error?.message ?? 'Something went wrong. Try again.')
    setBusy(false)
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/30 px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center justify-center gap-2">
          <span
            className="flex size-8 items-center justify-center rounded-lg bg-primary text-sm font-bold text-primary-foreground"
            aria-hidden
          >
            S
          </span>
          <span className="text-lg font-semibold tracking-tight">SMM</span>
        </div>

        <Card>
          <CardContent className="p-6">
            <h1 className="text-lg font-semibold tracking-tight">
              {isRegister ? 'Create your account' : 'Sign in'}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {isRegister
                ? 'The first account on a new deployment becomes the owner.'
                : 'Welcome back.'}
            </p>

            <form action={submit} className="mt-6 space-y-4">
              {isRegister && (
                <Field name="name" label="Name" type="text" autoComplete="name" required />
              )}
              <Field name="email" label="Email" type="email" autoComplete="email" required />
              <Field
                name="password"
                label="Password"
                type="password"
                autoComplete={isRegister ? 'new-password' : 'current-password'}
                required
                {...(isRegister
                  ? { hint: 'At least 12 characters. Length matters more than symbols.' }
                  : {})}
              />

              {error && (
                <div
                  role="alert"
                  className="flex gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
                >
                  <AlertCircle className="mt-0.5 size-4 shrink-0" />
                  <span>{error}</span>
                </div>
              )}

              <Button type="submit" loading={busy} className="w-full">
                {isRegister ? 'Create account' : 'Sign in'}
              </Button>
            </form>
          </CardContent>
        </Card>

        <p className="mt-4 text-center text-sm text-muted-foreground">
          {isRegister ? (
            <>
              Already have an account?{' '}
              <Link className="text-foreground underline-offset-4 hover:underline" href="/login">
                Sign in
              </Link>
            </>
          ) : (
            <>
              <Link className="text-foreground underline-offset-4 hover:underline" href="/register">
                Create an account
              </Link>
              {' · '}
              <Link
                className="text-foreground underline-offset-4 hover:underline"
                href="/forgot-password"
              >
                Forgot your password?
              </Link>
            </>
          )}
        </p>
      </div>
    </main>
  )
}

function Field({
  name,
  label,
  type,
  autoComplete,
  required,
  hint,
}: {
  name: string
  label: string
  type: string
  autoComplete?: string
  required?: boolean
  hint?: string
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={name}>{label}</Label>
      <Input
        id={name}
        name={name}
        type={type}
        {...(autoComplete ? { autoComplete } : {})}
        {...(required ? { required: true } : {})}
        {...(hint ? { 'aria-describedby': `${name}-hint` } : {})}
      />
      {hint && (
        <p id={`${name}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
    </div>
  )
}
