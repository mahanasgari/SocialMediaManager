import { Controller, Get } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import { db, rlsStatus } from '@smm/database'
import { Public } from '../auth/auth-mode.guard.js'

type DependencyStatus = {
  name: string
  ok: boolean
  detail?: string
  latencyMs?: number
}

/**
 * Health endpoint consumed by the compose healthcheck and any orchestrator.
 *
 * Reports each dependency separately rather than a single boolean, because
 * "unhealthy" with no reason turns a two-minute diagnosis into a twenty-minute
 * one.
 *
 * It only reports on things the process ACTUALLY depends on right now. Listing
 * Redis and S3 before anything connects to them would be a health check that
 * cannot fail — which is worse than no health check, because it reads as
 * coverage. They are added as each becomes a real dependency.
 */
@ApiTags('operations')
@Controller('health')
export class HealthController {
  @Public()
  @Get()
  @ApiOperation({ summary: 'Liveness plus per-dependency status' })
  async check(): Promise<{
    status: 'ok' | 'degraded'
    dependencies: DependencyStatus[]
    security: { rowLevelSecurity: string }
  }> {
    const dependencies: DependencyStatus[] = [await this.probeDatabase()]

    let rls = 'unknown'
    try {
      const status = await rlsStatus(db())
      // Surfaced operationally because this is precisely the failure that looks
      // fine from the outside: RLS enabled, policies present, and silently
      // bypassed because the connected role is privileged.
      rls = status.enforced ? 'enforced' : `BYPASSED (${status.reasons.join(', ')})`
    } catch {
      rls = 'unknown'
    }

    return {
      status: dependencies.every((d) => d.ok) ? 'ok' : 'degraded',
      dependencies,
      security: { rowLevelSecurity: rls },
    }
  }

  private async probeDatabase(): Promise<DependencyStatus> {
    const started = Date.now()
    try {
      await db().$queryRaw`SELECT 1`
      return { name: 'postgres', ok: true, latencyMs: Date.now() - started }
    } catch (err) {
      return {
        name: 'postgres',
        ok: false,
        latencyMs: Date.now() - started,
        // The message, not the stack, and never the connection string.
        detail: err instanceof Error ? err.message.slice(0, 200) : 'unreachable',
      }
    }
  }
}
