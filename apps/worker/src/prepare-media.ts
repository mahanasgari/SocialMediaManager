import { mkdtemp, rm, writeFile, stat } from 'node:fs/promises'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withTenant } from '@smm/database'
import { getObject, putObject, storageKey } from '@smm/storage'
import { planTranscode, probe, transcode, TranscodeFailed, ProbeFailed } from '@smm/media'
import { registry } from '@smm/providers'

/**
 * Preparing media for one provider surface.
 *
 * Sits between "we have a file" and "the platform will accept it". Returns the
 * storage key to publish — the original when it already conforms, a cached
 * rendition when one exists, or a freshly transcoded one.
 *
 * The common case must be FREE. Most uploads already conform, and re-encoding a
 * conforming file wastes minutes of CPU, loses a generation of quality, and is
 * indistinguishable to the user from the tool being broken.
 */

export class MediaPreparationFailed extends Error {
  override readonly name = 'MediaPreparationFailed'
  constructor(readonly humanMessage: string) {
    super(humanMessage)
  }
}

export type PreparedMedia = {
  storageKey: string
  mime: string
  /** True when nothing needed doing — the original is being published as-is. */
  original: boolean
  reasons: string[]
}

/**
 * A concurrency gate.
 *
 * ffmpeg will happily use every core. Two concurrent transcodes on a small
 * self-hosted box starve the scheduler and the API — the publish tick stops
 * running because a video is being re-encoded, which looks to everyone like the
 * scheduler is broken.
 *
 * One at a time, process-wide. Transcoding is throughput work; latency on any
 * single job matters far less than the rest of the worker staying responsive.
 */
let queue: Promise<unknown> = Promise.resolve()

function serialise<T>(work: () => Promise<T>): Promise<T> {
  const result = queue.then(work, work)
  // Swallowed so one failure does not poison every job behind it in the chain.
  queue = result.catch(() => undefined)
  return result
}

export async function prepareMedia(
  workspaceId: string,
  organizationId: string,
  asset: { id: string; storageKey: string; mime: string },
  providerId: string,
  surface: string
): Promise<PreparedMedia> {
  // Images are passed through untouched. Every media profile in the roster
  // constrains images by dimensions and size, which are validated at upload —
  // none of them require re-encoding, and re-compressing someone's JPEG without
  // being asked is a change they did not consent to.
  if (!asset.mime.startsWith('video/')) {
    return { storageKey: asset.storageKey, mime: asset.mime, original: true, reasons: [] }
  }

  const provider = registry.get(providerId as never)
  const profile = provider?.media[surface as never]
  if (!provider || !profile) {
    return { storageKey: asset.storageKey, mime: asset.mime, original: true, reasons: [] }
  }

  // The cache is checked BEFORE the file is downloaded. A hit must cost one
  // indexed query, not a round trip to object storage.
  const cached = await withTenant(workspaceId, async (tx) =>
    tx.mediaRendition.findUnique({
      where: {
        mediaAssetId_providerId_surface: {
          mediaAssetId: asset.id,
          providerId,
          surface,
        },
      },
      select: { storageKey: true, mime: true, reasons: true },
    })
  )

  if (cached) {
    return {
      storageKey: cached.storageKey,
      mime: cached.mime,
      original: false,
      reasons: cached.reasons,
    }
  }

  return serialise(() => prepare(workspaceId, organizationId, asset, providerId, surface, profile))
}

async function prepare(
  workspaceId: string,
  organizationId: string,
  asset: { id: string; storageKey: string; mime: string },
  providerId: string,
  surface: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  profile: any
): Promise<PreparedMedia> {
  const dir = await mkdtemp(join(tmpdir(), 'smm-prepare-'))
  const inputPath = join(dir, 'input')

  try {
    const object = await getObject(asset.storageKey)
    await writeFile(inputPath, object.body)

    let probed
    try {
      probed = await probe(inputPath)
    } catch (error) {
      // A file we cannot read is one no platform will accept either. Failing
      // here with ffprobe's own reason beats letting the provider reject it
      // with something less specific.
      throw new MediaPreparationFailed(
        error instanceof ProbeFailed
          ? error.message
          : 'That video could not be read. Try uploading it again.'
      )
    }

    const plan = planTranscode({ probe: probed, profile, isVideo: true })

    // Already conforms. The common case, and it costs one probe.
    if (!plan) {
      return { storageKey: asset.storageKey, mime: asset.mime, original: true, reasons: [] }
    }

    const { outputPath, cleanup } = await transcode(inputPath, plan).catch((error: unknown) => {
      if (error instanceof TranscodeFailed) throw new MediaPreparationFailed(error.humanMessage)
      throw error
    })

    try {
      const body = await readFile(outputPath)
      const bytes = (await stat(outputPath)).size
      const mime = plan.extension === 'webm' ? 'video/webm' : 'video/mp4'
      const key = storageKey(workspaceId, plan.extension)

      await putObject(key, body, mime)

      await withTenant(workspaceId, async (tx) => {
        await tx.mediaRendition.create({
           
          data: {
            workspaceId,
            organizationId,
            mediaAssetId: asset.id,
            providerId,
            surface,
            storageKey: key,
            mime,
            bytes,
            reasons: plan.reasons,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } as any,
        })
      })

      return { storageKey: key, mime, original: false, reasons: plan.reasons }
    } finally {
      await cleanup()
    }
  } finally {
    // The input copy always goes, on every path. A transcoder that leaks a
    // temporary file per job fills the disk of the machine it runs on, which
    // then fails every job including the ones that would have worked.
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}
