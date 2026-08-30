import { Controller, Delete, Get, Param, Post, Query, Req, Res } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { authorize } from '@smm/auth'
import { withTenant } from '@smm/database'
import {
  checkUpload,
  deleteObject,
  getObject,
  InvalidRelayToken,
  putObject,
  storageKey,
  UnsupportedUpload,
  verifyRelayToken,
} from '@smm/storage'
import { errors } from '../common/errors.js'
import { Public } from '../auth/auth-mode.guard.js'
import { CurrentUser } from '../auth/current-user.js'
import type { SessionPrincipal } from '../auth/session.service.js'
import { MembershipService } from '../tenancy/membership.service.js'

@ApiTags('media')
@Controller('media')
export class MediaController {
  constructor(private readonly memberships: MembershipService) {}

  @Get()
  @ApiOperation({ summary: 'Media in a workspace' })
  async list(
    @Query('workspaceId') workspaceId: string,
    @CurrentUser() principal: SessionPrincipal | undefined
  ) {
    if (!principal) throw errors.unauthenticated()
    if (!workspaceId) throw errors.validation('workspaceId is required.', 'workspaceId')
    await this.memberships.requireAccess(principal.userId, workspaceId)

    return withTenant(workspaceId, async (tx) =>
      tx.mediaAsset.findMany({
        select: {
          id: true,
          filename: true,
          mime: true,
          bytes: true,
          width: true,
          height: true,
          altText: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'desc' },
        take: 200,
      })
    )
  }

  /**
   * Uploads a file.
   *
   * The whole body is buffered rather than streamed to storage, because the type
   * cannot be determined without reading the magic bytes, and streaming an
   * unidentified file into a bucket means deciding what it is after it is
   * already stored.
   */
  @Post()
  @ApiOperation({ summary: 'Upload a file' })
  async upload(
    @Query('workspaceId') workspaceId: string,
    @Req() request: FastifyRequest,
    @CurrentUser() principal: SessionPrincipal | undefined
  ) {
    if (!principal) throw errors.unauthenticated()
    if (!workspaceId) throw errors.validation('workspaceId is required.', 'workspaceId')

    const access = await this.memberships.requireAccess(principal.userId, workspaceId)
    const allowed = authorize({ userId: principal.userId, role: access.role }, 'content.create')
    if (!allowed.allowed) {
      throw errors.forbidden('Your role does not permit uploading media.', {
        required: 'content.create',
      })
    }

    const body = request.body
    if (!Buffer.isBuffer(body) || body.length === 0) {
      throw errors.validation('Send the file as the raw request body.')
    }

    const filename =
      (request.headers['x-filename'] as string | undefined)?.slice(0, 200) ?? 'upload'

    let verdict
    try {
      // Sniffed from the bytes. The Content-Type header and the filename are
      // both attacker-controlled and neither is consulted.
      verdict = checkUpload({
        bytes: body.length,
        buffer: body,
        declaredMime: request.headers['content-type'],
        filename,
      })
    } catch (err) {
      if (err instanceof UnsupportedUpload) throw errors.validation(err.message, 'file')
      throw err
    }

    // Uploaded BEFORE the row is written, and deliberately outside any
    // transaction — a file transfer inside one would pin a Postgres connection
    // for its whole duration.
    const key = storageKey(workspaceId, verdict.extension)
    await putObject(key, body, verdict.mime)

    return withTenant(workspaceId, async (tx) =>
      tx.mediaAsset.create({
         
        data: {
          uploadedById: principal.userId,
          storageKey: key,
          filename,
          mime: verdict.mime,
          bytes: body.length,
          width: verdict.width ?? null,
          height: verdict.height ?? null,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
        select: { id: true, filename: true, mime: true, bytes: true, width: true, height: true },
      })
    )
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a media asset' })
  async remove(
    @Param('id') id: string,
    @Query('workspaceId') workspaceId: string,
    @CurrentUser() principal: SessionPrincipal | undefined
  ) {
    if (!principal) throw errors.unauthenticated()
    if (!workspaceId) throw errors.validation('workspaceId is required.', 'workspaceId')
    await this.memberships.requireAccess(principal.userId, workspaceId)

    const asset = await withTenant(workspaceId, async (tx) => {
      const found = await tx.mediaAsset.findUnique({
        where: { id },
        select: { id: true, storageKey: true },
      })
      if (!found) throw errors.notFound('media')
      await tx.mediaAsset.update({ where: { id }, data: { deletedAt: new Date() } })
      return found
    })

    // Object removed after the row is marked deleted, and outside the
    // transaction. If this throws, the asset is already invisible and a cleanup
    // pass can reclaim the bytes — the reverse order would leave a visible row
    // pointing at nothing.
    await deleteObject(asset.storageKey).catch(() => undefined)
    return { deleted: true }
  }

  /**
   * Serves a media file to a platform that fetches rather than accepts uploads.
   *
   * UNAUTHENTICATED, because the fetcher on the other end is anonymous and has
   * no session to present. It takes an opaque HMAC token naming ONE asset — it
   * never accepts a URL, so there is no SSRF surface. See packages/storage/relay.
   */
  @Public()
  @Get('relay')
  @ApiOperation({ summary: 'Media by signed token, for platforms that fetch' })
  async relay(
    @Query('t') token: string,
    @Res({ passthrough: true }) reply: FastifyReply
  ): Promise<Buffer> {
    // The token rides in a QUERY parameter rather than a path segment. Fastify's
    // router would not match a long opaque token as the final path segment here,
    // and a 404 that looks like a missing asset is a poor way to discover a
    // routing quirk. A query parameter has no such ambiguity, and the URL is
    // handed to a machine rather than read by a person.
    if (!token) throw errors.notFound('media')

    let payload
    try {
      payload = verifyRelayToken(token)
    } catch (err) {
      if (err instanceof InvalidRelayToken) throw errors.notFound('media')
      throw err
    }

    // Scoped to the workspace named INSIDE the signed token. There is no
    // session here, but the signature makes that claim trustworthy — so the
    // read stays fully tenant-scoped rather than needing an RLS escape.
    const asset = await withTenant(payload.workspaceId, async (tx) =>
      tx.mediaAsset.findUnique({ where: { id: payload.id }, select: { storageKey: true } })
    )

    if (!asset) throw errors.notFound('media')

    const object = await getObject(asset.storageKey)
    void reply
      .header('content-type', object.contentType)
      .header('cache-control', 'private, max-age=1800')
    return object.body
  }
}
