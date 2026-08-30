/**
 * THE SINGLE-ORIGIN INVARIANT.
 *
 * The browser must only ever see one origin. This rewrite proxies /api/* to the
 * API service so that, from the browser's point of view, there is no second
 * host at all.
 *
 * That is not a convenience. Same-origin is what makes SameSite=Lax sufficient
 * for CSRF, what allows the __Host- cookie prefix, and what makes the
 * self-hosted and SaaS topologies behave identically instead of diverging in
 * exactly the area hardest to debug.
 *
 * Do NOT replace this with a public api.example.com. The CSRF posture in
 * SECURITY.md section 3 depends on the invariant, and breaking it requires
 * re-deriving that posture first — CORS with credentials, SameSite=None, and a
 * real token scheme.
 *
 * Server-side calls bypass this hop entirely and go direct to INTERNAL_API_URL;
 * see lib/server-fetch.ts.
 */
const INTERNAL_API_URL = process.env.INTERNAL_API_URL ?? 'http://localhost:3001'

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${INTERNAL_API_URL}/api/:path*` }]
  },
}

export default nextConfig
