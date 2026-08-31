import { Publisher } from '@smm/publishing'
import type { VariantStatus } from '@smm/publishing'
import { prepareMedia } from './prepare-media.js'

/**
 * One publisher per worker process, so the Redis connection and the rate-limit
 * buckets are shared across every variant this worker handles rather than
 * reconnecting per job.
 *
 * The media preparer is supplied HERE rather than imported inside publishing,
 * because transcoding shells out to ffmpeg and the API imports the same package
 * for its status reducer. A web process should not carry a media toolchain.
 */
const publisher = new Publisher({ prepareMedia })

export function publishVariant(workspaceId: string, variantId: string): Promise<VariantStatus> {
  return publisher.publishVariant(workspaceId, variantId)
}

/** The live Publisher, for the recovery sweep. */
export function activePublisher(): Publisher {
  return publisher
}

export function closePublisher(): Promise<void> {
  return publisher.close()
}
