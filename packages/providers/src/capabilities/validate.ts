import type { Surface } from './taxonomy.js'
import {
  countHashtags,
  countMentions,
  effectiveLength,
  type MediaProfile,
  type TextProfile,
} from './profiles.js'

/**
 * Pure validation, shared verbatim between the composer and the worker.
 *
 * No I/O, no imports outside this subpath. The composer warns while someone
 * types; the worker refuses to publish an invalid payload. Duplicating these
 * rules across client and server is the bug factory every tool like this has.
 *
 * Validation happens at COMPOSE time, not publish time. Telling someone at 09:00
 * that their scheduled post failed on an aspect ratio is a bad product.
 */

export type Severity = 'error' | 'warning'

export type ValidationIssue = {
  code: string
  severity: Severity
  /** Written for a person. Never a status code, never a bare rule name. */
  message: string
  field?: string
  surface?: Surface
}

export type MediaInput = {
  mime: string
  bytes: number
  width?: number
  height?: number
  durationSec?: number
  videoCodec?: string
  audioCodec?: string
  fps?: number
  altText?: string
}

export type VariantDraft = {
  surface: Surface
  text: string
  media: readonly MediaInput[]
  title?: string
}

export function validateText(
  draft: Pick<VariantDraft, 'text' | 'title' | 'media' | 'surface'>,
  profile: TextProfile | undefined,
  providerLabel: string
): ValidationIssue[] {
  if (!profile) return []
  const issues: ValidationIssue[] = []

  const length = effectiveLength(draft.text, profile)

  // The applicable limit depends on whether media is attached, because several
  // platforms cap a caption far below a plain message.
  const hasMedia = draft.media.length > 0
  const limit =
    hasMedia && profile.maxLengthWithMedia !== undefined
      ? profile.maxLengthWithMedia
      : profile.maxLength

  if (length > limit) {
    const over = length - limit
    issues.push({
      code: 'text_too_long',
      severity: 'error',
      // Says how far over, not merely that it is over — the difference between
      // a useful warning and one you have to measure yourself. When the media
      // caption limit is the binding one, it says so, because otherwise the
      // number looks simply wrong to someone who knows the platform's headline
      // figure.
      message: hasMedia && profile.maxLengthWithMedia !== undefined
        ? `${over} character${over === 1 ? '' : 's'} too long for a ${providerLabel} post with media (limit ${limit}, versus ${profile.maxLength} without).`
        : `${over} character${over === 1 ? '' : 's'} too long for ${providerLabel} (limit ${limit}).`,
      field: 'text',
      surface: draft.surface,
    })
  }

  if (profile.maxHashtags !== null) {
    const hashtags = countHashtags(draft.text)
    if (hashtags > profile.maxHashtags) {
      issues.push({
        code: 'too_many_hashtags',
        severity: 'error',
        message: `${providerLabel} allows at most ${profile.maxHashtags} hashtags; this has ${hashtags}.`,
        field: 'text',
        surface: draft.surface,
      })
    }
  }

  if (profile.maxMentions !== null) {
    const mentions = countMentions(draft.text)
    if (mentions > profile.maxMentions) {
      issues.push({
        code: 'too_many_mentions',
        severity: 'error',
        message: `${providerLabel} allows at most ${profile.maxMentions} mentions; this has ${mentions}.`,
        field: 'text',
        surface: draft.surface,
      })
    }
  }

  if (profile.requiresTitle && !draft.title?.trim()) {
    issues.push({
      code: 'title_required',
      severity: 'error',
      message: `${providerLabel} requires a title.`,
      field: 'title',
      surface: draft.surface,
    })
  }

  if (profile.titleMaxLength && draft.title && draft.title.length > profile.titleMaxLength) {
    issues.push({
      code: 'title_too_long',
      severity: 'error',
      message: `Title is longer than ${providerLabel} allows (${profile.titleMaxLength} characters).`,
      field: 'title',
      surface: draft.surface,
    })
  }

  if (profile.mediaRequired && draft.media.length === 0) {
    issues.push({
      code: 'media_required',
      severity: 'error',
      message: `${providerLabel} cannot post to this surface without media.`,
      field: 'media',
      surface: draft.surface,
    })
  }

  return issues
}

