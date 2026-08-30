import { Redis } from 'ioredis'
import { loadEnv } from '@smm/config'
import { decrypt, keyProvider, withTenant } from '@smm/database'
import { ProviderError, registry, windowMs, type AnyProvider } from '@smm/providers'
import { publicUrlFor } from '@smm/storage'
import { AccountMutex, RateLimiter, type BudgetSpec } from '@smm/ratelimit'
import {
  derivePostStatus,
  shouldDerive,
  fingerprintFor,
  findMatch,
  idempotencyKey,
  serialiseFingerprint,
  type VariantStatus,
} from './index.js'

/**
 * The publishing pipeline — shared by the API ("publish now") and the worker
 * (scheduled publishing).
 *
 * It lives here rather than in either app because both need it and neither owns
 * it. A copy in each would be two implementations of the rule that decides
 * whether a post is duplicated.
 *
 *   Validate -> resolve provider -> check capabilities
 *   -> ACQUIRE BUDGET            (denial: defer, and write NO attempt row)
 *   -> WRITE-AHEAD ATTEMPT       (own committed transaction)
 *   -> publish -> store response -> update variant
 *
 * The ordering of the last two is the invariant everything else rests on. A job
 * denied by OUR OWN budget must not create an IN_FLIGHT attempt record, because
 * to the reconciler that is indistinguishable from a job that may have reached
 * the provider — and the reconciler's job is to decide exactly that.
 */

/**
 * Turns a stored asset into one the given surface will accept.
 *
 * Injected rather than imported. Transcoding shells out to ffmpeg, and this
 * package must stay runnable without it — the API imports the status reducer and
 * the fingerprint logic from here, and neither should drag a media toolchain
 * into a web process.
 *
 * So publishing declares WHAT it needs and the worker supplies HOW. Omitted, the
 * original asset is published unchanged, which is exactly right for a deployment
 * that has no ffmpeg.
 */
export type MediaPreparer = (
  workspaceId: string,
  organizationId: string,
  asset: { id: string; storageKey: string; mime: string },
  providerId: string,
  surface: string
) => Promise<{ storageKey: string; mime: string; original: boolean; reasons: string[] }>

export class Publisher {
  private readonly logger = console
  private readonly redis: Redis
  private readonly limiter: RateLimiter
  private readonly mutex: AccountMutex
  private readonly prepareMedia: MediaPreparer | undefined

  constructor(options: { prepareMedia?: MediaPreparer } = {}) {
    this.redis = new Redis(loadEnv().REDIS_URL, { maxRetriesPerRequest: null })
    this.limiter = new RateLimiter(this.redis)
    this.mutex = new AccountMutex(this.redis)
    this.prepareMedia = options.prepareMedia
  }

