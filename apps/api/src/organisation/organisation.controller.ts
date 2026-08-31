import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import { withTenant } from '@smm/database'
import { presetVariables, render, resolvePreset, tagText, variablesIn } from '@smm/content'
import { z } from 'zod'
import { errors } from '../common/errors.js'
import { Caller, resolveAccess, resolveRead, type Principal } from '../auth/principal.js'
import { MembershipService } from '../tenancy/membership.service.js'

/**
 * Campaigns, labels, templates and UTM presets.
 *
 * Four small resources in one controller because they are the same shape — a
 * named thing a workspace owns, used to organise posts — and four controllers
 * of forty lines each would spread one idea across four files.
 *
 * The interesting logic is not here. Variable substitution and URL tagging live
 * in `@smm/content`, which is pure and browser-importable, so the composer
 * previews exactly what the API will write. A preview computed by different
 * code from the thing it previews is not a preview.
 */

const HEX = /^#[0-9a-fA-F]{6}$/

const campaignSchema = z.object({
  workspaceId: z.string().uuid(),
  name: z.string().min(1).max(120),
  description: z.string().max(1000).optional(),
  color: z.string().regex(HEX, 'Use a hex colour like #6366f1.').default('#6366f1'),
  startsAt: z.coerce.date().optional(),
  endsAt: z.coerce.date().optional(),
})

const labelSchema = z.object({
  workspaceId: z.string().uuid(),
  name: z.string().min(1).max(60),
  color: z.string().regex(HEX, 'Use a hex colour like #64748b.').default('#64748b'),
})

const templateSchema = z.object({
  workspaceId: z.string().uuid(),
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  body: z.string().min(1).max(10_000),
})

