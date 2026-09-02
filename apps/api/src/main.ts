import 'reflect-metadata'
import { Logger } from '@nestjs/common'
import { httpDuration } from '@smm/observability'
import { NestFactory } from '@nestjs/core'
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify'
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger'
import { cookiePolicy, loadEnv } from '@smm/config'
import { assertRlsApplies, db } from '@smm/database'
import fastifyCookie from '@fastify/cookie'
import { AppModule } from './app.module.js'
import { ConnectorSettingsService } from './admin/connector-settings.service.js'
import { REQUEST_ID_HEADER, resolveRequestId } from './common/request-id.js'

const PORT = Number(process.env['API_PORT'] ?? 3001)

async function bootstrap(): Promise<void> {
  const logger = new Logger('bootstrap')

  // Parsed before anything else so a misconfiguration fails immediately with a
  // message naming the variable, rather than surfacing later as a confusing
  // runtime error somewhere unrelated.
  const env = loadEnv()

  const adapter = new FastifyAdapter({
    // Required for inbound provider webhooks (Phase 6): HMAC must be computed
    // over the exact bytes received. Re-serialising parsed JSON and hashing that
    // is the single most common way signature verification silently passes on
    // well-formed payloads and fails on everything else — so the capability is
    // enabled from the start rather than retrofitted.
    // 512 MB: video for TikTok and YouTube is the reason this is not smaller.
    // The inbound webhook route caps itself far lower, separately.
    bodyLimit: 512 * 1024 * 1024,
    trustProxy: true,
  })

  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter, {
    rawBody: true,
    bufferLogs: true,
  })

  // Session cookies are signed by nothing: the token is already a 256-bit
  // opaque value looked up server-side, so a signature would add ceremony
  // without adding a property we do not already have.
  await app.register(fastifyCookie)

  // Binary uploads arrive as a raw body. Fastify has no parser for these types
  // by default and would reject them as unsupported media before any handler
  // ran — the file has to reach us intact so its magic bytes can be sniffed.
  const fastify = app.getHttpAdapter().getInstance()
  for (const type of [
    'image/jpeg',
    'image/png',
    'image/gif',
    'image/webp',
    'video/mp4',
    'video/quicktime',
    'application/octet-stream',
  ]) {
    fastify.addContentTypeParser(type, { parseAs: 'buffer' }, (_req, body, done) => {
      done(null, body)
    })
  }

  app.setGlobalPrefix('api/v1')

  // Ensure every request carries a correlation id, reusing an inbound one so the
  // chain from browser through web, api and worker is not broken at our edge.
  app.getHttpAdapter().getInstance().addHook('onRequest', (request, reply, done) => {
    const id = resolveRequestId(request.headers[REQUEST_ID_HEADER])
    request.headers[REQUEST_ID_HEADER] = id
    void reply.header(REQUEST_ID_HEADER, id)
    done()
  })

  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('SMM API')
      .setDescription('Self-hosted social media management platform')
      .setVersion('1')
      .addCookieAuth('smm_session')
      .addBearerAuth({ type: 'http', scheme: 'bearer' }, 'apiKey')
      .build()
  )
  SwaggerModule.setup('api/v1/docs', app, document, {
    jsonDocumentUrl: 'api/v1/openapi.json',
  })

  // No CORS configuration, deliberately. apps/web reverse-proxies /api/* so the
  // browser only ever sees one origin. That invariant is what makes SameSite=Lax
  // sufficient for CSRF and the __Host- cookie prefix available — see
  // SECURITY.md section 3. Adding CORS here would be a sign the invariant broke.

  // Verify row-level security actually applies to the role we connect as.
  // Configuration can be inspected and still be wrong: RLS was once enabled,
  // FORCED, and fully policied here while a superuser connection ignored all of
  // it. Behaviour is the only honest check, so this runs before serving.
  await assertRlsApplies(db())
  logger.log('row-level security: enforced for this connection')

  // Connector credentials an administrator set through the UI, loaded into the
  // adapters before the first request. Without this the first caller after a
  // restart sees every provider as unconfigured until something triggers a
  // lazy refresh — which reads as the settings having been lost.
  const connectorSettings = app.get(ConnectorSettingsService)
  await connectorSettings.load()

  const cookies = cookiePolicy(env)
  if (cookies.warning) logger.warn(cookies.warning)

  // Metrics exposure, stated at boot rather than discovered in a scan.
  //
  // The same shape as the cookie warning above: an unauthenticated scrape on a
  // private network is legitimate and refusing it would be hostile, but a
  // property that disappears without saying so is worse than either explicit
  // choice. On http://localhost this is silent — there is nothing to warn about.
  if (!env.METRICS_TOKEN && env.PUBLIC_URL.startsWith('https://')) {
    logger.warn(
      'GET /api/v1/metrics is served WITHOUT a token on an internet-facing deployment. ' +
        'It exposes operational volume and error rates, not personal data. ' +
        'Set METRICS_TOKEN to require a bearer token, or restrict the path at your proxy.'
    )
  }

  // Request timing, registered as a Fastify hook rather than a Nest interceptor
  // so it also covers responses Nest never sees — 404s and payload-too-large
  // among them, which are exactly the ones worth a graph.
  //
  // Labelled by ROUTE, never by url. An unbounded label value gives every
  // request its own time series and takes the monitoring system down, which is
  // an observability change causing the outage it was added to catch.
  const instance = app.getHttpAdapter().getInstance()
  instance.addHook('onResponse', (request, reply, done) => {
    const route = (request as { routeOptions?: { url?: string } }).routeOptions?.url ?? 'unmatched'
    httpDuration.observe(
      {
        method: request.method,
        route,
        status: `${Math.floor(reply.statusCode / 100)}xx`,
      },
      reply.elapsedTime / 1000
    )
    done()
  })

  // Graceful shutdown.
  //
  // Without this, SIGTERM kills the process mid-request and every deploy drops
  // whatever was in flight — a rolling restart becomes a burst of 502s. An
  // orchestrator sends SIGTERM and waits (30s by default in Kubernetes and
  // Compose) before SIGKILL, so the correct behaviour is: stop accepting
  // connections, let the open ones finish, close the pools, exit.
  installShutdownHandlers(app, logger)

  await app.listen({ port: PORT, host: '0.0.0.0' })
  logger.log(`api listening on :${PORT} (public origin ${env.PUBLIC_URL})`)
  logger.log(`session cookie: ${cookies.name}${cookies.secure ? ' (Secure)' : ''}`)
}

