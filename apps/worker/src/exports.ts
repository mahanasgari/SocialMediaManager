import { gzipSync } from 'node:zlib'
import { withScheduler, withTenant } from '@smm/database'
import { deleteObject, putObject } from '@smm/storage'

/**
 * Fulfilling a request for a copy of the data.
 *
 * This product stores third-party personal data — private messages, commenter
 * names, follower counts — belonging to people who never signed up for it, on
 * behalf of a controller who is our customer. "Send me everything you hold about
 * this person" is a request with legal weight and a clock attached, and the
 * worst time to discover the capability does not exist is when someone's counsel
 * asks for it.
 *
 * Two kinds, and the difference matters:
 *
 *   WORKSPACE  what the customer owns — posts, variants, a media manifest,
 *              metrics. Portability. Also the thing to run before a purge.
 *
 *   SUBJECT    everything tied to ONE end-user identity, across every
 *              conversation in this workspace. The subject-access request.
 *
 * SUBJECT is scoped to a single workspace, always. "Everything you hold about
 * this person" spanning tenants would answer a legitimate question by committing
 * a cross-tenant leak — each controller answers for its own data, separately.
 */

/** One job per tick. An export is the least urgent thing the worker does. */
const BATCH = 1

/** How long a finished file stays downloadable. */
const TTL_MS = 7 * 24 * 3600_000

export type ExportResult = { built: number; failed: number; expired: number }

export async function runExports(now: Date = new Date()): Promise<ExportResult> {
  const result: ExportResult = { built: 0, failed: 0, expired: 0 }

  result.expired = await expireOld(now)

  // Cross-workspace by definition — one worker serves every tenant. The claim
  // reads ids and status only; every row of actual data below is read under
  // withTenant() by the same code any other reader uses.
  const claimed = await withScheduler(async (tx) => {
    const pending = await tx.exportJob.findMany({
      where: { status: 'PENDING' },
      orderBy: { createdAt: 'asc' },
      take: BATCH,
      select: { id: true, workspaceId: true, kind: true, subjectHandle: true },
    })
    if (pending.length === 0) return []

    // Claimed before the work starts, so a second worker cannot pick up the
    // same job. The updateMany count is the claim: if it comes back zero,
    // somebody else got there first.
    const ids = pending.map((j: { id: string }) => j.id)
    const taken = await tx.exportJob.updateMany({
      where: { id: { in: ids }, status: 'PENDING' },
      data: { status: 'RUNNING', startedAt: new Date() },
    })
    return taken.count > 0 ? pending : []
  })

  for (const job of claimed) {
    try {
      const { payload, summary } = await build(job)

      // Gzipped, because an export is JSON and JSON compresses roughly tenfold.
      // The difference between a 200 MB download and a 20 MB one is the
      // difference between a link somebody uses and a link somebody gives up on.
      const body = gzipSync(Buffer.from(JSON.stringify(payload, null, 2), 'utf8'))
      const key = `exports/${job.workspaceId}/${job.id}.json.gz`
      await putObject(key, body, 'application/gzip')

      await withTenant(job.workspaceId, async (tx) => {
        await tx.exportJob.update({
          where: { id: job.id },
          data: {
            status: 'READY',
            storageKey: key,
            bytes: body.byteLength,
            summary,
            finishedAt: new Date(),
            expiresAt: new Date(now.getTime() + TTL_MS),
          },
        })
      })
      result.built += 1
    } catch (err) {
      // The reason is stored on the row, not only logged. Somebody waiting on an
      // export needs to be told what went wrong without asking an operator to
      // go and read a log.
      await withTenant(job.workspaceId, async (tx) => {
        await tx.exportJob.update({
          where: { id: job.id },
          data: {
            status: 'FAILED',
            error: err instanceof Error ? err.message : String(err),
            finishedAt: new Date(),
          },
        })
      })
      result.failed += 1
    }
  }

  return result
}

/**
 * Deletes files past their expiry.
 *
 * The ROW survives as EXPIRED. An export of someone's private messages should
 * not sit in object storage indefinitely because one person forgot to download
 * it — but "an export was produced, and downloaded twice" is a fact worth being
 * able to answer later, and deleting the record along with the file destroys the
 * only evidence the request was ever honoured.
 */
async function expireOld(now: Date): Promise<number> {
  const due = await withScheduler(async (tx) =>
    tx.exportJob.findMany({
      where: { status: 'READY', expiresAt: { lt: now } },
      take: 20,
      select: { id: true, workspaceId: true, storageKey: true },
    })
  )

  let expired = 0
  for (const job of due) {
    if (job.storageKey) {
      // A missing object is not an error here: the point is that it is gone.
      await deleteObject(job.storageKey).catch(() => undefined)
    }
    await withTenant(job.workspaceId, async (tx) => {
      await tx.exportJob.update({
        where: { id: job.id },
        data: { status: 'EXPIRED', storageKey: null },
      })
    })
    expired += 1
  }
  return expired
}

