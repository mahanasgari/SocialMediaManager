import { gunzipSync } from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createTestClient,
  withOrganization,
  withSystemScope,
  withTenant,
  type Db,
} from '@smm/database'

/**
 * Export, against a real database.
 *
 * The assertions worth having are all about what the file does NOT contain.
 * An export is the one code path whose whole job is to copy personal data out
 * of the system, so the interesting failures are over-collection — a subject
 * export that sweeps up a similarly-named third party, or a workspace export
 * carrying a credential — and neither is visible by looking at the happy path.
 */

const dbUrl = process.env['TEST_DATABASE_URL']
const ownerUrl = process.env['TEST_DATABASE_OWNER_URL'] ?? dbUrl

const suite = dbUrl ? describe : describe.skip
if (!dbUrl) console.warn('\n  [skipped] exports — run: bash scripts/test-db.sh up\n')

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const omitTenancy = <T,>(data: T) => data as any

let client: Db
let orgId: string
let userId: string
let workspaceId: string
let accountId: string

suite('building an export', () => {
  beforeAll(async () => {
    client = createTestClient(ownerUrl!)
    const stamp = Date.now()

    await withSystemScope('export fixture', async () => {
      const org = await client.organization.create({
        data: { name: 'Export Org', slug: `export-${stamp}` },
      })
      orgId = org.id
      const user = await client.user.create({
        data: { email: `export-${stamp}@example.com`, passwordHash: 'x', name: 'Export' },
      })
      userId = user.id
    })

    await withOrganization(orgId, async (tx) => {
      const ws = await tx.workspace.create({
        data: omitTenancy({ name: 'Export WS', slug: `export-${stamp}` }),
      })
      workspaceId = ws.id
      await tx.membership.create({ data: omitTenancy({ userId, workspaceId, role: 'OWNER' }) })
    })

    await withTenant(workspaceId, async (tx) => {
      const account = await tx.socialAccount.create({
        data: omitTenancy({
          organizationId: orgId,
          provider: 'mock',
          providerAccountId: `export-${stamp}`,
          handle: '@brand',
          displayName: 'Brand',
          surfaces: ['feed'],
        }),
        select: { id: true },
      })
      accountId = account.id

      // A credential exists, so "the export omits it" is a real assertion rather
      // than a vacuous one.
      await tx.oAuthCredential.create({
        data: omitTenancy({
          socialAccountId: accountId,
          accessToken: 'sealed-token-value',
          scopes: ['write'],
          keyId: 'k1',
        }),
      })

      const post = await tx.post.create({
        data: omitTenancy({
          organizationId: orgId,
          authorId: userId,
          baseContent: 'Hello from the export fixture',
          status: 'PUBLISHED',
        }),
        select: { id: true },
      })
      await tx.postVariant.create({
        data: omitTenancy({
          organizationId: orgId,
          postId: post.id,
          socialAccountId: accountId,
          surface: 'feed',
          status: 'PUBLISHED',
        }),
      })

      // Two subjects whose handles share a prefix. This is the whole point of
      // the second test.
      for (const [handle, body] of [
        ['@ada', 'A message from Ada'],
        ['@adamson', 'A message from Adamson, who is a different person'],
      ] as const) {
        const conversation = await tx.conversation.create({
          data: omitTenancy({
            organizationId: orgId,
            socialAccountId: accountId,
            providerConversationId: `conv-${handle}-${stamp}`,
            kind: 'DM',
            subjectHandle: handle,
          }),
          select: { id: true },
        })
        await tx.message.create({
          data: omitTenancy({
            conversationId: conversation.id,
            providerMessageId: `msg-${handle}-${stamp}`,
            direction: 'IN',
            authorHandle: handle,
            body,
            providerCreatedAt: new Date(),
          }),
        })
      }
    })
  }, 60_000)

  afterAll(async () => {
    await withSystemScope('export teardown', async () => {
      await client.organization.delete({ where: { id: orgId } })
      await client.user.delete({ where: { id: userId } })
    })
    await client.$disconnect()
  }, 30_000)

  /** Runs one job through the real pipeline and returns the decoded file. */
  async function run(
    kind: 'WORKSPACE' | 'SUBJECT',
    subjectHandle?: string
  ): Promise<{ payload: Record<string, unknown>; summary: Record<string, number> }> {
    process.env['DATABASE_URL'] = ownerUrl!

    const job = await withTenant(workspaceId, async (tx) =>
      tx.exportJob.create({
        data: omitTenancy({
          organizationId: orgId,
          kind,
          ...(subjectHandle ? { subjectHandle } : {}),
        }),
        select: { id: true },
      })
    )

    const { runExports } = await import('./exports.js')
    await runExports()

    const finished = await withTenant(workspaceId, async (tx) =>
      tx.exportJob.findUniqueOrThrow({
        where: { id: job.id },
        select: { status: true, storageKey: true, bytes: true, summary: true, error: true },
      })
    )
    expect(finished.error).toBeNull()
    expect(finished.status).toBe('READY')

    const { getObject } = await import('@smm/storage')
    const object = await getObject(finished.storageKey!)
    return {
      payload: JSON.parse(gunzipSync(object.body).toString('utf8')) as Record<string, unknown>,
      summary: finished.summary as Record<string, number>,
    }
  }

  it('a workspace export carries the content and NOT the credentials', async () => {
    const { payload, summary } = await run('WORKSPACE')

    expect(payload['kind']).toBe('workspace')
    expect(summary['posts']).toBe(1)

    // The assertion that matters. An export must never become a way to extract
    // a token, and searching the whole serialised file is the only check that
    // survives someone widening a `select` later.
    const serialised = JSON.stringify(payload)
    expect(serialised).not.toContain('sealed-token-value')
    expect(serialised).not.toContain('accessToken')

    // The account itself IS present — it is the customer's own data, and an
    // export without it cannot be used to move anywhere.
    expect(serialised).toContain('@brand')
  })

  it('a subject export does not sweep up a similarly-named third party', async () => {
    // "@ada" must not match "@adamson". Over-collecting on a subject-access
    // request discloses someone else's private messages to whoever asked, which
    // turns one lawful request into a second breach.
    const { payload, summary } = await run('SUBJECT', '@ada')

    expect(summary['conversations']).toBe(1)
    expect(summary['messages']).toBe(1)

    const serialised = JSON.stringify(payload)
    expect(serialised).toContain('A message from Ada')
    expect(serialised).not.toContain('Adamson')
  })

  it('a subject export matches a handle regardless of case', async () => {
    const { summary } = await run('SUBJECT', '@ADA')
    expect(summary['messages']).toBe(1)
  })

  it('a subject export states the boundary of what it contains', async () => {
    // A recipient reading the file needs to know it covers one workspace. Saying
    // so in the file beats saying so in an email nobody keeps.
    const { payload } = await run('SUBJECT', '@ada')
    expect(String(payload['scope'])).toMatch(/one workspace/i)
  })

  it('a subject export with no matches succeeds and reports zero', async () => {
    // Not an error. "We hold nothing about this person" is a valid, and often
    // the correct, answer to a subject-access request — and it has to be
    // distinguishable from a broken export, which is what the summary is for.
    const { summary, payload } = await run('SUBJECT', '@nobody-at-all')
    expect(summary['conversations']).toBe(0)
    expect(summary['messages']).toBe(0)
    expect(payload['kind']).toBe('subject')
  })

  it('a subject export without a handle fails with a reason on the row', async () => {
    process.env['DATABASE_URL'] = ownerUrl!

    const job = await withTenant(workspaceId, async (tx) =>
      tx.exportJob.create({
        data: omitTenancy({ organizationId: orgId, kind: 'SUBJECT' }),
        select: { id: true },
      })
    )

    const { runExports } = await import('./exports.js')
    await runExports()

    const finished = await withTenant(workspaceId, async (tx) =>
      tx.exportJob.findUniqueOrThrow({
        where: { id: job.id },
        select: { status: true, error: true },
      })
    )

    // The reason is on the ROW, not only in a log. Somebody waiting on an export
    // should be told what went wrong without an operator going to read logs.
    expect(finished.status).toBe('FAILED')
    expect(finished.error).toMatch(/needs a handle/i)
  })
})
