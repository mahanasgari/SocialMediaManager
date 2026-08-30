import { Body, Controller, Delete, Get, Param, Post as HttpPost, Query } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import { withTenant } from '@smm/database'
import { registry } from '@smm/providers'
import { derivePostStatus, describeStatus, type VariantStatus } from '@smm/publishing'
import { z } from 'zod'
import { errors } from '../common/errors.js'
import { Caller, resolveAccess, resolveRead, type Principal } from '../auth/principal.js'
import { MembershipService } from '../tenancy/membership.service.js'
import { PublishService } from './publish.service.js'

const createSchema = z.object({
  workspaceId: z.string().uuid(),
  content: z.string().min(1).max(20_000),
  /** Which connected accounts this goes to. One variant per account. */
  accountIds: z.array(z.string().uuid()).min(1),
  /** Absolute ISO instant. Omit to keep it a draft. */
  scheduledAt: z.string().datetime().optional(),
  timezone: z.string().min(1).max(64).default('UTC'),
  /** Attached in order. Validated against the workspace's own library. */
  mediaIds: z.array(z.string().uuid()).max(10).default([]),
})

const validateSchema = z.object({
  workspaceId: z.string().uuid(),
  content: z.string().max(20_000),
  accountIds: z.array(z.string().uuid()),
})

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body)
  if (result.success) return result.data
  const issue = result.error.issues[0]
  throw errors.validation(
    issue ? `${issue.path.join('.') || 'body'}: ${issue.message}` : 'The request body is invalid.',
    issue?.path.join('.')
  )
}

@ApiTags('posts')
@Controller('posts')
export class PostsController {
  constructor(
    private readonly memberships: MembershipService,
    private readonly publisher: PublishService
  ) {}

