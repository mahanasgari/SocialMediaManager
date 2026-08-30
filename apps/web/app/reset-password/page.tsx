import Link from 'next/link'
import { ResetForm } from './reset.client'

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>
}) {
  const { token } = await searchParams

  if (!token) {
    return (
      <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-6">
        <h1 className="text-xl font-semibold tracking-tight">Reset link missing</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          This page needs the link from your reset email. If you opened it by hand, request a new
          one.
        </p>
        <Link href="/forgot-password" className="mt-6 text-sm underline">
          Request a reset link
        </Link>
      </main>
    )
  }

  // The token stays in the URL and is handed to the client component rather
  // than being validated here. Validating on render would spend the
  // single-use token just because someone opened the page — including the
  // preview fetch some mail clients make before a human ever clicks.
  return <ResetForm token={token} />
}
