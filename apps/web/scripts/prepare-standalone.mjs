import { cp, access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Finishes the standalone build.
 *
 * `output: standalone` produces a server plus its traced dependencies, but it
 * does NOT copy `.next/static` or `public`. Next documents this; the effect if
 * you miss it is a site that boots, serves HTML, and renders with no CSS and no
 * images — which reads as a broken deployment rather than a missing copy step.
 *
 * It also nests the server under the workspace path, so the entrypoint is
 * `.next/standalone/apps/web/server.js`, not `.next/standalone/server.js`.
 *
 * Both facts live here rather than in a Dockerfile line, so `pnpm build`
 * produces something runnable and the container and a bare-metal deploy cannot
 * drift apart.
 */
const here = dirname(fileURLToPath(import.meta.url))
const web = join(here, '..')
const standalone = join(web, '.next', 'standalone', 'apps', 'web')

async function exists(path) {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

if (!(await exists(join(standalone, 'server.js')))) {
  console.error('No standalone server found. Run `next build` with output: "standalone" first.')
  process.exit(1)
}

await cp(join(web, '.next', 'static'), join(standalone, '.next', 'static'), { recursive: true })
console.log('copied .next/static')

if (await exists(join(web, 'public'))) {
  await cp(join(web, 'public'), join(standalone, 'public'), { recursive: true })
  console.log('copied public')
}

console.log('standalone ready: .next/standalone/apps/web/server.js')
