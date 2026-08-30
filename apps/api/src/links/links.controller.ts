import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import { withPublicPage, withTenant } from '@smm/database'
import { z } from 'zod'
import { errors } from '../common/errors.js'
import { Public } from '../auth/auth-mode.guard.js'
import { Caller, resolveAccess, resolveRead, type Principal } from '../auth/principal.js'
import { MembershipService } from '../tenancy/membership.service.js'

const SLUG = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/

const pageSchema = z.object({
  workspaceId: z.string().uuid(),
  slug: z.string().regex(SLUG, 'Use 3–40 lowercase letters, numbers or hyphens.'),
  title: z.string().min(1).max(120),
  bio: z.string().max(500).optional(),
  published: z.boolean().default(false),
})

const linkSchema = z.object({
  workspaceId: z.string().uuid(),
  label: z.string().min(1).max(120),
  url: z.string().url(),
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

@ApiTags('link-pages')
@Controller()
export class LinksController {
  constructor(private readonly memberships: MembershipService) {}

  @Get('link-pages')
  @ApiOperation({ summary: 'Link pages in a workspace' })
  async list(
    @Query('workspaceId') workspaceId: string,
    @Caller() principal: Principal | undefined
  ) {
    if (!workspaceId) throw errors.validation('workspaceId is required.', 'workspaceId')
    await resolveRead(principal, workspaceId, 'posts:read', (u, w) =>
      this.memberships.requireAccess(u, w)
    )

    return withTenant(workspaceId, async (tx) =>
      tx.linkPage.findMany({
        select: {
          id: true,
          slug: true,
          title: true,
          bio: true,
          published: true,
          views: true,
          links: {
            select: { id: true, label: true, url: true, clicks: true, enabled: true, position: true },
            orderBy: { position: 'asc' },
          },
        },
        orderBy: { createdAt: 'desc' },
      })
    )
  }

  @Post('link-pages')
  @ApiOperation({ summary: 'Create a link page' })
  async create(@Body() body: unknown, @Caller() principal: Principal | undefined) {
    const input = parse(pageSchema, body)
    await resolveAccess(principal, input.workspaceId, 'content.create', (u, w) =>
      this.memberships.requireAccess(u, w)
    )

    try {
      return await withTenant(input.workspaceId, async (tx) =>
        tx.linkPage.create({
           
          data: {
            slug: input.slug,
            title: input.title,
            bio: input.bio ?? null,
            published: input.published,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } as any,
          select: { id: true, slug: true },
        })
      )
    } catch {
      // The slug is GLOBALLY unique because /l/:slug carries no tenant. Saying
      // "taken" leaks that some other workspace holds it, which is unavoidable —
      // any public namespace works this way, and the alternative is a URL nobody
      // can share.
      throw errors.conflict('slug_taken', 'That link is already in use. Try another.')
    }
  }

  @Post('link-pages/:id/links')
  @ApiOperation({ summary: 'Add a link to a page' })
  async addLink(
    @Param('id') id: string,
    @Body() body: unknown,
    @Caller() principal: Principal | undefined
  ) {
    const input = parse(linkSchema, body)
    await resolveAccess(principal, input.workspaceId, 'content.edit', (u, w) =>
      this.memberships.requireAccess(u, w)
    )

    return withTenant(input.workspaceId, async (tx) => {
      const count = await tx.link.count({ where: { linkPageId: id } })
      return tx.link.create({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        data: { linkPageId: id, label: input.label, url: input.url, position: count } as any,
        select: { id: true, label: true, url: true },
      })
    })
  }

  @Patch('link-pages/:id')
  @ApiOperation({ summary: 'Publish or unpublish a page' })
  async update(
    @Param('id') id: string,
    @Body() body: unknown,
    @Caller() principal: Principal | undefined
  ) {
    const input = z
      .object({ workspaceId: z.string().uuid(), published: z.boolean() })
      .parse(body)
    await resolveAccess(principal, input.workspaceId, 'content.edit', (u, w) =>
      this.memberships.requireAccess(u, w)
    )

    return withTenant(input.workspaceId, async (tx) =>
      tx.linkPage.update({
        where: { id },
        data: { published: input.published },
        select: { id: true, slug: true, published: true },
      })
    )
  }

  @Delete('links/:id')
  @ApiOperation({ summary: 'Remove a link' })
  async removeLink(
    @Param('id') id: string,
    @Query('workspaceId') workspaceId: string,
    @Caller() principal: Principal | undefined
  ) {
    if (!workspaceId) throw errors.validation('workspaceId is required.', 'workspaceId')
    await resolveAccess(principal, workspaceId, 'content.edit', (u, w) =>
      this.memberships.requireAccess(u, w)
    )
    await withTenant(workspaceId, async (tx) => tx.link.deleteMany({ where: { id } }))
    return { deleted: true }
  }

  /**
   * The public page.
   *
   * No session, no tenant context — it is public by definition. The database
   * grants a narrow actor SELECT on PUBLISHED pages and ENABLED links only, so
   * an unpublished draft is invisible even here.
   */
  @Public()
  @Get('l/:slug')
  @ApiOperation({ summary: 'A published link-in-bio page' })
  async publicPage(@Param('slug') slug: string) {
    const page = await withPublicPage(async (tx) => {
      const found = await tx.linkPage.findFirst({
        where: { slug },
        select: {
          id: true,
          slug: true,
          title: true,
          bio: true,
          avatarUrl: true,
          theme: true,
          links: {
            where: { enabled: true },
            select: { id: true, label: true, url: true },
            orderBy: { position: 'asc' },
          },
        },
      })
      if (!found) return null

      // Counted here rather than in a separate call: a view is the request
      // itself, and a client-reported view is a number anyone can inflate.
      await tx.linkPage.update({ where: { id: found.id }, data: { views: { increment: 1 } } })
      return found
    })

    if (!page) throw errors.notFound('page')
    return page
  }

  @Public()
  @Post('l/:slug/click/:linkId')
  @ApiOperation({ summary: 'Record a click and return the destination' })
  async recordClick(@Param('slug') slug: string, @Param('linkId') linkId: string) {
    const link = await withPublicPage(async (tx) => {
      const found = await tx.link.findFirst({
        // Scoped through the page's slug, so a link id alone cannot be used to
        // inflate the counter of a link on some other page.
        where: { id: linkId, page: { slug } },
        select: { id: true, url: true },
      })
      if (!found) return null
      await tx.link.update({ where: { id: found.id }, data: { clicks: { increment: 1 } } })
      return found
    })

    if (!link) throw errors.notFound('link')
    return { url: link.url }
  }
}
