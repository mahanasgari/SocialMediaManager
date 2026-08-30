import { Controller, Get, Query } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import { withOrganization, withScheduler, withTenant } from '@smm/database'
import { registry } from '@smm/providers'
import { errors } from '../common/errors.js'
import { CurrentUser } from '../auth/current-user.js'
import type { SessionPrincipal } from '../auth/session.service.js'
import { MembershipService } from '../tenancy/membership.service.js'

/**
 * The operator's view.
 *
 * Everything here answers one question: is this installation actually working?
 * A self-hosted deployment has no support team watching dashboards, so the
 * things that fail SILENTLY need somewhere to be visible — a stalled scheduler,
 * a webhook subscription that was auto-disabled, inbound events matching no
 * account, a token that expired last Tuesday.
 *
 * Organization-scoped, not workspace-scoped: these are properties of the
 * deployment, and a workspace member has no business seeing another workspace's
 * failure counts.
 */
@ApiTags('admin')
@Controller('admin')
export class AdminController {
  constructor(private readonly memberships: MembershipService) {}

  @Get('overview')
  @ApiOperation({ summary: 'Operational health of this installation' })
  async overview(
    @Query('organizationId') organizationId: string,
    @CurrentUser() principal: SessionPrincipal | undefined
  ) {
    const now = new Date()
    await this.requireAdmin(principal, organizationId)

    const [scheduler, inbound, delivery, accounts, feeds] = await Promise.all([
      this.scheduler(organizationId, now),
      this.inbound(),
      this.delivery(organizationId),
      this.accounts(organizationId, now),
      this.feeds(organizationId, now),
    ])

    return {
      generatedAt: now.toISOString(),
      scheduler,
      inbound,
      delivery,
      accounts,
      feeds,
      providers: this.providers(),
    }
  }

  /**
   * Is the scheduler keeping up?
   *
   * `overdue` is the number that matters and the one no dashboard usually
   * shows: rows whose time has passed and which are still not published. A
   * healthy installation sits at zero except for the seconds between a tick and
   * its publish.
   */
  private async scheduler(organizationId: string, now: Date) {
    return withOrganization(organizationId, async (tx) => {
      const [scheduled, queued, overdue, publishing, failed, missed, needsReview] =
        await Promise.all([
          tx.postVariant.count({ where: { status: 'SCHEDULED' } }),
          tx.postVariant.count({ where: { status: 'QUEUED' } }),
          tx.postVariant.count({
            where: { status: { in: ['SCHEDULED', 'QUEUED'] }, post: { scheduledAt: { lt: now } } },
          }),
          tx.postVariant.count({ where: { status: { in: ['PUBLISHING', 'PREPARING_MEDIA'] } } }),
          tx.postVariant.count({ where: { status: 'FAILED' } }),
          tx.postVariant.count({ where: { status: 'MISSED' } }),
          tx.postVariant.count({ where: { status: 'NEEDS_REVIEW' } }),
        ])

      const oldest = await tx.postVariant.findFirst({
        where: { status: { in: ['SCHEDULED', 'QUEUED'] }, post: { scheduledAt: { lt: now } } },
        orderBy: { post: { scheduledAt: 'asc' } },
        select: { post: { select: { scheduledAt: true } } },
      })

      const oldestOverdueSeconds = oldest?.post.scheduledAt
        ? Math.round((now.getTime() - oldest.post.scheduledAt.getTime()) / 1000)
        : null

      return {
        scheduled,
        queued,
        publishing,
        overdue,
        oldestOverdueSeconds,
        failed,
        missed,
        needsReview,
        // A judgement, not raw numbers. The point of an operator view is to say
        // whether something needs attention, and one tick of overdue is normal.
        healthy: oldestOverdueSeconds === null || oldestOverdueSeconds < 120,
      }
    })
  }

  /**
   * Inbound event routing.
   *
   * Unrouted volume is the metric worth watching: a sustained rise means a
   * subscription is pointed at us for an account nobody has connected, and every
   * one of those events is being dropped. It is invisible otherwise, because
   * dropping them is the correct behaviour and nothing errors.
   */
  private async inbound() {
    return withScheduler(async (tx) => {
      const dayAgo = new Date(Date.now() - 86_400_000)

      const [received, unrouted, pending, failed] = await Promise.all([
        tx.inboundEvent.count({ where: { receivedAt: { gte: dayAgo } } }),
        tx.unroutedInboundEvent.count({ where: { receivedAt: { gte: dayAgo } } }),
        tx.inboundEventDelivery.count({ where: { status: 'PENDING' } }),
        tx.inboundEventDelivery.count({ where: { status: 'FAILED' } }),
      ])

      const recentUnrouted = await tx.unroutedInboundEvent.findMany({
        orderBy: { receivedAt: 'desc' },
        take: 5,
        select: { id: true, provider: true, providerAccountId: true, receivedAt: true },
      })

      return { received, unrouted, pending, failed, recentUnrouted }
    })
  }