// ---------------------------------------------------------------------------

type Job = {
  id: string
  workspaceId: string
  kind: string
  subjectHandle: string | null
}

async function build(job: Job): Promise<{ payload: unknown; summary: Record<string, number> }> {
  if (job.kind === 'SUBJECT') {
    if (!job.subjectHandle) throw new Error('A subject export needs a handle.')
    return buildSubject(job.workspaceId, job.subjectHandle)
  }
  return buildWorkspace(job.workspaceId)
}

async function buildWorkspace(workspaceId: string) {
  return withTenant(workspaceId, async (tx) => {
    const workspace = await tx.workspace.findUniqueOrThrow({
      where: { id: workspaceId },
      select: { id: true, name: true, slug: true, createdAt: true },
    })

    const posts = await tx.post.findMany({
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        status: true,
        baseContent: true,
        scheduledAt: true,
        timezone: true,
        publishedAt: true,
        createdAt: true,
        campaign: { select: { name: true } },
        labels: { select: { label: { select: { name: true } } } },
        variants: {
          select: {
            id: true,
            surface: true,
            status: true,
            contentOverride: true,
            remoteId: true,
            remoteUrl: true,
            publishedAt: true,
            socialAccount: { select: { provider: true, handle: true } },
          },
        },
      },
    })

    // A MANIFEST, not the bytes. Shipping every video would turn a portability
    // feature into a way to fill a disk, and the objects are already the
    // customer's — the manifest tells them what exists and where, which is what
    // makes the list actionable.
    const media = await tx.mediaAsset.findMany({
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        filename: true,
        mime: true,
        bytes: true,
        width: true,
        height: true,
        storageKey: true,
        altText: true,
        createdAt: true,
      },
    })

    const metrics = await tx.postMetric.findMany({
      orderBy: { capturedAt: 'asc' },
      select: {
        postVariantId: true,
        capturedAt: true,
        impressions: true,
        reach: true,
        likes: true,
        comments: true,
        shares: true,
        clicks: true,
        // `raw` is deliberately excluded. It is nulled after 90 days anyway, it
        // is provider-shaped rather than portable, and it is the largest thing
        // in the table by an order of magnitude.
      },
    })

    const accounts = await tx.socialAccount.findMany({
      select: {
        provider: true,
        handle: true,
        displayName: true,
        status: true,
        surfaces: true,
        createdAt: true,
        // No credential. Not by omission — an export must never be a way to
        // extract a token, and the whole point of encrypting them is that this
        // code path cannot read one anyway.
      },
    })

    return {
      payload: {
        kind: 'workspace',
        generatedAt: new Date().toISOString(),
        workspace,
        accounts,
        posts: posts.map((p) => ({
          ...p,
          campaign: p.campaign?.name ?? null,
          labels: p.labels.map((l) => l.label.name),
        })),
        media,
        metrics,
      },
      summary: {
        accounts: accounts.length,
        posts: posts.length,
        variants: posts.reduce((n, p) => n + p.variants.length, 0),
        media: media.length,
        metrics: metrics.length,
      },
    }
  })
}

async function buildSubject(workspaceId: string, handle: string) {
  return withTenant(workspaceId, async (tx) => {
    // Matched case-insensitively and exactly. Not `contains`: "@ada" must not
    // sweep up "@adamson", and over-collecting on a subject-access request
    // discloses a third party's messages to whoever asked.
    const conversations = await tx.conversation.findMany({
      where: { subjectHandle: { equals: handle, mode: 'insensitive' } },
      select: {
        id: true,
        kind: true,
        subjectHandle: true,
        status: true,
        createdAt: true,
        lastMessageAt: true,
        socialAccount: { select: { provider: true, handle: true } },
      },
    })

    // Both directions, deliberately. A conversation is not a copy of what
    // somebody said to us — it is an exchange, and half of one is not an honest
    // answer to "everything you hold".
    const messages = await tx.message.findMany({
      where: {
        OR: [
          { conversationId: { in: conversations.map((c) => c.id) } },
          { authorHandle: { equals: handle, mode: 'insensitive' } },
        ],
      },
      orderBy: { providerCreatedAt: 'asc' },
      select: {
        id: true,
        conversationId: true,
        direction: true,
        authorHandle: true,
        body: true,
        mediaUrls: true,
        providerCreatedAt: true,
      },
    })

    return {
      payload: {
        kind: 'subject',
        subject: handle,
        generatedAt: new Date().toISOString(),
        // Stated in the file itself, because a recipient reading it needs to
        // know the boundary of what they were given.
        scope:
          'One workspace only. Other workspaces are separate controllers and answer separately.',
        conversations,
        messages,
      },
      summary: { conversations: conversations.length, messages: messages.length },
    }
  })
}
