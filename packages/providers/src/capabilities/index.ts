/**
 * Browser-importable subpath. ZERO dependencies, enforced by ESLint.
 *
 * apps/web may import this and nothing else from @smm/providers: the adapter
 * modules load provider credentials and must never be bundled for a browser.
 */
export {
  CAPABILITY_KEYS,
  SURFACES,
  type CapabilityKey,
  type ProviderCapabilities,
  type Surface,
  type ProviderId,
  type ProviderState,
} from './taxonomy.js'

export {
  MB,
  graphemeLength,
  effectiveLength,
  countHashtags,
  countMentions,
  type MediaProfile,
  type TextProfile,
  type MediaProfiles,
  type TextProfiles,
  type AspectRange,
  type Range,
} from './profiles.js'

export {
  validateText,
  validateMedia,
  hasErrors,
  type ValidationIssue,
  type Severity,
  type MediaInput,
  type VariantDraft,
} from './validate.js'