  /** Publishes one variant. Returns its resulting status. */
  async publishVariant(workspaceId: string, variantId: string): Promise<VariantStatus> {
    const context = await this.loadContext(workspaceId, variantId)
    if (!context) return 'FAILED'

    const { variant, account, provider, content, media } = context

    if (!provider.isConfigured() || provider.state === 'skeleton') {
      return this.fail(
        workspaceId,
        variantId,
        'PermanentFailure',
        `${provider.label} is not available on this deployment, so this post cannot be published.`
      )
    }

    // Media is resolved to URLs the PLATFORM can fetch. Instagram and others
    // pull rather than accept an upload, so this is where MEDIA_PUBLIC_MODE
    // decides between a presigned storage URL, our relay, or an honest refusal.
    const attachments: Array<{ url: string; mime: string; altText?: string }> = []
    for (const asset of media) {
      // Re-encoded first, where the surface needs it. A video that does not
      // conform is rejected by the platform AFTER upload, often with a message
      // that does not say why — so it is fixed here rather than discovered
      // there.
      let key = asset.storageKey
      let mime = asset.mime

      if (this.prepareMedia) {
        await this.markPreparingMedia(workspaceId, variantId)
        try {
          const prepared = await this.prepareMedia(
            workspaceId,
            variant.organizationId,
            { id: asset.id, storageKey: asset.storageKey, mime: asset.mime },
            provider.id,
            variant.surface
          )
          key = prepared.storageKey
          mime = prepared.mime
          if (!prepared.original) {
            this.logger.info(
              `variant ${variantId}: ${prepared.reasons.join('; ') || 're-encoded'}`
            )
          }
        } catch (error) {
          return this.fail(
            workspaceId,
            variantId,
            'InvalidMedia',
            error instanceof Error ? error.message : 'That media could not be prepared.'
          )
        }
      }

      const resolved = await publicUrlFor(asset.id, workspaceId, key)
      // The discriminant narrows to the disabled case, which is the only one
      // carrying a reason — and the only one where publishing genuinely cannot
      // proceed rather than merely failing.
      if (resolved.mode === 'disabled') {
        return this.fail(workspaceId, variantId, 'InvalidMedia', resolved.reason)
      }
      attachments.push({
        url: resolved.url,
        // The PREPARED mime, not the original: a file re-encoded from MOV to
        // MP4 has to be announced as what it now is.
        mime,
        ...(asset.altText ? { altText: asset.altText } : {}),
      })
    }

    // Pure validation, the same code the composer ran. A payload that cannot be
    // published should never have reached here, but the worker checks again
    // because the composer's copy of the rules is a convenience, not a gate.
    const issues = provider.validate({
      surface: variant.surface as never,
      text: content,
      media: media.map((m) => ({ mime: m.mime, bytes: m.bytes, ...(m.width ? { width: m.width } : {}), ...(m.height ? { height: m.height } : {}) })),
    })
    const errors = issues.filter((i) => i.severity === 'error')
    if (errors.length > 0) {
      return this.fail(workspaceId, variantId, 'ContentRejected', errors[0]!.message)
    }

    // One publish in flight per account. Prevents thread ordering corruption and
    // guarantees a stale IN_FLIGHT attempt has exactly one candidate.
    const lease = await this.mutex.acquire(
      provider.id,
      account.providerAccountId,
      2 * 60_000
    )
    if (!lease) {
      this.logger.info(`variant ${variantId} deferred: another publish holds the account lease`)
      return 'QUEUED'
    }

    try {
      const budget = this.budgetFor(provider, account.id, 'publish')
      if (budget) {
        const acquired = await this.limiter.acquire(budget)
        if (!acquired.granted) {
          // Deferred, NOT failed, and deliberately before any attempt row exists.
          this.logger.info(`variant ${variantId} deferred ${acquired.waitMs}ms: budget exhausted`)
          return 'QUEUED'
        }
      }

      const key = idempotencyKey(variantId, content, attachments.length)
      const fingerprint = fingerprintFor(content, attachments.length, account.id)

      // Write-ahead, in its OWN committed transaction, before the provider call.
      await withTenant(workspaceId, async (tx) => {
        await tx.postVariant.update({
          where: { id: variantId },
          data: {
            status: 'PUBLISHING',
            idempotencyKey: key,
            fingerprint: serialiseFingerprint(fingerprint),
            attempts: { increment: 1 },
          },
        })
        await tx.publishAttempt.create({
          data: {
            postVariantId: variantId,
            idempotencyKey: key,
            status: 'IN_FLIGHT',
            fenceToken: lease.token,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } as any,
        })
      })

      const startedAt = new Date()

      try {
        const result = await provider.publish(
          {
            id: account.id,
            providerAccountId: account.providerAccountId,
            handle: account.handle,
            displayName: account.displayName,
            platformMeta: account.platformMeta as Record<string, unknown>,
          },
          account.credential,
          { surface: variant.surface as never, text: content, media: attachments, idempotencyKey: key }
        )

        // The lease may have expired during a slow call. Writing anyway would
        // reintroduce concurrency inside the mechanism reconciliation relies on.
        if (!(await this.mutex.isHeldBy(provider.id, account.providerAccountId, lease.token))) {
          this.logger.warn(`variant ${variantId} lost its lease mid-publish; leaving for reconciliation`)
          return 'NEEDS_REVIEW'
        }

        await this.succeed(workspaceId, variantId, key, result.remoteId, result.remoteUrl)
        return 'PUBLISHED'
      } catch (err) {
        return await this.handleFailure(
          workspaceId,
          variantId,
          key,
          provider,
          account,
          fingerprint,
          startedAt,
          err
        )
      }
    } finally {
      await this.mutex.release(provider.id, account.providerAccountId, lease.token)
    }
  }

