import { Catch, HttpException, Logger } from '@nestjs/common'
import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { AppError, errors, normalize, toEnvelope } from './errors.js'
import { REQUEST_ID_HEADER } from './request-id.js'

/**
 * Turns every thrown value into the documented error envelope.
 *
 * Registered globally, so there is exactly one place where a failure becomes a
 * response. Handlers throw domain errors and never shape HTTP themselves —
 * otherwise the envelope drifts per endpoint and clients cannot rely on it.
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('HttpExceptionFilter')

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp()
    const reply = ctx.getResponse<FastifyReply>()
    const request = ctx.getRequest<FastifyRequest>()
    const requestId = (request.headers[REQUEST_ID_HEADER] as string | undefined) ?? 'unknown'

    const appError = this.toAppError(exception)

    // 5xx means we broke something: log the cause. 4xx is the caller's business
    // and would only add noise at scale.
    if (appError.status >= 500) {
      this.logger.error(
        { requestId, code: appError.code, path: request.url, method: request.method },
        appError.internal instanceof Error ? appError.internal.stack : String(appError.internal)
      )
    }

    if (appError.status === 429 && typeof appError.details?.['retryAfterSeconds'] === 'number') {
      void reply.header('retry-after', String(appError.details['retryAfterSeconds']))
    }

    void reply
      .status(appError.status)
      .header(REQUEST_ID_HEADER, requestId)
      .send(toEnvelope(appError, requestId))
  }

  private toAppError(exception: unknown): AppError {
    if (exception instanceof AppError) return exception

    // Nest's own exceptions (validation pipes, route guards, 404s) arrive as
    // HttpException. Map them into the envelope rather than letting Nest's
    // default shape leak alongside ours.
    if (exception instanceof HttpException) {
      const status = exception.getStatus()
      const response = exception.getResponse()
      const message =
        typeof response === 'string'
          ? response
          : ((response as { message?: string | string[] }).message ?? exception.message)

      return new AppError({
        status,
        code: httpCodeFor(status),
        message: Array.isArray(message) ? message.join(' ') : message,
        internal: exception,
      })
    }

    // Fastify's own errors — a malformed JSON body, an unsupported
    // content-type, a body over the size limit — never reach a controller,
    // because the parser rejects them first. They carry a correct statusCode
    // that must be honoured: reporting a client's malformed request as a 500
    // tells them the server is broken and sends them to look in the wrong
    // place, while also burying real 500s in noise.
    if (isFastifyError(exception)) {
      return new AppError({
        status: exception.statusCode,
        code: httpCodeFor(exception.statusCode),
        message: exception.message,
        internal: exception,
      })
    }

    return normalize(exception)
  }
}

function isFastifyError(
  exception: unknown
): exception is Error & { statusCode: number; code: string } {
  if (!(exception instanceof Error)) return false
  const candidate = exception as Error & { statusCode?: unknown; code?: unknown }
  return (
    typeof candidate.statusCode === 'number' &&
    // Fastify's codes are all FST_ERR_*. Checked so an arbitrary error that
    // happens to carry a numeric `statusCode` cannot choose its own status.
    typeof candidate.code === 'string' &&
    candidate.code.startsWith('FST_ERR_')
  )
}

function httpCodeFor(status: number): string {
  switch (status) {
    case 400:
      return 'validation_failed'
    case 401:
      return 'unauthenticated'
    case 403:
      return 'forbidden'
    case 404:
      return 'not_found'
    case 409:
      return 'conflict'
    case 422:
      return 'unprocessable'
    case 429:
      return 'rate_limited'
    case 503:
      return 'dependency_unavailable'
    default:
      return status >= 500 ? 'internal_error' : 'request_failed'
  }
}

export { errors }
