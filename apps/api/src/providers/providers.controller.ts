import { Controller, Get } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import { registry, type ProviderDescriptor } from '@smm/providers'
import { CurrentUser } from '../auth/current-user.js'
import type { SessionPrincipal } from '../auth/session.service.js'
import { errors } from '../common/errors.js'
import { ConnectorSettingsService } from '../admin/connector-settings.service.js'

/**
 * The capability matrix, served at runtime.
 *
 * THE UI RENDERS CONTROLS FROM THIS RESPONSE AND NOTHING ELSE. That is what
 * makes "never fake unsupported functionality" structural rather than a
 * discipline someone has to remember: a provider without DMs has no DM
 * affordance because the data says so, not because a developer wrote an `if`.
 *
 * `configured` is deliberately separate from `state`. An implemented provider
 * the operator has not given credentials for is disabled for a reason they can
 * FIX; a skeleton is disabled for one they cannot. Collapsing the two would tell
 * someone to go looking for a setting that does not exist.
 */
@ApiTags('providers')
@Controller('social-providers')
export class ProvidersController {
  constructor(private readonly connectorSettings: ConnectorSettingsService) {}

  @Get()
  @ApiOperation({ summary: 'Capability matrix for every known provider' })
  async list(
    @CurrentUser() principal: SessionPrincipal | undefined
  ): Promise<ProviderDescriptor[]> {
    if (!principal) throw errors.unauthenticated()

    // `configured` is computed from the settings store, so a stale copy
    // here shows a provider as unconfigured after someone else configured
    // it — the one state this screen exists to report.
    await this.connectorSettings.refreshIfStale()

    return registry.all().map(registry.describe)
  }
}
