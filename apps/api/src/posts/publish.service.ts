import { Injectable } from '@nestjs/common'
import { Publisher } from '@smm/publishing'
import type { VariantStatus } from '@smm/publishing'

/**
 * Nest wrapper around the shared publisher.
 *
 * The pipeline itself lives in @smm/publishing so the worker can use it without
 * depending on the API framework. Two copies would be two implementations of the
 * rule that decides whether a post gets duplicated.
 */
@Injectable()
export class PublishService {
  private readonly publisher = new Publisher()

  publishVariant(workspaceId: string, variantId: string): Promise<VariantStatus> {
    return this.publisher.publishVariant(workspaceId, variantId)
  }

  close(): Promise<void> {
    return this.publisher.close()
  }
}