  /**
   * Outbound webhooks that have been auto-disabled or are failing.
   *
   * Split across two scopes on purpose. `Webhook` carries an organizationId and
   * can be counted in one query; `WebhookDelivery` carries only a workspaceId,
   * like every other child record that is always reached through a
   * workspace-scoped parent. The tenancy guard REFUSES to query it under an
   * organization scope, which is correct — so the delivery count is summed per
   * workspace rather than the model being given a tenancy column it does not
   * otherwise need.
   *
   * An organization has a handful of workspaces, so this is a handful of cheap
   * counts on an admin page, not a hot path.
   */
  private async delivery(organizationId: string) {
    const { totals, workspaceIds } = await withOrganization(organizationId, async (tx) => {
      const [total, disabled, failing] = await Promise.all([
        tx.webhook.count(),
        tx.webhook.count({ where: { disabledAt: { not: null } } }),
        tx.webhook.count({ where: { consecutiveFailures: { gt: 0 }, disabledAt: null } }),
      ])
      const workspaces = await tx.workspace.findMany({
        where: { deletedAt: null },
        select: { id: true },
      })
      return { totals: { total, disabled, failing }, workspaceIds: workspaces.map((w) => w.id) }
    })

    let undelivered = 0
    for (const workspaceId of workspaceIds) {
      undelivered += await withTenant(workspaceId, async (tx) =>
        tx.webhookDelivery.count({ where: { deliveredAt: null } })
      )
    }

    return { ...totals, undelivered }
  }

  /**
   * Accounts that will stop working, ideally before they do.
   *
   * A token expiring in three days is a scheduled post that will fail next week,
   * and the only cheap moment to fix it is now.
   */
  private async accounts(organizationId: string, now: Date) {
    return withOrganization(organizationId, async (tx) => {
      const soon = new Date(now.getTime() + 7 * 86_400_000)

      const rows = await tx.socialAccount.findMany({
        where: { deletedAt: null },
        select: {
          id: true,
          handle: true,
          provider: true,
          status: true,
          workspaceId: true,
          credential: { select: { expiresAt: true } },
        },
      })

      const expiring = rows.filter(
        (a) => a.credential?.expiresAt && a.credential.expiresAt <= soon
      )

      return {
        total: rows.length,
        active: rows.filter((a) => a.status === 'ACTIVE').length,
        disconnected: rows.filter((a) => a.status === 'DISCONNECTED').length,
        needsReauth: rows.filter((a) => a.status === 'NEEDS_REAUTH').length,
        expiringSoon: expiring.map((a) => ({
          id: a.id,
          handle: a.handle,
          provider: a.provider,
          workspaceId: a.workspaceId,
          expiresAt: a.credential?.expiresAt?.toISOString() ?? null,
          // Negative means it already expired, which is a different and more
          // urgent problem than one that is about to.
          daysLeft: a.credential?.expiresAt
            ? Math.floor((a.credential.expiresAt.getTime() - now.getTime()) / 86_400_000)
            : null,
        })),
      }
    })
  }

  /** Feeds that have stopped fetching. */
  private async feeds(organizationId: string, now: Date) {
    return withOrganization(organizationId, async (tx) => {
      const stale = new Date(now.getTime() - 3 * 3600_000)

      const rows = await tx.rSSFeed.findMany({
        where: { deletedAt: null },
        select: { id: true, name: true, pausedAt: true, lastFetchedAt: true },
      })

      return {
        total: rows.length,
        paused: rows.filter((f) => f.pausedAt).length,
        // Never fetched, or not fetched in three hours despite a 15-minute
        // interval — which means it is failing every time and being retried
        // silently.
        stalled: rows.filter(
          (f) => !f.pausedAt && (!f.lastFetchedAt || f.lastFetchedAt < stale)
        ).length,
      }
    })
  }

  /** What the registry says, so an operator can see configuration at a glance. */
  private providers() {
    const all = registry.all().map((p) => registry.describe(p))
    return {
      implemented: all.filter((p) => p.state === 'implemented').length,
      skeleton: all.filter((p) => p.state === 'skeleton').length,
      configured: all.filter((p) => p.configured && p.state === 'implemented').length,
      /** Implemented but missing credentials — a fixable problem, unlike a skeleton. */
      unconfigured: all
        .filter((p) => p.state === 'implemented' && !p.configured)
        .map((p) => ({ id: p.id, label: p.label, reason: p.disabledReason })),
    }
  }

  /**
   * Only an organization owner or admin.
   *
   * Checked against the ORGANIZATION-level membership row, not a workspace one:
   * a workspace admin administers their workspace, and this page is about the
   * whole installation.
   */
  private async requireAdmin(
    principal: SessionPrincipal | undefined,
    organizationId: string
  ): Promise<void> {
    if (!principal) throw errors.unauthenticated()
    if (!organizationId) {
      throw errors.validation('organizationId is required.', 'organizationId')
    }

    const role = await this.memberships.organizationRole(principal.userId, organizationId)
    if (role !== 'OWNER' && role !== 'ADMIN') {
      // 404 rather than 403, consistent with every other tenant boundary: not
      // being an admin and the organization not existing look identical.
      throw errors.notFound('organization')
    }
  }
}
