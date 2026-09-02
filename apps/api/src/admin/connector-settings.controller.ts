import { Body, Controller, Delete, Get, Param, Put, Query } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import {
  db,
  encrypt,
  keyProvider,
  withConnectorSettings,
  withConnectorSettingsWrite,
  withOrganization,
  withSystemScope,
} from '@smm/database'
import { PROVIDER_SETTING_KEYS, isProviderSettingKey, registry, settingSource } from '@smm/providers'
import { z } from 'zod'
import { CurrentUser } from '../auth/current-user.js'
import type { SessionPrincipal } from '../auth/session.service.js'
import { errors } from '../common/errors.js'
import { MembershipService } from '../tenancy/membership.service.js'
import { ConnectorSettingsService } from './connector-settings.service.js'

/**
 * Connector credentials, administered from the browser.
 *
 * Three rules shape everything here.
 *
 * WRITE-ONLY. No endpoint returns a stored value, ever. A secret that can be
 * read back through the API is a secret that leaves on the first XSS or the
 * first over-broad log line, and there is no legitimate reason for a browser to
 * need one — the value's job is to be sent to Meta by the server. What comes
 * back is a hint: the whole value for an app ID, the last four characters for a
 * secret. Enough to answer "is the right one in here?", useless to a thief.
 *
 * ALLOWLISTED KEYS. The key is a path parameter, and without a fixed list
 * `PUT /connector-settings/DATABASE_URL` would look like a perfectly ordinary
 * request. The list lives in @smm/providers next to the adapters that consume
 * it.
 *
 * SINGLE-ORGANIZATION BY DEFAULT. These values are deployment-global — see the
 * model comment — so on a deployment hosting several organizations, one org's
 * admin changing a Meta app would repoint every other org's connector at it.
 * That is refused rather than allowed-with-a-warning, unless the operator sets
 * ALLOW_SHARED_CONNECTOR_SETTINGS=true to say they are the only tenant that
 * matters. Same shape as ALLOW_INSECURE_COOKIES: a real deployment shape that
 * should be possible, but never silently.
 */
@ApiTags('admin')
@Controller('connector-settings')
export class ConnectorSettingsController {
  constructor(
    private readonly memberships: MembershipService,
    private readonly settings: ConnectorSettingsService
  ) {}

  private static readonly valueSchema = z.object({
    // 4096 is far above any real client secret and far below anything that
    // could be used to fill the table. Trimmed, because a trailing newline
    // pasted from a terminal is the single most common way a correct secret
    // fails authentication with an error naming something else entirely.
    value: z.string().trim().min(1).max(4096),
  })

  @Get()
  @ApiOperation({ summary: 'Which connector credentials are set, and from where' })
  async list(
    @Query('organizationId') organizationId: string,
    @CurrentUser() principal: SessionPrincipal | undefined
  ) {
    await this.requireAdmin(principal, organizationId)
    await this.settings.load()

    const rows = await withConnectorSettings(async (tx) =>
      tx.providerSetting.findMany({
        select: { key: true, hint: true, updatedAt: true, updatedBy: { select: { name: true } } },
      })
    )
    const stored = new Map(rows.map((row) => [row.key, row]))
    const shared = await this.sharedDeployment()
    const publicUrl = process.env['PUBLIC_URL'] ?? ''

    return {
      // Whether this screen can be used at all, and why not when it cannot. The
      // UI renders from this rather than deciding for itself.
      editable: !shared.blocked,
      ...(shared.blocked ? { readOnlyReason: shared.reason } : {}),

      // The redirect URI, ready to copy. This is the step people get wrong most
      // often, and every provider console rejects a mismatch with an error that
      // does not say which side is wrong.
      redirectUriBase: publicUrl + '/api/v1/social-accounts/callback',

      settings: PROVIDER_SETTING_KEYS.map((entry) => {
        const row = stored.get(entry.key)
        return {
          key: entry.key,
          provider: entry.provider,
          label: entry.label,
          secret: entry.secret,
          ...(entry.help ? { help: entry.help } : {}),
          // 'ui' | 'environment' | 'unset'. The distinction matters: someone who
          // cannot see that a value comes from the environment will type one
          // into an empty box, override it without knowing, and then be unable
          // to explain what happened when they clear the field.
          source: settingSource(entry.key),
          hint: row?.hint ?? null,
          updatedAt: row?.updatedAt?.toISOString() ?? null,
          updatedBy: row?.updatedBy?.name ?? null,
        }
      }),

      // What each provider still needs, so the screen can say "Pinterest:
      // ready" rather than making someone cross-reference two lists.
      providers: registry
        .all()
        .map(registry.describe)
        .filter((provider) => PROVIDER_SETTING_KEYS.some((k) => k.provider === provider.id))
        .map((provider) => ({
          id: provider.id,
          label: provider.label,
          configured: provider.configured,
          state: provider.state,
        })),
    }
  }

