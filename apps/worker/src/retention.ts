import { loadEnv } from '@smm/config'
import { Prisma, withRetention, withSystemScope, withTenant, db } from '@smm/database'
import { deleteObject } from '@smm/storage'

/**
 * Retention and purge.
 *
 * This product stores third-party personal data — message contents, commenter
 * names, follower analytics — under a controller who is our customer. "Delete
 * the workspace" therefore has legal weight, and there is no safe default: data
 * kept forever is a liability, and data deleted immediately loses someone their
 * work to a misclick.
 *
 * So deletion is a two-step with a grace period, and the grace period is
 * surfaced with the ACTUAL purge date rather than "soon".
 *
 * Everything here is idempotent and batched. A purge that half-runs and is
 * retried must converge, because it will be interrupted eventually.
 */


export type RetentionResult = {
  workspacesPurged: number
  mediaObjectsDeleted: number
  messagesReaped: number
  rawMetricsCleared: number
  unroutedReaped: number
  tokensReaped: number
  sessionsReaped: number
}

export async function runRetention(now: Date = new Date()): Promise<RetentionResult> {
  const result: RetentionResult = {
    workspacesPurged: 0,
    mediaObjectsDeleted: 0,
    messagesReaped: 0,
    rawMetricsCleared: 0,
    unroutedReaped: 0,
    tokensReaped: 0,
    sessionsReaped: 0,
  }

  const env = loadEnv()

  // Cheap, unconditional sweeps first. They are bounded and independent, so a
  // failure in the expensive workspace purge below does not prevent expired
  // credentials from being cleaned up.
  result.tokensReaped = await reapExpiredTokens(now)
  result.sessionsReaped = await reapExpiredSessions(now)
  result.unroutedReaped = await reapUnrouted(now)
  result.rawMetricsCleared = await clearOldRawPayloads(now)

  if (env.INBOX_RETENTION_DAYS) {
    result.messagesReaped = await reapMessages(env.INBOX_RETENTION_DAYS, now)
  }

  const purge = await purgeWorkspaces(env.WORKSPACE_PURGE_GRACE_DAYS, now)
  result.workspacesPurged = purge.workspaces
  result.mediaObjectsDeleted = purge.objects

  return result
}

/**
 * When a soft-deleted workspace becomes eligible for purge.
 *
 * Pure so the UI can show the same date the job will act on. Telling someone
 * their data goes "in about a month" when the job has its own arithmetic is how
 * a deletion promise turns into a support ticket.
 */
export function purgeDateFor(deletedAt: Date, graceDays: number): Date {
  return new Date(deletedAt.getTime() + graceDays * 86_400_000)
}

export function isPurgeDue(deletedAt: Date, graceDays: number, now: Date): boolean {
  return purgeDateFor(deletedAt, graceDays) <= now
}

/**
 * Permanently removes workspaces whose grace period has elapsed.
 *
 * S3 objects go FIRST. If the rows were deleted first and the process then
 * died, the storage keys would be unrecoverable and the objects would be
 * orphaned forever — paid for, undeletable, and still containing the data we
 * were asked to erase.
 */
async function purgeWorkspaces(
  graceDays: number,
  now: Date
): Promise<{ workspaces: number; objects: number }> {
  const cutoff = new Date(now.getTime() - graceDays * 86_400_000)

  const due = await withRetention(async (tx) =>
    tx.workspace.findMany({
      where: { deletedAt: { not: null, lte: cutoff } },
      select: { id: true, name: true, organizationId: true, deletedAt: true },
      take: 5,
    })
  )

  let objects = 0

  for (const workspace of due) {
    // Storage keys are collected under the workspace's own tenancy, so a bug
    // here cannot reach another workspace's objects.
    const keys = await withTenant(workspace.id, async (tx) => {
      const assets = await tx.mediaAsset.findMany({ select: { storageKey: true } })
      // Renditions are separate objects with their own keys. Deleting only the
      // originals would leave every re-encoded copy behind — paid for, orphaned,
      // and still containing the data we were asked to erase.
      const renditions = await tx.mediaRendition.findMany({ select: { storageKey: true } })
      return [...assets, ...renditions].map((a) => a.storageKey)
    })

    for (const key of keys) {
      try {
        await deleteObject(key)
        objects++
      } catch {
        // A missing object is fine — that is the desired end state. Any other
        // failure is skipped rather than fatal: one unreachable object must not
        // block the deletion of everything else the customer asked to remove.
      }
    }

    await withRetention(async (tx) => {
      // Cascades handle the rest: posts, variants, attempts, metrics,
      // conversations, messages, credentials, link pages and feeds all hang off
      // the workspace with onDelete: Cascade.
      //
      // AuditLog does NOT. It is minimised instead, below.
      // Actor, action, entity type and timestamp are retained; the payload and
      // the IP are not. A deletion record that deletes itself is not a record,
      // but a retained payload would defeat the deletion it is recording — and
      // an IP address is itself personal data.
      //
      // The rows survive the workspace because AuditLog.workspaceId is
      // onDelete: SetNull rather than Cascade. That is deliberate: the evidence
      // that a workspace was deleted must outlive the workspace.
      await tx.auditLog.updateMany({
        where: { workspaceId: workspace.id },
        data: { metadata: {}, ip: null },
      })

      await tx.workspace.delete({ where: { id: workspace.id } })
    })
  }

  return { workspaces: due.length, objects }
}