const presetSchema = z.object({
  workspaceId: z.string().uuid(),
  name: z.string().min(1).max(120),
  // Required, both of them. A UTM tag missing source or medium lands in the
  // "(not set)" bucket of every analytics tool, which is indistinguishable from
  // not having tagged the link at all.
  source: z.string().min(1).max(120),
  medium: z.string().min(1).max(120),
  campaign: z.string().max(120).optional(),
  term: z.string().max(120).optional(),
  content: z.string().max(120).optional(),
  isDefault: z.boolean().default(false),
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

function required(workspaceId: string | undefined): string {
  if (!workspaceId) throw errors.validation('workspaceId is required.', 'workspaceId')
  return workspaceId
}

/** Postgres unique-violation, turned into a message that names the field. */
function isDuplicate(err: unknown): boolean {
  return (err as { code?: string })?.code === 'P2002'
}

@ApiTags('organisation')
@Controller()
export class OrganisationController {
  constructor(private readonly memberships: MembershipService) {}

  private read(principal: Principal | undefined, workspaceId: string) {
    return resolveRead(principal, workspaceId, 'posts:read', (u, w) =>
      this.memberships.requireAccess(u, w)
    )
  }

  private write(principal: Principal | undefined, workspaceId: string) {
    return resolveAccess(principal, workspaceId, 'content.create', (u, w) =>
      this.memberships.requireAccess(u, w)
    )
  }

  // -- Campaigns ------------------------------------------------------------

  @Get('campaigns')
  @ApiOperation({ summary: 'Campaigns in a workspace' })
  async campaigns(
    @Query('workspaceId') workspaceIdRaw: string,
    @Query('includeArchived') includeArchived: string | undefined,
    @Caller() principal: Principal | undefined
  ) {
    const workspaceId = required(workspaceIdRaw)
    await this.read(principal, workspaceId)

    return withTenant(workspaceId, async (tx) => {
      const rows = await tx.campaign.findMany({
        where: includeArchived === 'true' ? {} : { archived: false },
        orderBy: [{ archived: 'asc' }, { startsAt: 'desc' }, { createdAt: 'desc' }],
        select: {
          id: true,
          name: true,
          description: true,
          color: true,
          startsAt: true,
          endsAt: true,
          archived: true,
          _count: { select: { posts: true } },
        },
      })
      // The count is flattened here rather than in the UI: `_count.posts` is a
      // Prisma detail, and leaking it into the public API shape means every
      // consumer learns our ORM.
      return rows.map(({ _count, ...rest }) => ({ ...rest, postCount: _count.posts }))
    })
  }

  @Post('campaigns')
  @ApiOperation({ summary: 'Create a campaign' })
  async createCampaign(@Body() body: unknown, @Caller() principal: Principal | undefined) {
    const input = parse(campaignSchema, body)
    await this.write(principal, input.workspaceId)

    if (input.startsAt && input.endsAt && input.endsAt < input.startsAt) {
      throw errors.validation('The end date cannot be before the start date.', 'endsAt')
    }

    try {
      return await withTenant(input.workspaceId, async (tx) =>
        tx.campaign.create({
          data: {
            name: input.name,
            color: input.color,
            ...(input.description ? { description: input.description } : {}),
            ...(input.startsAt ? { startsAt: input.startsAt } : {}),
            ...(input.endsAt ? { endsAt: input.endsAt } : {}),
          } as never,
          select: { id: true, name: true, color: true },
        })
      )
    } catch (err) {
      if (isDuplicate(err)) {
        throw errors.conflict('campaign_name_taken', `A campaign called "${input.name}" already exists.`)
      }
      throw err
    }
  }

  @Patch('campaigns/:id')
  @ApiOperation({ summary: 'Update or archive a campaign' })
  async updateCampaign(
    @Param('id') id: string,
    @Body() body: unknown,
    @Caller() principal: Principal | undefined
  ) {
    const input = parse(
      campaignSchema.partial().extend({
        workspaceId: z.string().uuid(),
        archived: z.boolean().optional(),
      }),
      body
    )
    await this.write(principal, input.workspaceId)

    return withTenant(input.workspaceId, async (tx) => {
      const existing = await tx.campaign.findUnique({ where: { id }, select: { id: true } })
      if (!existing) throw errors.notFound('That campaign does not exist.')

      return tx.campaign.update({
        where: { id },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.color !== undefined ? { color: input.color } : {}),
          ...(input.startsAt !== undefined ? { startsAt: input.startsAt } : {}),
          ...(input.endsAt !== undefined ? { endsAt: input.endsAt } : {}),
          ...(input.archived !== undefined ? { archived: input.archived } : {}),
        },
        select: { id: true, name: true, archived: true },
      })
    })
  }

  @Delete('campaigns/:id')
  @ApiOperation({ summary: 'Delete a campaign, keeping its posts' })
  async deleteCampaign(
    @Param('id') id: string,
    @Query('workspaceId') workspaceIdRaw: string,
    @Caller() principal: Principal | undefined
  ) {
    const workspaceId = required(workspaceIdRaw)
    await resolveAccess(principal, workspaceId, 'content.delete', (u, w) =>
      this.memberships.requireAccess(u, w)
    )

    return withTenant(workspaceId, async (tx) => {
      const campaign = await tx.campaign.findUnique({
        where: { id },
        select: { id: true, _count: { select: { posts: true } } },
      })
      if (!campaign) throw errors.notFound('That campaign does not exist.')

      await tx.campaign.delete({ where: { id } })
      // The posts survive — the foreign key is SetNull. They went out and their
      // metrics are real whether or not the grouping still exists.
      return { deleted: true, postsUngrouped: campaign._count.posts }
    })
  }

  // -- Labels ---------------------------------------------------------------

  @Get('labels')
  @ApiOperation({ summary: 'Labels in a workspace' })
  async labels(
    @Query('workspaceId') workspaceIdRaw: string,
    @Caller() principal: Principal | undefined
  ) {
    const workspaceId = required(workspaceIdRaw)
    await this.read(principal, workspaceId)

    return withTenant(workspaceId, async (tx) => {
      const rows = await tx.label.findMany({
        orderBy: { name: 'asc' },
        select: { id: true, name: true, color: true, _count: { select: { posts: true } } },
      })
      return rows.map(({ _count, ...rest }) => ({ ...rest, postCount: _count.posts }))
    })
  }

  @Post('labels')
  @ApiOperation({ summary: 'Create a label' })
  async createLabel(@Body() body: unknown, @Caller() principal: Principal | undefined) {
    const input = parse(labelSchema, body)
    await this.write(principal, input.workspaceId)

    try {
      return await withTenant(input.workspaceId, async (tx) =>
        tx.label.create({
          data: { name: input.name, color: input.color } as never,
          select: { id: true, name: true, color: true },
        })
      )
    } catch (err) {
      if (isDuplicate(err)) throw errors.conflict('label_name_taken', `A label called "${input.name}" already exists.`)
      throw err
    }
  }

  @Delete('labels/:id')
  @ApiOperation({ summary: 'Delete a label' })
  async deleteLabel(
    @Param('id') id: string,
    @Query('workspaceId') workspaceIdRaw: string,
    @Caller() principal: Principal | undefined
  ) {
    const workspaceId = required(workspaceIdRaw)
    await resolveAccess(principal, workspaceId, 'content.delete', (u, w) =>
      this.memberships.requireAccess(u, w)
    )

    return withTenant(workspaceId, async (tx) => {
      const label = await tx.label.findUnique({ where: { id }, select: { id: true } })
      if (!label) throw errors.notFound('That label does not exist.')
      await tx.label.delete({ where: { id } })
      return { deleted: true }
    })
  }

  @Post('posts/:postId/labels')
  @ApiOperation({ summary: 'Set the labels on a post' })
  async setPostLabels(
    @Param('postId') postId: string,
    @Body() body: unknown,
    @Caller() principal: Principal | undefined
  ) {
    const input = parse(
      z.object({ workspaceId: z.string().uuid(), labelIds: z.array(z.string().uuid()).max(20) }),
      body
    )
    await resolveAccess(principal, input.workspaceId, 'content.edit', (u, w) =>
      this.memberships.requireAccess(u, w)
    )

    return withTenant(input.workspaceId, async (tx) => {
      const post = await tx.post.findUnique({ where: { id: postId }, select: { id: true } })
      if (!post) throw errors.notFound('That post does not exist.')

      // The label ids are checked against THIS workspace before being written.
      // Without it a caller could attach another workspace's label id — the
      // join row would carry our workspaceId and pass RLS, while pointing at a
      // label the tenant cannot see. A dangling reference, created legitimately.
      const valid = await tx.label.findMany({
        where: { id: { in: input.labelIds } },
        select: { id: true },
      })
      const validIds = new Set(valid.map((l) => l.id))
      const unknown = input.labelIds.filter((id) => !validIds.has(id))
      if (unknown.length > 0) {
        throw errors.validation(
          `${unknown.length} of those labels do not exist in this workspace.`,
          'labelIds'
        )
      }

      // Replace rather than merge: the client sends the complete set it wants,
      // so removing a label is expressible. A merge-only endpoint needs a second
      // one to undo it.
      await tx.postLabel.deleteMany({ where: { postId } })
      if (validIds.size > 0) {
        await tx.postLabel.createMany({
          data: [...validIds].map((labelId) => ({ postId, labelId })) as never,
        })
      }

      return { labelIds: [...validIds] }
    })
  }

  // -- Templates ------------------------------------------------------------

  @Get('templates')
  @ApiOperation({ summary: 'Templates in a workspace' })
  async templates(
    @Query('workspaceId') workspaceIdRaw: string,
    @Caller() principal: Principal | undefined
  ) {
    const workspaceId = required(workspaceIdRaw)
    await this.read(principal, workspaceId)

    return withTenant(workspaceId, async (tx) =>
      tx.template.findMany({
        // Most-used first. A list ordered by creation date buries the three
        // templates somebody actually reaches for under everything they tried.
        orderBy: [{ usageCount: 'desc' }, { name: 'asc' }],
        select: {
          id: true,
          name: true,
          description: true,
          body: true,
          variables: true,
          usageCount: true,
        },
      })
    )
  }

  @Post('templates')
  @ApiOperation({ summary: 'Create a template' })
  async createTemplate(@Body() body: unknown, @Caller() principal: Principal | undefined) {
    const input = parse(templateSchema, body)
    await this.write(principal, input.workspaceId)

    try {
      return await withTenant(input.workspaceId, async (tx) =>
        tx.template.create({
          data: {
            name: input.name,
            body: input.body,
            // Derived on write, so listing templates never means parsing them.
            variables: variablesIn(input.body),
            ...(input.description ? { description: input.description } : {}),
            ...(principal?.kind === 'user' ? { createdById: principal.userId } : {}),
          } as never,
          select: { id: true, name: true, variables: true },
        })
      )
    } catch (err) {
      if (isDuplicate(err)) {
        throw errors.conflict('template_name_taken', `A template called "${input.name}" already exists.`)
      }
      throw err
    }
  }

  @Patch('templates/:id')
  @ApiOperation({ summary: 'Update a template' })
  async updateTemplate(
    @Param('id') id: string,
    @Body() body: unknown,
    @Caller() principal: Principal | undefined
  ) {
    const input = parse(
      templateSchema.partial().extend({ workspaceId: z.string().uuid() }),
      body
    )
    await resolveAccess(principal, input.workspaceId, 'content.edit', (u, w) =>
      this.memberships.requireAccess(u, w)
    )

    return withTenant(input.workspaceId, async (tx) => {
      const existing = await tx.template.findUnique({ where: { id }, select: { id: true } })
      if (!existing) throw errors.notFound('That template does not exist.')

      return tx.template.update({
        where: { id },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          // The derived list has to move with the body or it goes stale, which
          // would show the author a form asking for variables the template no
          // longer has.
          ...(input.body !== undefined
            ? { body: input.body, variables: variablesIn(input.body) }
            : {}),
        },
        select: { id: true, name: true, variables: true },
      })
    })
  }

  @Post('templates/:id/render')
  @ApiOperation({ summary: 'Render a template, reporting anything unfilled' })
  async renderTemplate(
    @Param('id') id: string,
    @Body() body: unknown,
    @Caller() principal: Principal | undefined
  ) {
    const input = parse(
      z.object({
        workspaceId: z.string().uuid(),
        values: z.record(z.string()).default({}) as z.ZodType<Record<string, string>>,
        /** Counts as a use. False while the composer is previewing keystrokes. */
        commit: z.boolean().default(false),
      }),
      body
    )
    await this.read(principal, input.workspaceId)

    return withTenant(input.workspaceId, async (tx) => {
      const template = await tx.template.findUnique({
        where: { id },
        select: { id: true, body: true },
      })
      if (!template) throw errors.notFound('That template does not exist.')

      const result = render(template.body, input.values)

      // Usage counts only on a real use, and only when the result is complete.
      // Counting previews would make the ordering measure typing rather than
      // usefulness.
      if (input.commit && result.missing.length === 0) {
        await tx.template.update({ where: { id }, data: { usageCount: { increment: 1 } } })
      }

      return result
    })
  }

  @Delete('templates/:id')
  @ApiOperation({ summary: 'Delete a template' })
  async deleteTemplate(
    @Param('id') id: string,
    @Query('workspaceId') workspaceIdRaw: string,
    @Caller() principal: Principal | undefined
  ) {
    const workspaceId = required(workspaceIdRaw)
    await resolveAccess(principal, workspaceId, 'content.delete', (u, w) =>
      this.memberships.requireAccess(u, w)
    )

    return withTenant(workspaceId, async (tx) => {
      const template = await tx.template.findUnique({ where: { id }, select: { id: true } })
      if (!template) throw errors.notFound('That template does not exist.')
      await tx.template.delete({ where: { id } })
      return { deleted: true }
    })
  }

  // -- UTM presets ----------------------------------------------------------

  @Get('utm-presets')
  @ApiOperation({ summary: 'UTM presets in a workspace' })
  async presets(
    @Query('workspaceId') workspaceIdRaw: string,
    @Caller() principal: Principal | undefined
  ) {
    const workspaceId = required(workspaceIdRaw)
    await this.read(principal, workspaceId)

    return withTenant(workspaceId, async (tx) => {
      const rows = await tx.utmPreset.findMany({
        orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
        select: {
          id: true,
          name: true,
          source: true,
          medium: true,
          campaign: true,
          term: true,
          content: true,
          isDefault: true,
        },
      })
      // The variables each preset needs, so the UI can say what it will ask for
      // rather than failing at apply time.
      return rows.map((r) => ({
        ...r,
        variables: presetVariables({
          source: r.source,
          medium: r.medium,
          campaign: r.campaign ?? undefined,
          term: r.term ?? undefined,
          content: r.content ?? undefined,
        }),
      }))
    })
  }

  @Post('utm-presets')
  @ApiOperation({ summary: 'Create a UTM preset' })
  async createPreset(@Body() body: unknown, @Caller() principal: Principal | undefined) {
    const input = parse(presetSchema, body)
    await this.write(principal, input.workspaceId)

    try {
      return await withTenant(input.workspaceId, async (tx) => {
        // One default per workspace, cleared and set in the same transaction.
        // Two defaults is not a state the UI can render honestly.
        if (input.isDefault) {
          await tx.utmPreset.updateMany({ where: { isDefault: true }, data: { isDefault: false } })
        }
        return tx.utmPreset.create({
          data: {
            name: input.name,
            source: input.source,
            medium: input.medium,
            isDefault: input.isDefault,
            ...(input.campaign ? { campaign: input.campaign } : {}),
            ...(input.term ? { term: input.term } : {}),
            ...(input.content ? { content: input.content } : {}),
          } as never,
          select: { id: true, name: true, isDefault: true },
        })
      })
    } catch (err) {
      if (isDuplicate(err)) throw errors.conflict('preset_name_taken', `A preset called "${input.name}" already exists.`)
      throw err
    }
  }

  @Delete('utm-presets/:id')
  @ApiOperation({ summary: 'Delete a UTM preset' })
  async deletePreset(
    @Param('id') id: string,
    @Query('workspaceId') workspaceIdRaw: string,
    @Caller() principal: Principal | undefined
  ) {
    const workspaceId = required(workspaceIdRaw)
    await resolveAccess(principal, workspaceId, 'content.delete', (u, w) =>
      this.memberships.requireAccess(u, w)
    )

    return withTenant(workspaceId, async (tx) => {
      const preset = await tx.utmPreset.findUnique({ where: { id }, select: { id: true } })
      if (!preset) throw errors.notFound('That preset does not exist.')
      await tx.utmPreset.delete({ where: { id } })
      return { deleted: true }
    })
  }

  @Post('utm-presets/:id/apply')
  @ApiOperation({ summary: 'Preview a preset applied to some text' })
  async applyPreset(
    @Param('id') id: string,
    @Body() body: unknown,
    @Caller() principal: Principal | undefined
  ) {
    const input = parse(
      z.object({
        workspaceId: z.string().uuid(),
        text: z.string().max(20_000),
        /** Values for the preset's own variables — network, campaign, and so on. */
        context: z.record(z.string()).default({}) as z.ZodType<Record<string, string>>,
      }),
      body
    )
    await this.read(principal, input.workspaceId)

    return withTenant(input.workspaceId, async (tx) => {
      const preset = await tx.utmPreset.findUnique({
        where: { id },
        select: { source: true, medium: true, campaign: true, term: true, content: true },
      })
      if (!preset) throw errors.notFound('That preset does not exist.')

      const resolved = resolvePreset(
        {
          source: preset.source,
          medium: preset.medium,
          campaign: preset.campaign ?? undefined,
          term: preset.term ?? undefined,
          content: preset.content ?? undefined,
        },
        input.context
      )

      const tagged = tagText(input.text, resolved.params)
      // `missing` is returned alongside the result rather than thrown, because
      // a partly-resolved preset still produces useful tagging and the composer
      // should show both what it did and what it could not.
      return { ...tagged, missing: resolved.missing }
    })
  }
}
