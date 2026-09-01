import { Redis } from 'ioredis'
import { loadEnv } from '@smm/config'
import { decrypt, keyProvider, outbox, withTenant } from '@smm/database'
import { ProviderError, registry, windowMs, type AnyProvider } from '@smm/providers'
import { publicUrlFor } from '@smm/storage'
import { AccountMutex, RateLimiter, type BudgetSpec } from '@smm/ratelimit'
import { budgetDenials, providerRateLimits, publishDuration, publishOutcomes } from '@smm/observability'
import {
  derivePostStatus,
  shouldDerive,
  fingerprintFor,
  findMatch,
  idempotencyKey,
  parseFingerprint,
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

/**
 * The account as the publish path needs it: identity, platform metadata, and a
 * DECRYPTED credential. Named because three signatures now share it, and an
 * inline repeat of a shape containing a plaintext access token is a shape
 * somebody will eventually widen without noticing what is in it.
 */
type PublishAccount = {
  id: string
  providerAccountId: string
  handle: string
  displayName: string
  platformMeta: unknown
  credential: { accessToken: string; scopes: string[] }
}

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

  /**
   * Publishes one variant. Returns its resulting status.
   *
   * The wrapper below is where the outcome is counted, rather than at each of
   * the dozen `return`s inside. Counting at every exit means the next branch
   * somebody adds is the one that goes unmeasured, and a metric with a hole in
   * it is worse than none — it reads as complete.
   */
  async publishVariant(workspaceId: string, variantId: string): Promise<VariantStatus> {
    const context = await this.loadContext(workspaceId, variantId)
    if (!context) {
      publishOutcomes.inc({ provider: 'unknown', outcome: 'unresolvable' })
      return 'FAILED'
    }

    const end = publishDuration.startTimer({ provider: context.provider.id })
    try {
      const status = await this.attempt(workspaceId, variantId, context)
      publishOutcomes.inc({ provider: context.provider.id, outcome: status.toLowerCase() })
      return status
    } finally {
      end()
    }
  }

  private async attempt(
    workspaceId: string,
    variantId: string,
    context: NonNullable<Awaited<ReturnType<Publisher['loadContext']>>>
  ): Promise<VariantStatus> {

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
          //
          // Counted separately from a provider 429 because the two mean
          // opposite things: this is the budget working, that is our documented
          // limit being wrong. One counter for both would make the distinction
          // the whole rate-limit design rests on unmeasurable.
          budgetDenials.inc({ provider: provider.id, operation: 'publish' })
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
    account: PublishAccount,
    fingerprint: ReturnType<typeof fingerprintFor>,
    startedAt: Date,
    err: unknown
  ): Promise<VariantStatus> {
    const error =
      err instanceof ProviderError
        ? err
        : new ProviderError(provider.id, 'ProviderDown', 'The provider did not respond.')

    if (error.code === 'RateLimited') {
      providerRateLimits.inc({ provider: provider.id })
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

    // Ambiguous: the call did not return, but the post may have landed. The
    // crash reconciler asks exactly this question, so it is answered by exactly
    // this code — two implementations of "did this publish?" is two chances to
    // be wrong in the one place where being wrong means a duplicate public post.
    if (error.code === 'ProviderDown') {
      return this.resolveAmbiguous(
        { workspaceId, variantId, key, provider, account, fingerprint, startedAt },
        'error'
      )
    }

    return this.fail(workspaceId, variantId, error.code, error.message)
  }

  /**
   * Decides an ambiguous publish: did it land, or did it not?
   *
   * Reached from two directions that look different and are the same question.
   * Either the provider call threw without a usable answer, or the worker
   * process died mid-call and a later sweep found the IN_FLIGHT row it left
   * behind. In both cases we hold an attempt record and no confirmation, and
   * the only wrong move is to assume.
   *
   * Retrying an ambiguous publish is how a duplicate public post happens, and a
   * duplicate is not recoverable — you cannot un-send it, and on most networks
   * you cannot even tell which copy people saw.
   */
  private async resolveAmbiguous(
    ctx: {
      workspaceId: string
      variantId: string
      key: string
      provider: AnyProvider
      account: PublishAccount
      fingerprint: ReturnType<typeof fingerprintFor>
      startedAt: Date
    },
    cause: 'error' | 'interrupted'
  ): Promise<VariantStatus> {
    const { workspaceId, variantId, key, provider, account, fingerprint, startedAt } = ctx

    if (provider.capabilities.retrievePosts && provider.retrievePosts) {
      let remote
      try {
        remote = await provider.retrievePosts(
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
      } catch (err) {
        // Read-back itself failed. We still do not know, and "do not know" must
        // never decay into "assume not published" merely because the second
        // call failed too. The attempt stays IN_FLIGHT so the next sweep asks
        // again, rather than closing the question on no evidence.
        this.logger.warn(
          `variant ${variantId}: read-back failed during reconciliation, leaving ` +
            `IN_FLIGHT for the next sweep: ` +
            (err instanceof Error ? err.message : String(err))
        )
        return 'PUBLISHING'
      }

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
      await this.markAttempt(workspaceId, variantId, key, 'FAILED', 'ProviderDown')
      return 'QUEUED'
    }

    // No read-back: exactly-once is not achievable here. At-most-once plus a
    // human prompt beats at-least-once plus a duplicate.
    await this.markAttempt(workspaceId, variantId, key, 'FAILED', 'ProviderDown')
    await withTenant(workspaceId, async (tx) => {
      await tx.postVariant.update({
        where: { id: variantId },
        data: {
          status: 'NEEDS_REVIEW',
          lastErrorCode: 'ProviderDown',
          lastError:
            cause === 'interrupted'
              ? `Publishing was interrupted and we could not confirm whether this went ` +
                `out. ${provider.label} does not let us check, so it needs a human ` +
                `decision rather than an automatic retry.`
              : `We could not confirm whether this published. ${provider.label} does not ` +
                `let us check, so it needs a human decision rather than an automatic retry.`,
        },
      })
      await this.refreshPostStatus(tx, variantId)
    })
    return 'NEEDS_REVIEW'
  }

  /**
   * Resolves one attempt left IN_FLIGHT by a process that never came back.
   *
   * Called by the recovery sweep, never by the publish path. The publish path
   * always knows its own outcome; this exists precisely for the case where
   * nobody does, because the process that knew is gone.
   *
   * Returns null when the attempt should be left alone — a live worker still
   * holds the account lease, or the variant has since moved on.
   */
  async reconcileInterrupted(
    workspaceId: string,
    variantId: string,
    attempt: { idempotencyKey: string; startedAt: Date }
  ): Promise<VariantStatus | null> {
    const context = await this.loadContext(workspaceId, variantId)
    if (!context) return null

    const { variant, account, provider } = context

    // A slow publish is not a dead one. Without this check the sweep races a
    // worker that is merely still waiting on a provider, and reconciling
    // underneath it is exactly the concurrent write the mutex exists to
    // prevent. The lease is the authority on "still alive", not the clock —
    // which is why the lease TTL, not the staleness threshold, is what makes
    // this safe.
    if (await this.mutex.isHeld(provider.id, account.providerAccountId)) {
      this.logger.info(`variant ${variantId}: account lease still held, leaving it to its owner`)
      return null
    }

    // The variant may have been cancelled, or already resolved by an earlier
    // sweep, between the discovery query and now.
    if (variant.status !== 'PUBLISHING' && variant.status !== 'PREPARING_MEDIA') {
      await withTenant(workspaceId, async (tx) => {
        await tx.publishAttempt.updateMany({
          where: {
            postVariantId: variantId,
            idempotencyKey: attempt.idempotencyKey,
            status: 'IN_FLIGHT',
          },
          data: { status: 'FAILED', finishedAt: new Date(), errorCode: 'Superseded' },
        })
      })
      return null
    }

    // The fingerprint was written in the same transaction as the attempt row,
    // BEFORE the provider call — which is the only reason any of this is
    // recoverable. Recomputing it here would use whatever the content says now,
    // and an edit between the crash and the sweep would make it match nothing:
    // the reconciler would report "not published", retry, and produce the
    // duplicate the whole mechanism exists to prevent.
    const stored = variant.fingerprint ? parseFingerprint(variant.fingerprint) : null
    if (!stored) {
      this.logger.warn(`variant ${variantId}: no stored fingerprint to match on, asking a human`)
      return this.needsReview(
        workspaceId,
        variantId,
        attempt.idempotencyKey,
        'Publishing was interrupted and we have no way to check whether it went out. ' +
          'Please confirm on the platform before retrying this.'
      )
    }

    this.logger.info(`variant ${variantId}: recovering an interrupted publish`)
    return this.resolveAmbiguous(
      {
        workspaceId,
        variantId,
        key: attempt.idempotencyKey,
        provider,
        account,
        fingerprint: stored,
        startedAt: attempt.startedAt,
      },
      'interrupted'
    )
  }

  private async needsReview(
    workspaceId: string,
    variantId: string,
    key: string,
    message: string
  ): Promise<VariantStatus> {
    await withTenant(workspaceId, async (tx) => {
      await tx.publishAttempt.updateMany({
        where: { postVariantId: variantId, idempotencyKey: key, status: 'IN_FLIGHT' },
        data: { status: 'FAILED', finishedAt: new Date(), errorCode: 'Interrupted' },
      })
      await tx.postVariant.update({
        where: { id: variantId },
        data: { status: 'NEEDS_REVIEW', lastErrorCode: 'Interrupted', lastError: message },
      })
      await this.refreshPostStatus(tx, variantId)
    })
    return 'NEEDS_REVIEW'
  }

  // -------------------------------------------------------------------------

  private async loadContext(workspaceId: string, variantId: string) {
    return withTenant(workspaceId, async (tx) => {
      const variant = await tx.postVariant.findUnique({
        where: { id: variantId },
        select: {
          id: true,
          surface: true,
          status: true,
          // Written in the same transaction as the attempt row, before the
          // provider call. That ordering is what makes an interrupted publish
          // recoverable at all.
          fingerprint: true,
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

      // INSIDE the transaction that marked the variant published.
      //
      // That placement is the whole mechanism. Emitting after the commit leaves
      // a window where the post is live and the event never happened, so a
      // subscriber is told nothing and nobody finds out — the failure the
      // outbox exists to close. Committing together makes the event as durable
      // as the fact it describes.
      await outbox.emit(tx, {
        aggregateType: 'PostVariant',
        aggregateId: variantId,
        eventType: 'post.published',
        workspaceId,
        payload: { variantId, remoteId, remoteUrl: remoteUrl ?? null, reconciled: attemptStatus === 'RECONCILED' },
      })
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

      await outbox.emit(tx, {
        aggregateType: 'PostVariant',
        aggregateId: variantId,
        eventType: 'post.failed',
        workspaceId,
        // The MESSAGE, not only the code. A subscriber that has to look up what
        // ContentRejected means is a subscriber that will not bother.
        payload: { variantId, code, message },
      })
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

