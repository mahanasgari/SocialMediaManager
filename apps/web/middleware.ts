import { NextResponse, type NextRequest } from 'next/server'

/**
 * Server components cannot read their own pathname. The layout needs it to mark
 * the active nav item, so it is forwarded as a header rather than threaded
 * through every page as a prop.
 */
export function middleware(request: NextRequest) {
  const headers = new Headers(request.headers)
  headers.set('x-pathname', request.nextUrl.pathname)
  return NextResponse.next({ request: { headers } })
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
