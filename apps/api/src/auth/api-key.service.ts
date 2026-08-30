import { Injectable } from '@nestjs/common'
import { hashApiKey } from '@smm/auth'
import { withApiKeyAuth, withTenant } from '@smm/database'

/**
 * API-key authentication.
 *
 * The key is what establishes WHICH workspace a request belongs to, so the
 * lookup necessarily runs before any tenant scope exists. It uses a narrow,
 * named database actor that can SELECT from ApiKey and nothing else — it cannot
 * reach a credential, a post, or a workspace. Everything after resolution runs
 * under a normal tenant scope.
 */

export type ApiPrincipal = {
  kind: 'apiKey'
  apiKeyId: string
  workspaceId: string
  organizationId: string
  scopes: string[]
}

/** How stale lastUsedAt may get before a write is worth doing. */
const TOUCH_INTERVAL_MS = 5 * 60_000

@Injectable()
export class ApiKeyService {
  async resolve(token: string): Promise<ApiPrincipal | null> {
    const keyHash = hashApiKey(token)

    const key = await withApiKeyAuth(async (tx) =>
      tx.apiKey.findUnique({
        // Looked up by HASH. The plaintext is not stored, so a database read
        // cannot yield a usable credential.
        where: { keyHash },
        select: {
          id: true,
          workspaceId: true,
          organizationId: true,
          scopes: true,
          revokedAt: true,
          expiresAt: true,
          lastUsedAt: true,
        },
      })
    )

    if (!key) return null
    if (key.revokedAt) return null
    if (key.expiresAt && key.expiresAt.getTime() <= Date.now()) return null

    if (!key.lastUsedAt || Date.now() - key.lastUsedAt.getTime() > TOUCH_INTERVAL_MS) {
      // Fire-and-forget: failing to record usage must not fail the request.
      void withTenant(key.workspaceId, async (tx) => {
        await tx.apiKey.update({ where: { id: key.id }, data: { lastUsedAt: new Date() } })
      }).catch(() => undefined)
    }

    return {
      kind: 'apiKey',
      apiKeyId: key.id,
      workspaceId: key.workspaceId,
      organizationId: key.organizationId,
      scopes: key.scopes,
    }
  }

  /**
   * Whether a key may perform an operation.
   *
   * Scopes are checked separately from roles because a key is not a person: it
   * has no role and inherits none. A key created by an owner is not an owner —
   * it can do exactly what its scopes list and nothing more, so a leaked key is
   * bounded by what it was issued for.
   */
  static hasScope(principal: ApiPrincipal, scope: string): boolean {
    return principal.scopes.includes(scope)
  }
}
