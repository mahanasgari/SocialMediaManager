import { createParamDecorator } from '@nestjs/common'
import type { ExecutionContext } from '@nestjs/common'
import type { SessionPrincipal } from './session.service.js'

/** Populated by SessionGuard. Absent on public routes. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): SessionPrincipal | undefined =>
    ctx.switchToHttp().getRequest<{ principal?: SessionPrincipal }>().principal
)