  @Put(':key')
  @ApiOperation({ summary: 'Set one connector credential' })
  async set(
    @Param('key') key: string,
    @Query('organizationId') organizationId: string,
    @Body() body: unknown,
    @CurrentUser() principal: SessionPrincipal | undefined
  ) {
    const userId = await this.requireAdmin(principal, organizationId)
    await this.requireEditable()

    const entry = PROVIDER_SETTING_KEYS.find((candidate) => candidate.key === key)
    if (!entry || !isProviderSettingKey(key)) throw errors.notFound('setting')

    const parsed = ConnectorSettingsController.valueSchema.safeParse(body)
    if (!parsed.success) throw errors.validation('A value is required.', 'value')

    const value = parsed.data.value
    const hint = ConnectorSettingsController.hintFor(value, entry.secret)
    const keys = keyProvider()

    await withConnectorSettingsWrite(async (tx) => {
      const data = {
        value: encrypt(value, keys),
        keyId: keys.current().keyId,
        hint,
        updatedById: userId,
      }
      await tx.providerSetting.upsert({ where: { key }, create: { key, ...data }, update: data })
    })

    // This process immediately, so the administrator's very next click sees the
    // change. Other API processes pick it up within the staleness window.
    await this.settings.load()
    await this.audit(organizationId, userId, 'connector_setting.set', key)

    return { key, hint, source: settingSource(key) }
  }

  @Delete(':key')
  @ApiOperation({ summary: 'Clear one connector credential' })
  async clear(
    @Param('key') key: string,
    @Query('organizationId') organizationId: string,
    @CurrentUser() principal: SessionPrincipal | undefined
  ) {
    const userId = await this.requireAdmin(principal, organizationId)
    await this.requireEditable()
    if (!isProviderSettingKey(key)) throw errors.notFound('setting')

    await withConnectorSettingsWrite(async (tx) => {
      await tx.providerSetting.deleteMany({ where: { key } })
    })

    await this.settings.load()
    await this.audit(organizationId, userId, 'connector_setting.cleared', key)

    // Clearing the override does not necessarily leave the key unset — the
    // environment may still supply one. Saying so is the difference between a
    // screen that explains itself and one that looks broken.
    return { key, hint: null, source: settingSource(key) }
  }

  /**
   * The whole value for an ID, the last four characters for a secret.
   *
   * App IDs are not secret — Meta puts them in the redirect URL — and masking
   * one costs an administrator the ability to check the most common mistake
   * there is, which is pasting the right value into the wrong field.
   */
  private static hintFor(value: string, secret: boolean): string {
    if (!secret) return value
    return value.length <= 4 ? '••••' : '••••' + value.slice(-4)
  }

  private async requireEditable(): Promise<void> {
    const shared = await this.sharedDeployment()
    if (shared.blocked) throw errors.validation(shared.reason, 'organizationId')
  }

  /**
   * Is this deployment hosting more than one organization?
   *
   * Counted rather than configured, so the answer cannot drift from reality.
   */
  private async sharedDeployment(): Promise<{ blocked: boolean; reason: string }> {
    if (process.env['ALLOW_SHARED_CONNECTOR_SETTINGS'] === 'true') {
      return { blocked: false, reason: '' }
    }

    const count = await withSystemScope('counting organizations', async () =>
      db().organization.count()
    )
    if (count <= 1) return { blocked: false, reason: '' }

    return {
      blocked: true,
      reason:
        'These credentials are shared by every organization on this deployment, and this one ' +
        'hosts more than one. Set them in the environment, or set ' +
        'ALLOW_SHARED_CONNECTOR_SETTINGS=true to allow editing them here.',
    }
  }

  private async audit(
    organizationId: string,
    userId: string,
    action: string,
    key: string
  ): Promise<void> {
    // The KEY, never the value. An audit log recording what a secret was is a
    // second copy of that secret, in a table nobody treats as sensitive.
    await withOrganization(organizationId, async (tx) => {
      await tx.auditLog.create({
        data: {
          organizationId,
          actorId: userId,
          action,
          entityType: 'ProviderSetting',
          entityId: key,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
      })
    })
  }

  private async requireAdmin(
    principal: SessionPrincipal | undefined,
    organizationId: string
  ): Promise<string> {
    if (!principal) throw errors.unauthenticated()
    if (!organizationId) {
      throw errors.validation('organizationId is required.', 'organizationId')
    }

    const role = await this.memberships.organizationRole(principal.userId, organizationId)
    if (role !== 'OWNER' && role !== 'ADMIN') {
      // 404 rather than 403, consistent with every other tenant boundary here:
      // not being an admin and the organization not existing look identical.
      throw errors.notFound('organization')
    }
    return principal.userId
  }
}
