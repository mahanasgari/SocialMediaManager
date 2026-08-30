/**
 * The post status reducer.
 *
 * Two enums exist because they describe different things. `VariantStatus` is
 * authoritative and per-channel; `PostStatus` is a SUMMARY derived from them.
 * A single enum covering both made `Post = PREPARING_MEDIA` representable and
 * meaningless, and made `PARTIALLY_PUBLISHED` — which is inherently about the
 * relationship BETWEEN channels — impossible to express honestly.
 *
 * Pure, so the full cross-product of variant states is cheap to test. That
 * matters: partial failure is the normal outcome of multi-channel publishing,
 * not an exception, and getting the summary wrong means telling someone their
 * post went out when it did not.
 */

export const VARIANT_STATUSES = [
  'DRAFT',
  'SCHEDULED',
  'QUEUED',
  'PREPARING_MEDIA',
  'PUBLISHING',
  'PUBLISHED',
  'FAILED',
  'CANCELLED',
  'MISSED',
  'NEEDS_REVIEW',
] as const

export type VariantStatus = (typeof VARIANT_STATUSES)[number]

export const POST_STATUSES = [
  'DRAFT',
  'PENDING_APPROVAL',
  'APPROVED',
  'SCHEDULED',
  'PUBLISHING',
  'PUBLISHED',
  'PARTIALLY_PUBLISHED',
  'FAILED',
  'CANCELLED',
  'MISSED',
  'NEEDS_REVIEW',
] as const

export type PostStatus = (typeof POST_STATUSES)[number]

/**
 * Editorial gates with no variant counterpart.
 *
 * They live on the post alone and are written directly rather than derived.
 * Present from Phase 4 and UNUSED until Phase 5 ships approvals — stated
 * explicitly so their absence from the current flow is not mistaken for a gap.
 */
export const EDITORIAL_STATUSES: ReadonlySet<PostStatus> = new Set<PostStatus>([
  'PENDING_APPROVAL',
  'APPROVED',
])

/** Terminal variant states — the pipeline will not touch these again on its own. */
export const TERMINAL_VARIANT: ReadonlySet<VariantStatus> = new Set<VariantStatus>([
  'PUBLISHED',
  'FAILED',
  'CANCELLED',
  'MISSED',
  'NEEDS_REVIEW',
])

/**
 * Derives the post status.
 *
 * Precedence order is deliberate and documented in DATABASE.md. The first rule
 * is the important one: any NEEDS_REVIEW wins outright, because a variant whose
 * outcome we genuinely cannot determine needs a human before anything else about
 * the post is reported. Summarising it as PARTIALLY_PUBLISHED would bury the one
 * thing somebody has to act on.
 */
export function derivePostStatus(variants: readonly VariantStatus[]): PostStatus {
  if (variants.length === 0) return 'DRAFT'

  const has = (s: VariantStatus) => variants.includes(s)
  const all = (...s: VariantStatus[]) => variants.every((v) => s.includes(v))

  // 1. A possible duplicate outranks everything else.
  if (has('NEEDS_REVIEW')) return 'NEEDS_REVIEW'

  // 2. Wholly cancelled.
  if (all('CANCELLED')) return 'CANCELLED'

  // 3. Some landed, some did not. The state that exists because multi-channel
  //    publishing succeeds partially far more often than it succeeds completely.
  if (has('PUBLISHED') && (has('FAILED') || has('MISSED') || has('CANCELLED'))) {
    return 'PARTIALLY_PUBLISHED'
  }

  // 4-6. Uniform terminal outcomes. CANCELLED counts as "not blocking" so a post
  //      with one published and one cancelled variant still reads as PUBLISHED
  //      only when nothing failed — rule 3 already caught the mixed case.
  if (all('PUBLISHED', 'CANCELLED') && has('PUBLISHED')) return 'PUBLISHED'
  if (all('MISSED', 'CANCELLED') && has('MISSED')) return 'MISSED'
  if (all('FAILED', 'CANCELLED') && has('FAILED')) return 'FAILED'

  // 7. Work in flight.
  if (has('PUBLISHING') || has('PREPARING_MEDIA')) return 'PUBLISHING'

  // 8. Waiting.
  if (has('SCHEDULED') || has('QUEUED')) return 'SCHEDULED'

  return 'DRAFT'
}

/**
 * Whether a derived status should overwrite the stored one.
 *
 * Editorial statuses are NOT derived, so a post sitting in PENDING_APPROVAL must
 * not be silently rewritten to DRAFT by a reducer that knows nothing about
 * approvals.
 */
export function shouldDerive(current: PostStatus): boolean {
  return !EDITORIAL_STATUSES.has(current)
}

/** Human summary for the UI. Says what happened, not what the enum is called. */
export function describeStatus(status: PostStatus, counts: { published: number; total: number }): string {
  switch (status) {
    case 'PARTIALLY_PUBLISHED':
      return `Published to ${counts.published} of ${counts.total} channels`
    case 'NEEDS_REVIEW':
      return 'We could not confirm whether this published — needs a decision'
    case 'MISSED':
      return 'Missed its scheduled time and was not published'
    case 'PUBLISHING':
      return 'Publishing now'
    case 'SCHEDULED':
      return 'Scheduled'
    case 'PUBLISHED':
      return counts.total > 1 ? `Published to all ${counts.total} channels` : 'Published'
    case 'FAILED':
      return 'Failed to publish'
    case 'CANCELLED':
      return 'Cancelled'
    case 'PENDING_APPROVAL':
      return 'Waiting for approval'
    case 'APPROVED':
      return 'Approved, not yet scheduled'
    case 'DRAFT':
      return 'Draft'
  }
}
