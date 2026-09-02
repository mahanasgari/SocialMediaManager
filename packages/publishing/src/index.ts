export {
  derivePostStatus,
  describeStatus,
  shouldDerive,
  VARIANT_STATUSES,
  POST_STATUSES,
  EDITORIAL_STATUSES,
  TERMINAL_VARIANT,
} from './status.js'
export type { VariantStatus, PostStatus } from './status.js'

export {
  idempotencyKey,
  fingerprintFor,
  findMatch,
  similarity,
  normaliseForMatch,
  serialiseFingerprint,
  parseFingerprint,
} from './fingerprint.js'
export type { Fingerprint, RemoteCandidate, MatchOptions } from './fingerprint.js'

export { Publisher } from './pipeline.js'
export { loadConnectorSettings } from './connector-settings.js'
export type { LoadResult } from './connector-settings.js'