/**
 * Drains and exits on a termination signal.
 *
 * The timeout is the important part. `app.close()` waits for open connections,
 * and a client holding a keep-alive socket open would otherwise keep the
 * process alive until the orchestrator SIGKILLs it — turning a clean shutdown
 * into a hard kill and defeating the point.
 */
function installShutdownHandlers(app: NestFastifyApplication, logger: Logger): void {
  const GRACE_MS = Number(process.env['SHUTDOWN_GRACE_MS'] ?? 15_000)
  let shuttingDown = false

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      // A second signal means someone is impatient, and honouring it is more
      // useful than insisting on the drain they are trying to skip.
      if (shuttingDown) {
        logger.warn(`${signal} again — exiting now`)
        process.exit(0)
      }
      shuttingDown = true
      logger.log(`${signal} received; draining for up to ${GRACE_MS}ms`)

      const forced = setTimeout(() => {
        logger.warn('drain did not finish in time; exiting anyway')
        process.exit(0)
      }, GRACE_MS)
      forced.unref()

      void app
        .close()
        .then(() => db().$disconnect())
        .then(() => {
          logger.log('shutdown complete')
          process.exit(0)
        })
        .catch((err: unknown) => {
          logger.error(`shutdown failed: ${err instanceof Error ? err.message : String(err)}`)
          process.exit(1)
        })
    })
  }
}

bootstrap().catch((err) => {
  console.error('API failed to start:\n', err instanceof Error ? err.message : err)
  process.exit(1)
})
