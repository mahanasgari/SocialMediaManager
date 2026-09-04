import { Body, Controller, Post } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import { withTenant } from '@smm/database'
import { registry } from '@smm/providers'
import { mapColumns, parseAccounts, parseCsv, parseWhen } from '@smm/content'
import { z } from 'zod'
import { CurrentUser } from '../auth/current-user.js'
import type { SessionPrincipal } from '../auth/session.service.js'
import { errors } from '../common/errors.js'
import { MembershipService } from '../tenancy/membership.service.js'

const importSchema = z.object({
  workspaceId: z.string().uuid(),
  // 2 MB of text. Far beyond any hand-made calendar and far below anything that
  // would take the process down parsing it.
  csv: z.string().min(1).max(2_000_000),
  /**
   * False means "tell me what would happen"; true means "do it".
   *
   * A dry run by default, and the UI always asks for one first. Importing two
   * hundred posts is not something to discover you got wrong afterwards, and
   * there is no undo that puts a published post back.
   */
  commit: z.boolean().default(false),
  /** Accounts every row goes to, when the file names none. */
  defaultAccountIds: z.array(z.string().uuid()).default([]),
})

function parse<S extends z.ZodTypeAny>(schema: S, body: unknown): z.output<S> {
  const result = schema.safeParse(body)
  if (result.success) return result.data
  const issue = result.error.issues[0]
  throw errors.validation(
    issue ? `${issue.path.join('.') || 'body'}: ${issue.message}` : 'The request body is invalid.',
    issue?.path.join('.')
  )
}

type RowResult = {
  line: number
  content: string
  scheduledAt: string | null
  accountHandles: string[]
  accountIds: string[]
  problems: string[]
}

/**
 * Bulk-importing a content calendar from a spreadsheet.
 *
 * Phase 4 asked for this and it was never built, so the only way to load a
 * quarter of planned posts was to type them one at a time.
 *
 * PREVIEW FIRST, ALWAYS. The endpoint defaults to a dry run and the UI asks for
 * one before it offers to commit. Two hundred posts is not something to
 * discover you got wrong afterwards — and unlike most mistakes in this product,
 * a published post has no undo.
 *
 * A ROW WITH A PROBLEM IS REPORTED, NOT DROPPED. Importing eighteen of twenty
 * rows and saying "imported 18" leaves someone to work out which two are
 * missing and why. Every row comes back with its line number and what is wrong
 * with it, and the commit refuses while any row is broken.
 */
@ApiTags('posts')
@Controller('posts/import')
export class ImportController {
  constructor(private readonly memberships: MembershipService) {}

  /** More than a person plans by hand, and enough to keep one request bounded. */
  private static readonly MAX_ROWS = 500

