import { Injectable } from '@nestjs/common'
import { encrypt, keyIdOf, keyProvider, withOrganization, withTenant } from '@smm/database'
import type { DiscoveredAccount } from '@smm/providers'
import { errors } from '../common/errors.js'

/**
 * Connect, reconnect and disconnect.
 *
 * The disconnect cascade is the part worth reading carefully. Each rule exists
 * because the obvious alternative is worse:
 *
 *   * The credential is HARD-deleted. A soft-deleted secret is still a secret
 *     sitting in the database, and no retention policy makes that acceptable.
 *   * The account row SURVIVES as DISCONNECTED, so published-post attribution
 *     and historical metrics do not vanish along with the connection.
 *   * Scheduled work targeting the account is cancelled AND the workspace is
 *     notified. Silently dropping someone's content calendar is worse than the
 *     disconnect itself, because they find out by noticing nothing was posted.
 */

export type ConnectResult = {
  connected: Array<{ id: string; handle: string; displayName: string; reconnected: boolean }>
}

@Injectable()
export class ConnectionsService {
  /**
   * Persists discovered accounts.
   *
   * Matching is on `(workspaceId, provider, providerAccountId)`. A reconnect
   * restores the EXISTING row rather than inserting a second one — duplicates
   * would fracture analytics history and break the uniqueness that inbound
   * webhook fan-out depends on.
   */
  async connect(
    workspaceId: string,
    organizationId: string,
    provider: string,
    discovered: DiscoveredAccount[],
    actorId: string
  ): Promise<ConnectResult> {
    if (discovered.length === 0) {
      throw errors.unprocessable(
        'no_accounts_returned',
        'The provider completed sign-in but returned no accounts to connect.'
      )
    }

    const keys = keyProvider()

    return withTenant(workspaceId, async (tx) => {
      const connected: ConnectResult['connected'] = []

      for (const account of discovered) {
        const existing = await tx.socialAccount.findFirst({
          where: { provider, providerAccountId: account.providerAccountId },
          select: { id: true, status: true },
        })

        const data = {
          provider,
          providerAccountId: account.providerAccountId,
          handle: account.handle,
          displayName: account.displayName,
          avatarUrl: account.avatarUrl ?? null,
          surfaces: [] as string[],
          platformMeta: (account.platformMeta ?? {}) as object,
          status: 'ACTIVE' as const,
          statusReason: null,
          lastSyncedAt: new Date(),
          deletedAt: null,
        }

        const row = existing
          ? await tx.socialAccount.update({
              where: { id: existing.id },
              data,
              select: { id: true, handle: true, displayName: true },
            })
          : await tx.socialAccount.create({
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              data: { ...data, organizationId } as any,
              select: { id: true, handle: true, displayName: true },
            })

        const accessToken = encrypt(account.credential.accessToken, keys)
        const refreshToken = account.credential.refreshToken
          ? encrypt(account.credential.refreshToken, keys)
          : null

        await tx.oAuthCredential.upsert({
          where: { socialAccountId: row.id },
          create: {
            socialAccountId: row.id,
            accessToken,
            refreshToken,
            expiresAt: account.credential.expiresAt ?? null,
            scopes: [...account.credential.scopes],
            keyId: keyIdOf(accessToken) ?? 'unknown',
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } as any,
          update: {
            accessToken,
            refreshToken,
            expiresAt: account.credential.expiresAt ?? null,
            scopes: [...account.credential.scopes],
            keyId: keyIdOf(accessToken) ?? 'unknown',
          },
        })

        await tx.auditLog.create({
          data: {
            workspaceId,
            actorId,
            action: existing ? 'account.reconnected' : 'account.connected',
            entityType: 'SocialAccount',
            entityId: row.id,
            metadata: { provider, handle: account.handle },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } as any,
        })

        connected.push({ ...row, reconnected: Boolean(existing) })
      }

      return { connected }
    })
  }

  /**
   * Disconnects an account.
   *
   * Returns what was cancelled so the caller can tell the user plainly. "We also
   * cancelled 3 scheduled posts" is the difference between a disconnect they
   * understand and one that quietly eats a week of planning.
   */
  async disconnect(
    workspaceId: string,
    accountId: string,
    actorId: string,
    reason = 'Disconnected by a workspace member.'
  ): Promise<{ cancelledScheduled: number }> {
    return withTenant(workspaceId, async (tx) => {
      const account = await tx.socialAccount.findUnique({
        where: { id: accountId },
        select: { id: true, provider: true, handle: true },
      })
      if (!account) throw errors.notFound('connected account')

      // Hard delete, always. deleteMany rather than delete so a missing
      // credential (already disconnected) is not an error — disconnect must be
      // idempotent.
      await tx.oAuthCredential.deleteMany({ where: { socialAccountId: accountId } })

      await tx.socialAccount.update({
        where: { id: accountId },
        data: { status: 'DISCONNECTED', statusReason: reason, deletedAt: null },
      })

      // Scheduled variants targeting this account are cancelled in Phase 4,
      // where PostVariant exists. The count is plumbed through now so the
      // notification copy does not have to change later.
      const cancelledScheduled = 0

      await tx.auditLog.create({
        data: {
          workspaceId,
          actorId,
          action: 'account.disconnected',
          entityType: 'SocialAccount',
          entityId: accountId,
          metadata: { provider: account.provider, handle: account.handle, cancelledScheduled },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
      })

      return { cancelledScheduled }
    })
  }

  /** Flags an account as needing reconnection. Never burns retries on it. */
  async markNeedsReauth(workspaceId: string, accountId: string, reason: string): Promise<void> {
    await withTenant(workspaceId, async (tx) => {
      await tx.socialAccount.update({
        where: { id: accountId },
        data: { status: 'NEEDS_REAUTH', statusReason: reason },
      })
    })
  }

  async list(workspaceId: string) {
    return withTenant(workspaceId, async (tx) =>
      tx.socialAccount.findMany({
        select: {
          id: true,
          provider: true,
          providerAccountId: true,
          handle: true,
          displayName: true,
          avatarUrl: true,
          status: true,
          statusReason: true,
          lastSyncedAt: true,
          // The credential is never selected here. There is no legitimate reason
          // for a listing endpoint to load a token, and not selecting it means a
          // future serialisation mistake cannot leak one.
        },
        orderBy: { createdAt: 'asc' },
      })
    )
  }

  /** Org-level view of every connected channel across a client's workspaces. */
  async listForOrganization(organizationId: string) {
    return withOrganization(organizationId, async (tx) =>
      tx.socialAccount.findMany({
        select: { id: true, workspaceId: true, provider: true, handle: true, status: true },
        orderBy: { createdAt: 'asc' },
      })
    )
  }
}
