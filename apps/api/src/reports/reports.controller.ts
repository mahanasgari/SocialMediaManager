import { Controller, Get, Query, Res } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import type { FastifyReply } from 'fastify'
import { withTenant } from '@smm/database'
import { describeStatus } from '@smm/publishing'
import { errors } from '../common/errors.js'
import { Caller, resolveRead, type Principal } from '../auth/principal.js'
import { MembershipService } from '../tenancy/membership.service.js'

/**
 * Reports and exports.
 *
 * The export is CSV rather than PDF. A PDF is a picture of a spreadsheet: it
 * cannot be filtered, pivoted, or joined to anything, and every person who
 * receives one immediately wants the numbers instead. CSV opens in the tool the
 * recipient already uses, and a branded PDF renderer is a large dependency for
 * an artefact that is worse.
 */
@ApiTags('reports')
@Controller('reports')
export class ReportsController {
  constructor(private readonly memberships: MembershipService) {}

  @Get('posts.csv')
  @ApiOperation({ summary: 'Every post in a range, as CSV' })
  async postsCsv(
    @Query('workspaceId') workspaceId: string,
    @Query('days') days: string,
    @Caller() principal: Principal | undefined,
    @Res({ passthrough: true }) reply: FastifyReply
  ): Promise<string> {
    if (!workspaceId) throw errors.validation('workspaceId is required.', 'workspaceId')
    await resolveRead(principal, workspaceId, 'analytics:read', (u, w) =>
      this.memberships.requireAccess(u, w)
    )

    const window = Math.min(Math.max(Number(days) || 30, 1), 365)
    const since = new Date(Date.now() - window * 86_400_000)

    const rows = await withTenant(workspaceId, async (tx) => {
      const posts = await tx.post.findMany({
        where: { createdAt: { gte: since } },
        select: {
          id: true,
          status: true,
          baseContent: true,
          scheduledAt: true,
          publishedAt: true,
          createdAt: true,
          author: { select: { name: true } },
          variants: {
            select: {
              status: true,
              remoteUrl: true,
              publishedLate: true,
              latenessSeconds: true,
              socialAccount: { select: { handle: true, provider: true } },
              metrics: {
                orderBy: { capturedAt: 'desc' },
                take: 1,
                select: {
                  impressions: true,
                  reach: true,
                  likes: true,
                  comments: true,
                  shares: true,
                  clicks: true,
                  engagementRate: true,
                },
              },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
      })

      // One row PER VARIANT, not per post. A post that went to four channels
      // performed four different ways, and collapsing that into one row throws
      // away the comparison the export exists to make.
      return posts.flatMap((post) =>
        post.variants.map((variant) => {
          const metric = variant.metrics[0]
          return {
            post_id: post.id,
            created_at: post.createdAt.toISOString(),
            scheduled_at: post.scheduledAt?.toISOString() ?? '',
            published_at: post.publishedAt?.toISOString() ?? '',
            author: post.author?.name ?? '',
            post_status: post.status,
            channel: variant.socialAccount.handle,
            provider: variant.socialAccount.provider,
            channel_status: variant.status,
            published_late: variant.publishedLate ? 'yes' : 'no',
            lateness_seconds: variant.latenessSeconds ?? '',
            url: variant.remoteUrl ?? '',
            // Empty, never 0, when the network does not report it. A zero in a
            // spreadsheet gets averaged; an empty cell does not.
            impressions: metric?.impressions ?? '',
            reach: metric?.reach ?? '',
            likes: metric?.likes ?? '',
            comments: metric?.comments ?? '',
            shares: metric?.shares ?? '',
            clicks: metric?.clicks ?? '',
            engagement_rate: metric?.engagementRate ?? '',
            content: post.baseContent,
          }
        })
      )
    })

    const filename = `posts-${new Date().toISOString().slice(0, 10)}.csv`
    void reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="${filename}"`)

    return toCsv(rows)
  }

  @Get('summary')
  @ApiOperation({ summary: 'A workspace summary suitable for a client report' })
  async summary(
    @Query('workspaceId') workspaceId: string,
    @Query('days') days: string,
    @Caller() principal: Principal | undefined
  ) {
    if (!workspaceId) throw errors.validation('workspaceId is required.', 'workspaceId')
    await resolveRead(principal, workspaceId, 'analytics:read', (u, w) =>
      this.memberships.requireAccess(u, w)
    )

    const window = Math.min(Math.max(Number(days) || 30, 1), 365)
    const since = new Date(Date.now() - window * 86_400_000)

    return withTenant(workspaceId, async (tx) => {
      const posts = await tx.post.findMany({
        where: { createdAt: { gte: since } },
        select: { status: true, variants: { select: { status: true, publishedLate: true } } },
      })

      const byStatus: Record<string, number> = {}
      let lateCount = 0
      let variantCount = 0

      for (const post of posts) {
        byStatus[post.status] = (byStatus[post.status] ?? 0) + 1
        for (const v of post.variants) {
          variantCount++
          if (v.publishedLate) lateCount++
        }
      }

      const published = posts.filter((p) => p.status === 'PUBLISHED').length

      return {
        windowDays: window,
        totalPosts: posts.length,
        totalChannelPosts: variantCount,
        byStatus,
        // Surfaced because it is the number an operator needs and no dashboard
        // usually shows: how often the scheduler is running behind.
        //
        // Counts only delay the 30s tick rate cannot explain. Every post is a
        // few seconds late by construction, and a figure that is always 100%
        // would report nothing. See Scanner.isNotablyLate.
        publishedLate: lateCount,
        headline: describeStatus('PUBLISHED', { published, total: posts.length }),
      }
    })
  }
}

/**
 * RFC 4180 CSV.
 *
 * The leading-quote guard is not pedantry: a cell beginning with =, +, - or @ is
 * executed as a formula by Excel and Sheets. A post whose text starts with "=" —
 * or one crafted to — becomes code running on the machine of whoever opens the
 * export. Prefixing a single quote neutralises it while still reading correctly.
 */
export function toCsv(rows: Array<Record<string, unknown>>): string {
  if (rows.length === 0) return ''

  const headers = Object.keys(rows[0]!)
  const lines = [headers.join(',')]

  for (const row of rows) {
    lines.push(headers.map((h) => escapeCell(row[h])).join(','))
  }

  // CRLF, which is what the spec says and what Excel expects.
  return lines.join('\r\n')
}

export function escapeCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  let text = String(value)

  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`

  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`
  }
  return text
}