  @Post()
  @ApiOperation({ summary: 'Preview or commit a CSV of posts' })
  async run(@Body() body: unknown, @CurrentUser() principal: SessionPrincipal | undefined) {
    if (!principal) throw errors.unauthenticated()
    const input = parse(importSchema, body)

    const access = await this.memberships.requireAccess(principal.userId, input.workspaceId)
    if (access.role === 'VIEWER' || access.role === 'CLIENT' || access.role === 'ANALYST') {
      throw errors.forbidden('You cannot create posts in this workspace.')
    }

    const rows = parseCsv(input.csv)
    if (rows.length === 0) throw errors.validation('That file is empty.', 'csv')

    const columns = mapColumns(rows[0]!)
    if ('error' in columns) throw errors.validation(columns.error, 'csv')

    const body_ = rows.slice(1)
    if (body_.length === 0) {
      throw errors.validation('That file has a header row and nothing else.', 'csv')
    }
    if (body_.length > ImportController.MAX_ROWS) {
      throw errors.validation(
        `That file has ${body_.length} rows; the limit is ${ImportController.MAX_ROWS} at a time. ` +
          'Split it and import in batches.',
        'csv'
      )
    }

    return withTenant(input.workspaceId, async (tx) => {
      const accounts = await tx.socialAccount.findMany({
        where: { status: 'ACTIVE' },
        select: { id: true, handle: true, provider: true },
      })

      // Handles are matched case-insensitively and with a leading @ optional,
      // because a spreadsheet column typed by a person has both forms in it.
      const byHandle = new Map(
        accounts.map((a) => [a.handle.replace(/^@/, '').toLowerCase(), a])
      )

      const results: RowResult[] = body_.map((row, index) => {
        const line = index + 2 // 1-based, and the header is line 1.
        const content = (row[columns.content] ?? '').trim()
        const problems: string[] = []

        if (content === '') problems.push('No content.')

        let scheduledAt: Date | null = null
        if (columns.scheduledAt !== null) {
          const when = parseWhen(row[columns.scheduledAt] ?? '')
          if (when === undefined) {
            problems.push(`Could not read the date "${row[columns.scheduledAt] ?? ''}".`)
          } else {
            scheduledAt = when
          }
        }

        const handles =
          columns.accounts !== null ? parseAccounts(row[columns.accounts] ?? '') : []

        const matched: string[] = []
        for (const handle of handles) {
          const account = byHandle.get(handle.replace(/^@/, '').toLowerCase())
          if (account) matched.push(account.id)
          else problems.push(`No connected account called "${handle}".`)
        }

        const accountIds = matched.length > 0 ? matched : input.defaultAccountIds
        if (accountIds.length === 0) {
          problems.push('No channels. Name them in an accounts column, or pick defaults above.')
        }

        // Each target validates the text it would actually receive, using the
        // same pure validate() the worker calls — so a caption too long for
        // Instagram is caught here rather than at 09:00 next Tuesday.
        for (const id of accountIds) {
          const account = accounts.find((a) => a.id === id)
          const provider = account && registry.get(account.provider as never)
          if (!provider) continue
          const surface = registry.defaultSurfaceOf(provider)
          for (const issue of provider.validate({ surface, text: content, media: [] })) {
            if (issue.severity === 'error') {
              problems.push(`${provider.label}: ${issue.message}`)
            }
          }
        }

        return {
          line,
          content,
          scheduledAt: scheduledAt ? scheduledAt.toISOString() : null,
          accountHandles: handles,
          accountIds,
          problems,
        }
      })

      const broken = results.filter((r) => r.problems.length > 0)

      if (!input.commit) {
        return {
          committed: false,
          rows: results,
          ready: results.length - broken.length,
          broken: broken.length,
        }
      }

      // All or nothing. A partial import leaves someone reconciling a
      // spreadsheet against a calendar to find what did not arrive.
      if (broken.length > 0) {
        throw errors.validation(
          `${broken.length} of ${results.length} rows have problems. Fix them and import again — ` +
            'nothing was created.',
          'csv'
        )
      }

      let created = 0
      for (const row of results) {
        const post = await tx.post.create({
          data: {
            workspaceId: input.workspaceId,
            organizationId: access.organizationId,
            authorId: principal.userId,
            baseContent: row.content,
            status: row.scheduledAt ? 'SCHEDULED' : 'DRAFT',
            ...(row.scheduledAt ? { scheduledAt: new Date(row.scheduledAt) } : {}),
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } as any,
          select: { id: true },
        })

        for (const accountId of row.accountIds) {
          const account = accounts.find((a) => a.id === accountId)
          const provider = account && registry.get(account.provider as never)
          await tx.postVariant.create({
            data: {
              workspaceId: input.workspaceId,
              organizationId: access.organizationId,
              postId: post.id,
              socialAccountId: accountId,
              surface: provider ? registry.defaultSurfaceOf(provider) : 'feed',
              status: row.scheduledAt ? 'SCHEDULED' : 'DRAFT',
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
            } as any,
          })
        }
        created++
      }

      return { committed: true, created, rows: results, ready: created, broken: 0 }
    })
  }
}
