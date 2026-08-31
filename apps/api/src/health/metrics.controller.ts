import { Controller, Get, Headers, Res } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import type { FastifyReply } from 'fastify'
import { loadEnv } from '@smm/config'
import { scrape } from '@smm/observability'
import { errors } from '../common/errors.js'
import { Public } from '../auth/auth-mode.guard.js'

/**
 * The Prometheus scrape endpoint.
 *
 * `@Public` because a scraper has no session and never will — it is a machine
 * on a schedule, not a person. That makes the access question a real one rather
 * than something the session guard settles by accident.
 *
 * What leaks without a token is not personal data — no message bodies, no
 * handles, no email addresses; the label sets here are provider names and
 * status classes. It is operational and commercially telling: post volume,
 * error rates, roughly how many accounts an installation manages.
 *
 * So: `METRICS_TOKEN` is optional, and the behaviour follows the same shape
 * this codebase already uses for insecure cookies — permitted, but never
 * silently. Unset on a `https://` deployment, the API says so on every boot
 * rather than leaving an operator to discover it in a scan. A private network
 * with an unauthenticated scrape is a legitimate setup and refusing it outright
 * would be hostile; not mentioning it would be worse.
 */
@ApiTags('operations')
@Controller('metrics')
export class MetricsController {
  @Public()
  @Get()
  @ApiOperation({ summary: 'Prometheus metrics for this process' })
  async metrics(
    @Headers('authorization') authorization: string | undefined,
    @Res() reply: FastifyReply
  ) {
    const expected = loadEnv().METRICS_TOKEN

    if (expected) {
      const presented = authorization?.startsWith('Bearer ')
        ? authorization.slice('Bearer '.length)
        : undefined

      // Length-independent comparison is not worth reaching for here — the
      // token is fixed-length in practice and this endpoint is not an oracle
      // worth timing — but the failure IS deliberately indistinguishable
      // between "no token" and "wrong token", so a probe learns nothing about
      // whether it guessed the scheme right.
      if (presented !== expected) {
        throw errors.unauthenticated('This endpoint requires a metrics token.')
      }
    }

    const { body, contentType } = await scrape()

    return reply
      .header('content-type', contentType)
      // A scrape is a point-in-time reading; a cached one is a lie with a
      // timestamp on it.
      .header('cache-control', 'no-store')
      .send(body)
  }
}
