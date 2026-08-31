import { createServer, type Server } from 'node:http'
import { scrape } from '@smm/observability'

/**
 * A metrics listener for the worker.
 *
 * Without this, everything the worker counts is written to a registry nothing
 * can read. Prometheus scrapes processes; the API has an HTTP server and the
 * worker does not, so half the instrumentation in this process would be
 * unreadable — counters that exist, increment correctly, and are never seen by
 * anyone. That is worse than not collecting them, because the code reads as
 * covered.
 *
 * Deliberately not Nest, not Fastify, not a router. One route, no parsing, no
 * dependencies: a worker whose job is publishing should not gain a web
 * framework in order to report how it is doing.
 *
 * It binds separately from the API's endpoint and the two are not merged,
 * because they measure different processes. Merging them would mean one
 * process reporting numbers it does not own — and when the worker dies, its
 * metrics should VANISH from the scrape rather than be reported as zero by
 * somebody else. A gauge reading zero and a gauge that stopped answering mean
 * completely different things, and only one of them is an outage.
 */

const DEFAULT_PORT = 9464

export function startMetricsServer(
  port = Number(process.env['WORKER_METRICS_PORT'] ?? DEFAULT_PORT),
  token = process.env['METRICS_TOKEN']
): Server {
  const server = createServer((req, res) => {
    if (req.url !== '/metrics') {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('Only /metrics is served here.\n')
      return
    }

    if (token) {
      const presented = req.headers.authorization?.startsWith('Bearer ')
        ? req.headers.authorization.slice('Bearer '.length)
        : undefined
      if (presented !== token) {
        res.writeHead(401, { 'content-type': 'text/plain' })
        res.end('This endpoint requires a metrics token.\n')
        return
      }
    }

    scrape()
      .then(({ body, contentType }) => {
        res.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-store' })
        res.end(body)
      })
      .catch(() => {
        res.writeHead(500, { 'content-type': 'text/plain' })
        res.end('Could not collect metrics.\n')
      })
  })

  // Never keeps the process alive on its own. If the tick loop stops, the
  // worker should exit rather than linger as a process that answers scrapes
  // while doing no work — which looks healthy from the outside and is not.
  server.unref()
  server.listen(port, '0.0.0.0')

  return server
}