  /**
   * Decides what a provider failure means.
   *
   * The important branch is the one where we genuinely do not know: the call
   * failed, but the post may have landed anyway. Retrying there is how a
   * duplicate public post happens, and a duplicate is unrecoverable.
   */
  private async handleFailure(
    workspaceId: string,
    variantId: string,
    key: string,
    provider: AnyProvider,
    account: { id: string; providerAccountId: string; handle: string; displayName: string; platformMeta: unknown; credential: { accessToken: string; scopes: string[] } },
    fingerprint: ReturnType<typeof fingerprintFor>,
    startedAt: Date,
    err: unknown
  ): Promise<VariantStatus> {
    const error =
      err instanceof ProviderError
        ? err
        : new ProviderError(provider.id, 'ProviderDown', 'The provider did not respond.')

    if (error.code === 'RateLimited') {
      const budget = this.budgetFor(provider, account.id, 'publish')
      if (budget) {
        // The provider's own 429 is the authoritative signal that our documented
        // limit was wrong. Not a failure, so no retry is burned.
        await this.limiter.penalise(
          budget,
          provider.limits.onProviderLimit.backoffFactor,
          windowMs(provider.limits.onProviderLimit.recoverAfter)
        )
      }
      await this.markAttempt(workspaceId, variantId, key, 'RATE_LIMITED', error.code)
      return 'QUEUED'
    }

    if (error.requiresReauth) {
      // No amount of waiting fixes a revoked token. Flag the account and stop.
      await withTenant(workspaceId, async (tx) => {
        await tx.socialAccount.update({
          where: { id: account.id },
          data: { status: 'NEEDS_REAUTH', statusReason: error.message },
        })
      })
      return this.fail(workspaceId, variantId, error.code, error.message)
    }

    // Ambiguous: the call did not return, but the post may have landed.
    if (error.code === 'ProviderDown') {
      if (provider.capabilities.retrievePosts && provider.retrievePosts) {
        const remote = await provider.retrievePosts(
          {
            id: account.id,
            providerAccountId: account.providerAccountId,
            handle: account.handle,
            displayName: account.displayName,
            platformMeta: account.platformMeta as Record<string, unknown>,
          },
          account.credential,
          startedAt
        )

        const match = findMatch(
          fingerprint,
          remote.map((r) => ({
            remoteId: r.remoteId,
            createdAt: r.createdAt,
            text: r.text,
            mediaCount: r.mediaCount,
          })),
          startedAt
        )

        if (match) {
          this.logger.info(`variant ${variantId} reconciled to ${match.remoteId} — not republished`)
          await this.succeed(workspaceId, variantId, key, match.remoteId, undefined, 'RECONCILED')
          return 'PUBLISHED'
        }
        // Confirmed absent, so retrying is safe.
        await this.markAttempt(workspaceId, variantId, key, 'FAILED', error.code)
        return 'QUEUED'
      }

      // No read-back: exactly-once is not achievable here. At-most-once plus a
      // human prompt beats at-least-once plus a duplicate.
      await this.markAttempt(workspaceId, variantId, key, 'FAILED', error.code)
      await withTenant(workspaceId, async (tx) => {
        await tx.postVariant.update({
          where: { id: variantId },
          data: {
            status: 'NEEDS_REVIEW',
            lastErrorCode: error.code,
            lastError:
              `We could not confirm whether this published. ${provider.label} does not let us ` +
              `check, so it needs a human decision rather than an automatic retry.`,
          },
        })
        await this.refreshPostStatus(tx, variantId)
      })
      return 'NEEDS_REVIEW'
    }

    return this.fail(workspaceId, variantId, error.code, error.message)
  }

  // -------------------------------------------------------------------------

  private async loadContext(workspaceId: string, variantId: string) {
    return withTenant(workspaceId, async (tx) => {
      const variant = await tx.postVariant.findUnique({
        where: { id: variantId },
        select: {
          id: true,
          surface: true,
          contentOverride: true,
          socialAccountId: true,
          // Needed by the media preparer: a rendition row carries both tenancy
          // columns, like every other tenant-scoped model.
          organizationId: true,
          post: {
            select: {
              baseContent: true,
              media: {
                orderBy: { position: 'asc' },
                select: {
                  altText: true,
                  media: {
                    select: {
                      id: true,
                      storageKey: true,
                      mime: true,
                      bytes: true,
                      width: true,
                      height: true,
                    },
                  },
                },
              },
            },
          },
        },
      })
      if (!variant) return null

      const account = await tx.socialAccount.findUnique({
        where: { id: variant.socialAccountId },
        select: {
          id: true,
          provider: true,
          providerAccountId: true,
          handle: true,
          displayName: true,
          platformMeta: true,
          credential: { select: { accessToken: true, scopes: true } },
        },
      })
      if (!account?.credential) return null

      const provider = registry.get(account.provider as never)
      if (!provider) return null

      return {
        variant,
        provider,
        content: variant.contentOverride ?? variant.post.baseContent,
        media: variant.post.media.map((pm) => ({
          ...pm.media,
          altText: pm.altText,
        })),
        account: {
          ...account,
          credential: {
            accessToken: decrypt(account.credential.accessToken, keyProvider()),
            scopes: account.credential.scopes,
          },
        },
      }
    })
  }