export function validateMedia(
  draft: Pick<VariantDraft, 'media' | 'surface'>,
  profile: MediaProfile | undefined,
  providerLabel: string
): ValidationIssue[] {
  if (!profile) return []
  const issues: ValidationIssue[] = []

  if (draft.media.length > profile.maxCount) {
    issues.push({
      code: 'too_many_media',
      severity: 'error',
      message: `${providerLabel} accepts at most ${profile.maxCount} file${profile.maxCount === 1 ? '' : 's'} here; this has ${draft.media.length}.`,
      field: 'media',
      surface: draft.surface,
    })
  }

  draft.media.forEach((item, index) => {
    const field = `media[${index}]`

    if (!profile.mime.includes(item.mime)) {
      issues.push({
        code: 'unsupported_format',
        severity: 'error',
        // Naming the accepted formats turns "rejected" into "convert to this".
        message: `${providerLabel} does not accept ${item.mime} here. Accepted: ${profile.mime.join(', ')}.`,
        field,
        surface: draft.surface,
      })
    }

    if (item.bytes > profile.maxBytes) {
      const limitMb = Math.round(profile.maxBytes / (1024 * 1024))
      issues.push({
        code: 'file_too_large',
        severity: 'error',
        message: `File is larger than ${providerLabel} allows (${limitMb} MB).`,
        field,
        surface: draft.surface,
      })
    }

    if (profile.aspect && item.width && item.height) {
      const ratio = item.width / item.height
      if (ratio < profile.aspect.min || ratio > profile.aspect.max) {
        issues.push({
          code: 'aspect_out_of_range',
          severity: 'error',
          message:
            `${providerLabel} needs an aspect ratio between ${fmt(profile.aspect.min)} and ` +
            `${fmt(profile.aspect.max)}; this is ${fmt(ratio)}.`,
          field,
          surface: draft.surface,
        })
      } else if (
        profile.recommendedAspect &&
        Math.abs(ratio - profile.recommendedAspect) > 0.05
      ) {
        // A warning, not an error: the platform accepts it but will crop. The
        // person should know before scheduling, not discover it afterwards.
        issues.push({
          code: 'aspect_will_crop',
          severity: 'warning',
          message: `${providerLabel} may crop this. ${fmt(profile.recommendedAspect)} avoids it.`,
          field,
          surface: draft.surface,
        })
      }
    }

    if (profile.durationSec && item.durationSec !== undefined) {
      if (item.durationSec < profile.durationSec.min || item.durationSec > profile.durationSec.max) {
        issues.push({
          code: 'duration_out_of_range',
          severity: 'error',
          message:
            `${providerLabel} needs ${profile.durationSec.min}–${profile.durationSec.max} seconds; ` +
            `this is ${Math.round(item.durationSec)}.`,
          field,
          surface: draft.surface,
        })
      }
    }

    if (profile.videoCodec && item.videoCodec && !profile.videoCodec.includes(item.videoCodec)) {
      issues.push({
        code: 'unsupported_video_codec',
        severity: 'error',
        message: `${providerLabel} requires ${profile.videoCodec.join(' or ')} video; this is ${item.videoCodec}.`,
        field,
        surface: draft.surface,
      })
    }

    if (profile.audioCodec && item.audioCodec && !profile.audioCodec.includes(item.audioCodec)) {
      issues.push({
        code: 'unsupported_audio_codec',
        severity: 'error',
        message: `${providerLabel} requires ${profile.audioCodec.join(' or ')} audio; this is ${item.audioCodec}.`,
        field,
        surface: draft.surface,
      })
    }

    if (profile.fps && item.fps !== undefined && (item.fps < profile.fps.min || item.fps > profile.fps.max)) {
      issues.push({
        code: 'fps_out_of_range',
        severity: 'error',
        message: `${providerLabel} needs ${profile.fps.min}–${profile.fps.max} fps; this is ${Math.round(item.fps)}.`,
        field,
        surface: draft.surface,
      })
    }

    if (
      profile.altTextMaxLength &&
      item.altText &&
      item.altText.length > profile.altTextMaxLength
    ) {
      issues.push({
        code: 'alt_text_too_long',
        severity: 'error',
        message: `Alt text is longer than ${providerLabel} allows (${profile.altTextMaxLength} characters).`,
        field,
        surface: draft.surface,
      })
    }
  })

  return issues
}

export function hasErrors(issues: readonly ValidationIssue[]): boolean {
  return issues.some((i) => i.severity === 'error')
}

function fmt(ratio: number): string {
  return `${ratio.toFixed(2).replace(/\.?0+$/, '')}:1`
}
