import { Controller, Get, Post, Param } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import { withUser } from '@smm/database'
import { errors } from '../common/errors.js'
import { CurrentUser } from '../auth/current-user.js'
import type { SessionPrincipal } from '../auth/session.service.js'

/**
 * Notifications are PER USER, not per workspace.
 *
 * The bell shows everything waiting on you across every workspace you belong to
 * — scoping it to whichever workspace happens to be on screen would hide the
 * approval request that is the reason you opened the app. Same per-user RLS
 * actor the membership lookup uses.
 */
@ApiTags('notifications')
@Controller('notifications')
export class NotificationsController {
  @Get()
  @ApiOperation({ summary: 'Your unread notifications' })
  async list(@CurrentUser() principal: SessionPrincipal | undefined) {
    if (!principal) throw errors.unauthenticated()

    return withUser(
      principal.userId,
      'the notification bell spans every workspace a user belongs to',
      async (tx) =>
        tx.notification.findMany({
          where: { userId: principal.userId, readAt: null },
          select: { id: true, kind: true, title: true, body: true, href: true, createdAt: true },
          orderBy: { createdAt: 'desc' },
          take: 50,
        })
    )
  }

  @Post(':id/read')
  @ApiOperation({ summary: 'Mark one notification read' })
  async markRead(
    @Param('id') id: string,
    @CurrentUser() principal: SessionPrincipal | undefined
  ) {
    if (!principal) throw errors.unauthenticated()

    await withUser(principal.userId, 'marking your own notification read', async (tx) => {
      // Scoped by userId as well as id, so one user cannot mark another's
      // notification read by guessing an identifier.
      await tx.notification.updateMany({
        where: { id, userId: principal.userId, readAt: null },
        data: { readAt: new Date() },
      })
    })

    return { read: true }
  }
}