  private budgetFor(
    provider: AnyProvider,
    accountId: string,
    operation: 'publish' | 'mediaUpload'
  ): BudgetSpec | null {
    const budget = provider.limits[operation]
    if (!budget) return null
    return {
      provider: provider.id,
      accountId,
      operation,
      scope: provider.limits.scope,
      cost: budget.cost,
      capacity: budget.budget,
      windowMs: windowMs(budget.window),
    }
  }

  private async succeed(
    workspaceId: string,
    variantId: string,
    key: string,
    remoteId: string,
    remoteUrl?: string,
    attemptStatus: 'SUCCEEDED' | 'RECONCILED' = 'SUCCEEDED'
  ): Promise<void> {
    await withTenant(workspaceId, async (tx) => {
      await tx.postVariant.update({
        where: { id: variantId },
        data: {
          status: 'PUBLISHED',
          remoteId,
          remoteUrl: remoteUrl ?? null,
          publishedAt: new Date(),
          lastError: null,
          lastErrorCode: null,
        },
      })
      await tx.publishAttempt.updateMany({
        where: { postVariantId: variantId, idempotencyKey: key, status: 'IN_FLIGHT' },
        data: { status: attemptStatus, finishedAt: new Date(), providerResponseId: remoteId },
      })
      await this.refreshPostStatus(tx, variantId)
    })
  }

  /**
   * Marks a variant as preparing its media.
   *
   * Visible state, not bookkeeping. A two-minute transcode with the variant
   * still showing QUEUED looks exactly like a stuck job, and the first thing
   * anyone does about a stuck job is retry it — which starts a second transcode
   * of the same file.
   */
  private async markPreparingMedia(workspaceId: string, variantId: string): Promise<void> {
    await withTenant(workspaceId, async (tx) => {
      await tx.postVariant.update({
        where: { id: variantId },
        data: { status: 'PREPARING_MEDIA' },
      })
    })
  }

  private async fail(
    workspaceId: string,
    variantId: string,
    code: string,
    message: string
  ): Promise<VariantStatus> {
    await withTenant(workspaceId, async (tx) => {
      await tx.postVariant.update({
        where: { id: variantId },
        data: { status: 'FAILED', lastError: message, lastErrorCode: code },
      })
      await tx.publishAttempt.updateMany({
        where: { postVariantId: variantId, status: 'IN_FLIGHT' },
        data: { status: 'FAILED', finishedAt: new Date(), errorCode: code },
      })
      await this.refreshPostStatus(tx, variantId)
    })
    return 'FAILED'
  }

  private async markAttempt(
    workspaceId: string,
    variantId: string,
    key: string,
    status: 'FAILED' | 'RATE_LIMITED',
    code: string
  ): Promise<void> {
    await withTenant(workspaceId, async (tx) => {
      await tx.publishAttempt.updateMany({
        where: { postVariantId: variantId, idempotencyKey: key, status: 'IN_FLIGHT' },
        data: { status, finishedAt: new Date(), errorCode: code },
      })
      await tx.postVariant.update({
        where: { id: variantId },
        data: { status: 'QUEUED', lastErrorCode: code },
      })
    })
  }

  /** Recomputes the post's derived status from its variants. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async refreshPostStatus(tx: any, variantId: string): Promise<void> {
    const variant = await tx.postVariant.findUnique({
      where: { id: variantId },
      select: { postId: true, post: { select: { status: true } } },
    })
    if (!variant) return

    // PENDING_APPROVAL and APPROVED are editorial gates with no variant
    // counterpart. Deriving over them would silently undo a decision somebody
    // made — the reducer knows nothing about approvals and must not overwrite
    // what it cannot represent.
    if (!shouldDerive(variant.post.status)) return

    const siblings = await tx.postVariant.findMany({
      where: { postId: variant.postId },
      select: { status: true },
    })

    const derived = derivePostStatus(siblings.map((s: { status: VariantStatus }) => s.status))
    await tx.post.update({
      where: { id: variant.postId },
      data: {
        status: derived,
        ...(derived === 'PUBLISHED' ? { publishedAt: new Date() } : {}),
      },
    })
  }

  async close(): Promise<void> {
    await this.redis.quit()
  }
}