/**
 * Inbox retention.
 *
 * Messages carry other people's words and names. A workspace that has set a
 * retention period has made a decision about somebody else's data, and honouring
 * it is not optional.
 *
 * Conversations are left in place when their messages go, so the thread does not
 * silently reappear as new on the next inbound event.
 */
async function reapMessages(retentionDays: number, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - retentionDays * 86_400_000)

  const workspaces = await withRetention(async (tx) =>
    tx.workspace.findMany({ where: { deletedAt: null }, select: { id: true } })
  )

  let total = 0
  for (const { id } of workspaces) {
    const { count } = await withTenant(id, async (tx) =>
      tx.message.deleteMany({ where: { providerCreatedAt: { lt: cutoff } } })
    )
    total += count
  }
  return total
}

/**
 * Nulls raw provider payloads older than 90 days.
 *
 * The normalized columns are kept indefinitely; the raw JSONB is not. It is by
 * far the largest thing in the metrics tables and its only real use is debugging
 * a normalization bug, which is a thing you do within days rather than months.
 */
async function clearOldRawPayloads(now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - 90 * 86_400_000)

  return withRetention(async (tx) => {
    // Prisma.DbNull, not JS null: for a nullable Json column, `null` means
    // "the JSON value null" and DbNull means "the SQL NULL". Using the wrong one
    // would store a literal null payload forever instead of clearing it.
    const post = await tx.postMetric.updateMany({
      where: { capturedAt: { lt: cutoff }, raw: { not: Prisma.DbNull } },
      data: { raw: Prisma.DbNull },
    })
    const account = await tx.accountMetric.updateMany({
      where: { capturedAt: { lt: cutoff }, raw: { not: Prisma.DbNull } },
      data: { raw: Prisma.DbNull },
    })
    return post.count + account.count
  })
}

/**
 * Unrouted inbound events, kept 30 days.
 *
 * Long enough to diagnose a misconfigured subscription, short enough that we are
 * not indefinitely storing payloads about people whose accounts nobody here has
 * ever connected.
 */
async function reapUnrouted(now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - 30 * 86_400_000)
  return withRetention(async (tx) => {
    const { count } = await tx.unroutedInboundEvent.deleteMany({
      where: { receivedAt: { lt: cutoff } },
    })
    return count
  })
}

/**
 * Spent and expired verification tokens.
 *
 * A used token is already refused by the redemption path, so this is hygiene
 * rather than security — but a table that only grows is its own problem, and
 * these rows have no value once spent.
 */
async function reapExpiredTokens(now: Date): Promise<number> {
  return withRetention(async (tx) => {
    const { count } = await tx.verificationToken.deleteMany({
      where: {
        OR: [
          { expiresAt: { lt: now } },
          // Used tokens linger a day so "already used" stays distinguishable
          // from "never existed" for someone who clicked an old link twice.
          { usedAt: { lt: new Date(now.getTime() - 86_400_000) } },
        ],
      },
    })
    return count
  })
}

/**
 * Expired sessions.
 *
 * The session guard already refuses an expired row, so this too is hygiene —
 * but "your devices" reads from this table, and listing sessions that stopped
 * working weeks ago makes the page useless for spotting one that should not be
 * there.
 */
async function reapExpiredSessions(now: Date): Promise<number> {
  return withSystemScope('reaping expired sessions', async () => {
    const { count } = await db().session.deleteMany({ where: { expiresAt: { lt: now } } })
    return count
  })
}

