import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createTestClient,
  withOrganization,
  withSystemScope,
  withTenant,
  type Db,
} from '@smm/database'

/**
 * Cursor pagination over posts, against a real database.
 *
 * The list was capped at a hundred rows with no way past it: a workspace with
 * five hundred posts could see a hundred, and nothing said the rest existed.
 *
 * The properties that matter are the ones a naive offset gets wrong. Walking
 * pages must visit every row EXACTLY once — no duplicate across a boundary, no
 * row skipped — and it must keep doing that while rows are being inserted,
 * which is the whole reason for a cursor rather than OFFSET.
 *
 * Lives in the worker suite because that is where the integration harness with
 * a real database is; the query under test is the API's.
 */

const dbUrl = process.env['TEST_DATABASE_URL']
const ownerUrl = process.env['TEST_DATABASE_OWNER_URL'] ?? dbUrl

const suite = dbUrl ? describe : describe.skip
if (!dbUrl) console.warn('\n  [skipped] pagination — run: bash scripts/test-db.sh up\n')

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const omitTenancy = <T,>(data: T) => data as any

let client: Db
let orgId: string
let userId: string
let workspaceId: string

const TOTAL = 25
const PAGE = 10

suite('paging through posts', () => {
  beforeAll(async () => {
    client = createTestClient(ownerUrl!)
    process.env['DATABASE_URL'] = ownerUrl!
    const stamp = Date.now()

    await withSystemScope('pagination fixture', async () => {
      const org = await client.organization.create({
        data: { name: 'Page Org', slug: `page-${stamp}` },
      })
      orgId = org.id
      const user = await client.user.create({
        data: { email: `page-${stamp}@example.com`, passwordHash: 'x', name: 'Page' },
      })
      userId = user.id
    })

    await withOrganization(orgId, async (tx) => {
      const ws = await tx.workspace.create({
        data: omitTenancy({ name: 'Page WS', slug: `page-${stamp}` }),
      })
      workspaceId = ws.id
      await tx.membership.create({ data: omitTenancy({ userId, workspaceId, role: 'OWNER' }) })
    })

    await withTenant(workspaceId, async (tx) => {
      for (let i = 0; i < TOTAL; i++) {
        await tx.post.create({
          data: omitTenancy({
            organizationId: orgId,
            authorId: userId,
            baseContent: `Post ${String(i).padStart(3, '0')}`,
            status: 'DRAFT',
          }),
        })
      }
    })
  }, 90_000)

  afterAll(async () => {
    await withSystemScope('pagination teardown', async () => {
      await client.organization.delete({ where: { id: orgId } })
      await client.user.delete({ where: { id: userId } })
    })
    await client.$disconnect()
  }, 30_000)

  /** One page, exactly as the controller asks for it. */
  async function page(cursor?: string) {
    return withTenant(workspaceId, async (tx) => {
      const rows = await tx.post.findMany({
        select: { id: true, baseContent: true },
        orderBy: { id: 'desc' },
        take: PAGE + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      })
      const hasMore = rows.length > PAGE
      const items = hasMore ? rows.slice(0, PAGE) : rows
      return {
        items,
        nextCursor: hasMore ? (items[items.length - 1]?.id ?? null) : null,
      }
    })
  }

  it('walks every post exactly once', async () => {
    // The property an offset gets wrong. Not "roughly all of them" — every row,
    // once, with nothing repeated at a page boundary and nothing skipped.
    const seen: string[] = []
    let cursor: string | undefined
    let guard = 0

    for (;;) {
      const result = await page(cursor)
      seen.push(...result.items.map((r) => r.baseContent))
      if (!result.nextCursor) break
      cursor = result.nextCursor
      if (++guard > 20) throw new Error('pagination did not terminate')
    }

    expect(seen).toHaveLength(TOTAL)
    expect(new Set(seen).size).toBe(TOTAL)
  })

  it('returns newest first, and keeps that order across pages', async () => {
    const first = await page()
    const second = await page(first.nextCursor!)

    expect(first.items[0]?.baseContent).toBe(`Post ${String(TOTAL - 1).padStart(3, '0')}`)
    // The first row of page two must come strictly after the last of page one.
    expect(second.items[0]!.id < first.items[first.items.length - 1]!.id).toBe(true)
  })

  it('reports no cursor on the final page', async () => {
    let cursor: string | undefined
    let last: Awaited<ReturnType<typeof page>> | null = null
    for (let i = 0; i < 5; i++) {
      last = await page(cursor)
      if (!last.nextCursor) break
      cursor = last.nextCursor
    }
    expect(last?.nextCursor).toBeNull()
    // 25 posts at 10 a page: the last page holds five.
    expect(last?.items).toHaveLength(TOTAL % PAGE)
  })

  it('does not shift a page when a new post is inserted mid-walk', async () => {
    // THE reason this is a cursor and not an offset. With OFFSET 10, inserting
    // a newer row pushes everything down one and page two repeats the last row
    // of page one. A cursor is anchored to a row, so new arrivals at the top
    // cannot disturb a walk already in progress.
    const first = await page()
    const lastOfFirst = first.items[first.items.length - 1]!.baseContent

    await withTenant(workspaceId, async (tx) => {
      await tx.post.create({
        data: omitTenancy({
          organizationId: orgId,
          authorId: userId,
          baseContent: 'Inserted mid-walk',
          status: 'DRAFT',
        }),
      })
    })

    const second = await page(first.nextCursor!)
    const contents = second.items.map((r) => r.baseContent)

    expect(contents).not.toContain(lastOfFirst)
    expect(contents).not.toContain('Inserted mid-walk')
  })
})
