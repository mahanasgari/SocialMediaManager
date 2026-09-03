import { Module } from '@nestjs/common'
import { APP_FILTER, APP_GUARD } from '@nestjs/core'
import { HttpExceptionFilter } from './common/http-exception.filter.js'
import { AuthModeGuard } from './auth/auth-mode.guard.js'
import { SessionGuard } from './auth/session.guard.js'
import { AuthController } from './auth/auth.controller.js'
import { RecoveryController } from './auth/recovery.controller.js'
import { RecoveryService } from './auth/recovery.service.js'
import { AttemptLimiter } from '@smm/ratelimit'
import { Redis } from 'ioredis'
import { loadEnv } from '@smm/config'
import { AuthService } from './auth/auth.service.js'
import { SessionService } from './auth/session.service.js'
import { ApiKeyService } from './auth/api-key.service.js'
import { MembershipService } from './tenancy/membership.service.js'
import { WorkspacesController } from './workspaces/workspaces.controller.js'
import { ProvidersController } from './providers/providers.controller.js'
import { SocialAccountsController } from './providers/social-accounts.controller.js'
import { ConnectionsService } from './providers/connections.service.js'
import { PostsController } from './posts/posts.controller.js'
import { QueueController } from './posts/queue.controller.js'
import { CalendarController } from './posts/calendar.controller.js'
import { AnalyticsController } from './analytics/analytics.controller.js'
import { MediaController } from './media/media.controller.js'
import { ApiKeysController } from './platform/api-keys.controller.js'
import { IntegrationsController } from './platform/integrations.controller.js'
import { LinksController } from './links/links.controller.js'
import { OrganisationController } from './organisation/organisation.controller.js'
import { RecurrenceController } from './recurrence/recurrence.controller.js'
import { ExportsController } from './exports/exports.controller.js'
import { ReportsController } from './reports/reports.controller.js'
import { ApprovalsController } from './approvals/approvals.controller.js'
import { NotificationsController } from './notifications/notifications.controller.js'
import { PublishService } from './posts/publish.service.js'
import { InboxController } from './inbox/inbox.controller.js'
import { InboundController } from './inbox/inbound.controller.js'
import { AdminController } from './admin/admin.controller.js'
import { ConnectorSettingsController } from './admin/connector-settings.controller.js'
import { ConnectorSettingsService } from './admin/connector-settings.service.js'
import { HealthController } from './health/health.controller.js'
import { MetricsController } from './health/metrics.controller.js'

/**
 * Both guards are global, and routes opt OUT with @Public().
 *
 * The opposite default — opt IN with @Protected() — means a forgotten decorator
 * silently exposes an endpoint and nothing about the code looks wrong. This way
 * a forgotten decorator produces a 401 somebody notices immediately.
 *
 * Order matters: AuthModeGuard decides WHICH credential applies (and rejects
 * ambiguity) before SessionGuard resolves WHO it belongs to.
 */
@Module({
  controllers: [
    AuthController,
    RecoveryController,
    WorkspacesController,
    ProvidersController,
    SocialAccountsController,
    PostsController,
    QueueController,
    CalendarController,
    AnalyticsController,
    MediaController,
    ApiKeysController,
    IntegrationsController,
    LinksController,
    ReportsController,
    ApprovalsController,
    NotificationsController,
    InboxController,
    InboundController,
    OrganisationController,
    RecurrenceController,
    ExportsController,
    AdminController,
    ConnectorSettingsController,
    HealthController,
    MetricsController,
  ],
  providers: [
    ConnectorSettingsService,
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
    { provide: APP_GUARD, useClass: AuthModeGuard },
    { provide: APP_GUARD, useClass: SessionGuard },
    AuthService,
    RecoveryService,
    {
      // One Redis connection for the limiter, shared across requests. A
      // connection per request would exhaust the pool under exactly the load
      // this is meant to survive.
      provide: AttemptLimiter,
      useFactory: () => new AttemptLimiter(new Redis(loadEnv().REDIS_URL)),
    },
    SessionService,
    ApiKeyService,
    MembershipService,
    ConnectionsService,
    PublishService,
  ],
})
export class AppModule {}
