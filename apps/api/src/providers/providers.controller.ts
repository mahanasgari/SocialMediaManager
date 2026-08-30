import { Controller, Get } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import { registry, type ProviderDescriptor } from '@smm/providers'
import { CurrentUser } from '../auth/current-user.js'
import type { SessionPrincipal } from '../auth/session.service.js'
import { errors } from '../common/errors.js'

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
  @Get()
  @ApiOperation({ summary: 'Capability matrix for every known provider' })
  list(@CurrentUser() principal: SessionPrincipal | undefined): ProviderDescriptor[] {
    if (!principal) throw errors.unauthenticated()
    return registry.all().map(registry.describe)
  }
}
