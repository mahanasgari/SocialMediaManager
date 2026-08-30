import type { Surface } from './taxonomy.js'

/**
 * Media and text constraints, keyed by SURFACE.
 *
 * Zero dependencies — the composer imports these to validate while someone
 * types, and the worker validates again before publishing. One definition, both
 * sides. These profiles double as the transcoder's target specifications.
 */

export type AspectRange = { min: number; max: number }
export type Range = { min: number; max: number }

export type MediaProfile = {
  mime: readonly string[]
  maxBytes: number
  /** Max media items in one post on this surface. */
  maxCount: number
  aspect?: AspectRange
  /** Aspect that avoids cropping, where the platform crops rather than rejects. */
  recommendedAspect?: number
  dimensions?: { minWidth?: number; minHeight?: number; maxWidth?: number; maxHeight?: number }
  durationSec?: Range
  videoCodec?: readonly string[]
  audioCodec?: readonly string[]
  audioMaxHz?: number
  fps?: Range
  container?: {
    /**
     * Instagram requires the moov atom at the FRONT of the file. In ffmpeg that
     * is `-movflags +faststart`. Without it the upload is accepted and then
     * fails during processing, which is far harder to diagnose than a rejection.
     */
    moovAtomFront?: boolean
    closedGop?: boolean
    chroma?: string
  }
  altTextMaxLength?: number
}

export type TextProfile = {
  /**
   * Counted in GRAPHEMES, not UTF-16 code units. An emoji with a skin-tone
   * modifier is one character to a person and several to `String.length`, so
   * naive counting rejects posts that would have been accepted.
   */
  maxLength: number
  /**
   * A LOWER limit that applies when the post carries media.
   *
   * Not an exotic case: Telegram allows 4096 characters in a message but only
   * 1024 in a media caption, and a post with an image is the common case. The
   * distinction has to live in the profile, because a composer that shows 4096
   * and then fails at publish time has told the writer a comfortable lie — and
   * they find out after the draft is already written.
   */
  maxLengthWithMedia?: number
  /** Null means the platform imposes no separate cap. */
  maxHashtags: number | null
  maxMentions: number | null
  /**
   * How links are counted. Some platforms rewrite every URL to a fixed-length
   * shortlink, so a long URL costs the same as a short one.
   */
  linkHandling: 'counted' | 'shortened' | 'stripped'
  /** Length a shortened link occupies, when linkHandling is 'shortened'. */
  shortenedLinkLength?: number
  requiresTitle?: boolean
  titleMaxLength?: number
  /** Some surfaces cannot be posted without media at all. */
  mediaRequired?: boolean
}

export type MediaProfiles = Partial<Record<Surface, MediaProfile>>
export type TextProfiles = Partial<Record<Surface, TextProfile>>

export const MB = 1024 * 1024

/**
 * Grapheme-accurate length.
 *
 * `Intl.Segmenter` is available in every runtime this project targets. The
 * fallback exists only so a missing implementation degrades to something
 * conservative rather than throwing mid-keystroke.
 */
export function graphemeLength(text: string): number {
  if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    let count = 0
    for (const _ of segmenter.segment(text)) count++
    return count
  }
  return [...text].length
}

const URL_PATTERN = /https?:\/\/[^\s]+/g

/** Effective length under a profile's link rules. */
export function effectiveLength(text: string, profile: TextProfile): number {
  if (profile.linkHandling === 'counted') return graphemeLength(text)

  const urls = text.match(URL_PATTERN) ?? []
  if (urls.length === 0) return graphemeLength(text)

  const withoutUrls = text.replace(URL_PATTERN, '')
  const base = graphemeLength(withoutUrls)

  if (profile.linkHandling === 'stripped') return base
  return base + urls.length * (profile.shortenedLinkLength ?? 23)
}

export function countHashtags(text: string): number {
  return (text.match(/(^|\s)#[\p{L}\p{N}_]+/gu) ?? []).length
}

export function countMentions(text: string): number {
  return (text.match(/(^|\s)@[\p{L}\p{N}_.]+/gu) ?? []).length
}