  @Get()
  @ApiOperation({ summary: 'Posts in a workspace' })
  async list(
    @Query('workspaceId') workspaceId: string,
    @Caller() principal: Principal | undefined
  ) {
    if (!workspaceId) throw errors.validation('workspaceId is required.', 'workspaceId')
    await resolveRead(principal, workspaceId, 'posts:read', (u, w) =>
      this.memberships.requireAccess(u, w)
    )

    return withTenant(workspaceId, async (tx) => {
      const posts = await tx.post.findMany({
        select: {
          id: true,
          status: true,
          baseContent: true,
          scheduledAt: true,
          publishedAt: true,
          createdAt: true,
          variants: {
            select: {
              id: true,
              status: true,
              remoteUrl: true,
              lastError: true,
              socialAccount: { select: { handle: true, provider: true, displayName: true } },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        take: 100,
      })

      return posts.map((p) => {
        const published = p.variants.filter((v) => v.status === 'PUBLISHED').length
        return {
          ...p,
          // The human sentence, computed once here rather than reimplemented in
          // every client that renders a post.
          summary: describeStatus(p.status, { published, total: p.variants.length }),
        }
      })
    })
  }

  /**
   * One post, with the per-variant detail the list deliberately omits.
   *
   * The list is a list: it carries what you scan. This carries what you open a
   * post to find out — which attempt failed and why, what the provider actually
   * said, when each channel went out, and what it measured. Loading that for a
   * hundred rows would make the list unusable to serve a page nobody was on.
   */
  @Get(':id')
  @ApiOperation({ summary: 'One post, with attempt history and per-variant metrics' })
  async detail(
    @Param('id') id: string,
    @Query('workspaceId') workspaceId: string,
    @Caller() principal: Principal | undefined
  ) {
    if (!workspaceId) throw errors.validation('workspaceId is required.', 'workspaceId')
    await resolveRead(principal, workspaceId, 'posts:read', (u, w) =>
      this.memberships.requireAccess(u, w)
    )

    const post = await withTenant(workspaceId, async (tx) =>
      tx.post.findFirst({
        where: { id },
        select: {
          id: true,
          status: true,
          baseContent: true,
          scheduledAt: true,
          publishedAt: true,
          createdAt: true,
          timezone: true,
          author: { select: { name: true, email: true } },
          media: {
            orderBy: { position: 'asc' },
            select: { altText: true, media: { select: { id: true, mime: true, filename: true } } },
          },
          variants: {
            select: {
              id: true,
              status: true,
              surface: true,
              remoteId: true,
              remoteUrl: true,
              lastError: true,
              contentOverride: true,
              publishedAt: true,
              publishedLate: true,
              latenessSeconds: true,
              socialAccount: {
                select: { id: true, handle: true, provider: true, displayName: true },
              },
              /** The retry COUNT. The history is publishAttempts below. */
              attempts: true,
              publishAttempts: {
                orderBy: { startedAt: 'desc' },
                take: 10,
                select: {
                  id: true,
                  status: true,
                  startedAt: true,
                  finishedAt: true,
                  errorCode: true,
                  providerRequestId: true,
                },
              },
              metrics: {
                orderBy: { capturedAt: 'desc' },
                take: 1,
                select: {
                  capturedAt: true,
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
      })
    )

    // 404 rather than 403 — a post in another workspace must be
    // indistinguishable from one that does not exist.
    if (!post) throw errors.notFound('post')

    const published = post.variants.filter((v) => v.status === 'PUBLISHED').length
    return {
      ...post,
      summary: describeStatus(post.status, { published, total: post.variants.length }),
    }
  }

  /**
   * Live validation for the composer.
   *
   * Runs the SAME pure validate() the worker runs before publishing. One
   * definition of every platform rule; the composer's copy is a convenience, not
   * a second source of truth.
   */
  @HttpPost('validate')
  @ApiOperation({ summary: 'Per-channel validation issues for a draft' })
  async validate(@Body() body: unknown, @Caller() principal: Principal | undefined) {
    const input = parse(validateSchema, body)
    await resolveRead(principal, input.workspaceId, 'posts:read', (u, w) =>
      this.memberships.requireAccess(u, w)
    )

    return withTenant(input.workspaceId, async (tx) => {
      const accounts = await tx.socialAccount.findMany({
        where: { id: { in: input.accountIds } },
        select: { id: true, provider: true, handle: true, displayName: true },
      })

      return accounts.map((account) => {
        const provider = registry.get(account.provider as never)
        if (!provider) {
          return { accountId: account.id, handle: account.handle, issues: [], limit: null }
        }
        const issues = provider.validate({ surface: 'feed', text: input.content, media: [] })
        return {
          accountId: account.id,
          handle: account.handle,
          provider: provider.label,
          limit: provider.text['feed']?.maxLength ?? null,
          issues,
        }
      })
    })
  }

  @HttpPost()
  @ApiOperation({ summary: 'Create a post with one variant per target account' })
  async create(@Body() body: unknown, @Caller() principal: Principal | undefined) {
    const input = parse(createSchema, body)
    const access = await resolveAccess(principal, input.workspaceId, 'content.create', (u, w) =>
      this.memberships.requireAccess(u, w)
    )

    return withTenant(input.workspaceId, async (tx) => {
      const accounts = await tx.socialAccount.findMany({
        where: { id: { in: input.accountIds }, status: 'ACTIVE' },
        select: { id: true },
      })
      if (accounts.length === 0) {
        throw errors.unprocessable(
          'no_publishable_accounts',
          'None of the selected accounts are connected and active.'
        )
      }

      const post = await tx.post.create({
         
        data: {
          // Null for an API key: a key is not a person, and attributing a post
          // to one would put a name on something nobody wrote.
          authorId: access.userId ?? null,
          baseContent: input.content,
          scheduledAt: input.scheduledAt ? new Date(input.scheduledAt) : null,
          timezone: input.timezone,
          status: input.scheduledAt ? 'SCHEDULED' : 'DRAFT',
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
        select: { id: true },
      })

      for (const account of accounts) {
        await tx.postVariant.create({
           
          data: {
            postId: post.id,
            socialAccountId: account.id,
            surface: 'feed',
            status: input.scheduledAt ? 'SCHEDULED' : 'DRAFT',
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } as any,
        })
      }

      const mediaIds = input.mediaIds ?? []
      if (mediaIds.length > 0) {
        // Filtered through the workspace's own library, so an id belonging to
        // another tenant silently attaches nothing rather than leaking a file.
        const owned = await tx.mediaAsset.findMany({
          where: { id: { in: mediaIds } },
          select: { id: true },
        })
        for (const [position, asset] of owned.entries()) {
          await tx.postMedia.create({
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            data: { postId: post.id, mediaAssetId: asset.id, position } as any,
          })
        }
      }

      await tx.auditLog.create({
         
        data: {
          actorId: access.userId ?? null,
          action: 'post.created',
          entityType: 'Post',
          entityId: post.id,
          metadata: { channels: accounts.length, scheduled: Boolean(input.scheduledAt) },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
      })

      return { id: post.id, variants: accounts.length }
    })
  }

  @HttpPost(':id/publish')
  @ApiOperation({ summary: 'Publish every variant of a post now' })
  async publish(
    @Param('id') id: string,
    @Query('workspaceId') workspaceId: string,
    @Caller() principal: Principal | undefined
  ) {
    if (!workspaceId) throw errors.validation('workspaceId is required.', 'workspaceId')
    await resolveAccess(principal, workspaceId, 'content.publish', (u, w) =>
      this.memberships.requireAccess(u, w)
    )

    const variants = await withTenant(workspaceId, async (tx) =>
      tx.postVariant.findMany({
        where: { postId: id, status: { in: ['DRAFT', 'SCHEDULED', 'QUEUED', 'FAILED'] } },
        select: { id: true },
      })
    )
    if (variants.length === 0) throw errors.notFound('publishable post')

    // Sequential, not parallel. The per-account mutex would serialise same-account
    // variants anyway, and publishing one channel at a time keeps the failure
    // attribution unambiguous.
    const results: Record<string, VariantStatus> = {}
    for (const variant of variants) {
      results[variant.id] = await this.publisher.publishVariant(workspaceId, variant.id)
    }

    const statuses = Object.values(results)
    const derived = derivePostStatus(statuses)
    const published = statuses.filter((s) => s === 'PUBLISHED').length

    return {
      status: derived,
      summary: describeStatus(derived, { published, total: statuses.length }),
      variants: results,
    }
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a draft or scheduled post' })
  async remove(
    @Param('id') id: string,
    @Query('workspaceId') workspaceId: string,
    @Caller() principal: Principal | undefined
  ) {
    if (!workspaceId) throw errors.validation('workspaceId is required.', 'workspaceId')
    await resolveAccess(principal, workspaceId, 'content.delete', (u, w) =>
      this.memberships.requireAccess(u, w)
    )

    await withTenant(workspaceId, async (tx) => {
      // Soft delete: a published post's history and metrics stay attributed.
      await tx.post.update({ where: { id }, data: { deletedAt: new Date() } })
    })
    return { deleted: true }
  }
}
