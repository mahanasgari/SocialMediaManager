import { describe, expect, it } from 'vitest'
import { countHashtags, countMentions, effectiveLength, graphemeLength, MB } from './profiles.js'
import { hasErrors, validateMedia, validateText } from './validate.js'
import type { MediaProfile, TextProfile } from './profiles.js'

const text = (over: Partial<TextProfile> = {}): TextProfile => ({
  maxLength: 300,
  maxHashtags: null,
  maxMentions: null,
  linkHandling: 'counted',
  ...over,
})

const media = (over: Partial<MediaProfile> = {}): MediaProfile => ({
  mime: ['image/jpeg'],
  maxBytes: 8 * MB,
  maxCount: 4,
  ...over,
})

const draft = (over: Partial<Parameters<typeof validateText>[0]> = {}) => ({
  surface: 'feed' as const,
  text: '',
  media: [],
  ...over,
})

describe('grapheme counting', () => {
  it('counts a plain string by characters', () => {
    expect(graphemeLength('hello')).toBe(5)
  })

  it('counts an emoji with a skin-tone modifier as ONE character', () => {
    // This is why length is not String.length. To a person this is one
    // character; to UTF-16 it is four code units. Naive counting rejects posts
    // the platform would have accepted, which looks like a bug in our product.
    expect('👍🏽'.length).toBeGreaterThan(1)
    expect(graphemeLength('👍🏽')).toBe(1)
  })

  it('counts a family emoji as one', () => {
    expect(graphemeLength('👩‍👩‍👧‍👦')).toBe(1)
  })

  it('counts combining marks as part of their base character', () => {
    expect(graphemeLength('é')).toBe(1) // e + combining acute
  })
})

describe('link handling', () => {
  const url = 'https://example.com/a/very/long/path/that/goes/on'

  it('counts links in full when the platform does not rewrite them', () => {
    const profile = text({ linkHandling: 'counted' })
    expect(effectiveLength(`See ${url}`, profile)).toBe(graphemeLength(`See ${url}`))
  })

  it('charges a fixed cost when the platform shortens links', () => {
    // A long URL costs the same as a short one, so a post that looks over the
    // limit may be perfectly fine — refusing it would be our bug, not theirs.
    const profile = text({ linkHandling: 'shortened', shortenedLinkLength: 23 })
    expect(effectiveLength(`See ${url}`, profile)).toBe(graphemeLength('See ') + 23)
  })

  it('ignores links entirely when the platform strips them', () => {
    const profile = text({ linkHandling: 'stripped' })
    expect(effectiveLength(`See ${url}`, profile)).toBe(graphemeLength('See '))
  })

  it('charges per link, not per post', () => {
    const profile = text({ linkHandling: 'shortened', shortenedLinkLength: 23 })
    const two = effectiveLength(`${url} and ${url}`, profile)
    expect(two).toBe(graphemeLength(' and ') + 46)
  })
})

describe('hashtag and mention counting', () => {
  it('counts hashtags at the start and after whitespace', () => {
    expect(countHashtags('#one and #two')).toBe(2)
  })

  it('does not count a fragment inside a URL as a hashtag', () => {
    expect(countHashtags('https://example.com/page#section')).toBe(0)
  })

  it('counts unicode hashtags', () => {
    expect(countHashtags('#café #日本語')).toBe(2)
  })

  it('does not count an email address as a mention', () => {
    expect(countMentions('write to ada@example.com')).toBe(0)
  })
})

describe('text validation', () => {
  it('says HOW FAR over the limit, not merely that it is over', () => {
    const issues = validateText(draft({ text: 'x'.repeat(305) }), text(), 'Bluesky')
    expect(issues).toHaveLength(1)
    // "5 characters too long" is actionable; "too long" makes you measure.
    expect(issues[0]?.message).toContain('5 characters too long')
    expect(issues[0]?.message).toContain('Bluesky')
  })

  it('gets the singular right for one character over', () => {
    const issues = validateText(draft({ text: 'x'.repeat(301) }), text(), 'Bluesky')
    expect(issues[0]?.message).toContain('1 character too long')
  })

  it('accepts text exactly at the limit', () => {
    expect(validateText(draft({ text: 'x'.repeat(300) }), text(), 'Bluesky')).toEqual([])
  })

  it('enforces hashtag caps where the platform has one', () => {
    const tags = Array.from({ length: 31 }, (_, i) => `#t${i}`).join(' ')
    const issues = validateText(draft({ text: tags }), text({ maxLength: 5000, maxHashtags: 30 }), 'Instagram')
    expect(issues.some((i) => i.code === 'too_many_hashtags')).toBe(true)
  })

  it('ignores hashtag counts where the platform has no cap', () => {
    const tags = Array.from({ length: 60 }, (_, i) => `#t${i}`).join(' ')
    const issues = validateText(draft({ text: tags }), text({ maxLength: 5000 }), 'Mastodon')
    expect(issues).toEqual([])
  })

  it('requires a title where the surface demands one', () => {
    const issues = validateText(
      draft({ surface: 'short', text: 'body' }),
      text({ requiresTitle: true }),
      'YouTube'
    )
    expect(issues.some((i) => i.code === 'title_required' && i.field === 'title')).toBe(true)
  })

  it('reports a surface that cannot be posted without media', () => {
    const issues = validateText(
      draft({ surface: 'reel', text: 'caption' }),
      text({ mediaRequired: true }),
      'Instagram'
    )
    expect(issues[0]?.code).toBe('media_required')
  })

  it('returns nothing when the surface has no profile', () => {
    expect(validateText(draft({ text: 'anything' }), undefined, 'X')).toEqual([])
  })
})

describe('media validation', () => {
  it('names the accepted formats rather than only rejecting', () => {
    const issues = validateMedia(
      draft({ media: [{ mime: 'image/png', bytes: 1000 }] }),
      media(),
      'Instagram'
    )
    // Turns "rejected" into "convert to this", which is the difference between
    // a dead end and a next step.
    expect(issues[0]?.message).toContain('image/jpeg')
    expect(issues[0]?.field).toBe('media[0]')
  })

  it('reports aspect ratio with the actual value', () => {
    const issues = validateMedia(
      draft({ media: [{ mime: 'image/jpeg', bytes: 1000, width: 3000, height: 1000 }] }),
      media({ aspect: { min: 0.8, max: 1.91 } }),
      'Instagram'
    )
    const issue = issues.find((i) => i.code === 'aspect_out_of_range')
    expect(issue?.message).toContain('3:1')
    expect(issue?.severity).toBe('error')
  })

  it('warns rather than errors when the platform crops instead of rejecting', () => {
    // Reels accept almost any ratio but crop to 9:16. Blocking would be wrong;
    // saying nothing until it looks wrong on the phone is also wrong.
    const issues = validateMedia(
      draft({ media: [{ mime: 'video/mp4', bytes: 1000, width: 1000, height: 1000 }] }),
      media({
        mime: ['video/mp4'],
        aspect: { min: 0.01, max: 10 },
        recommendedAspect: 9 / 16,
      }),
      'Instagram'
    )
    const issue = issues.find((i) => i.code === 'aspect_will_crop')
    expect(issue?.severity).toBe('warning')
    expect(hasErrors(issues)).toBe(false)
  })

  it('enforces codec requirements', () => {
    const issues = validateMedia(
      draft({ media: [{ mime: 'video/mp4', bytes: 1000, videoCodec: 'vp9', audioCodec: 'opus' }] }),
      media({ mime: ['video/mp4'], videoCodec: ['h264', 'hevc'], audioCodec: ['aac'] }),
      'Instagram'
    )
    expect(issues.map((i) => i.code)).toEqual(
      expect.arrayContaining(['unsupported_video_codec', 'unsupported_audio_codec'])
    )
  })

  it('enforces duration bounds with the actual duration', () => {
    const issues = validateMedia(
      draft({ media: [{ mime: 'video/mp4', bytes: 1000, durationSec: 1200 }] }),
      media({ mime: ['video/mp4'], durationSec: { min: 3, max: 900 } }),
      'Instagram'
    )
    expect(issues[0]?.message).toContain('3–900 seconds')
    expect(issues[0]?.message).toContain('1200')
  })

  it('reports the file size limit in MB, not bytes', () => {
    const issues = validateMedia(
      draft({ media: [{ mime: 'image/jpeg', bytes: 20 * MB }] }),
      media(),
      'Instagram'
    )
    expect(issues[0]?.message).toContain('8 MB')
  })

  it('flags every offending file, not just the first', () => {
    const issues = validateMedia(
      draft({
        media: [
          { mime: 'image/gif', bytes: 100 },
          { mime: 'image/jpeg', bytes: 100 },
          { mime: 'image/webp', bytes: 100 },
        ],
      }),
      media(),
      'Instagram'
    )
    expect(issues.map((i) => i.field)).toEqual(['media[0]', 'media[2]'])
  })

  it('reports too many files', () => {
    const issues = validateMedia(
      draft({ media: Array.from({ length: 5 }, () => ({ mime: 'image/jpeg', bytes: 100 })) }),
      media({ maxCount: 4 }),
      'Instagram'
    )
    expect(issues.some((i) => i.code === 'too_many_media')).toBe(true)
  })
})

describe('hasErrors', () => {
  it('ignores warnings', () => {
    expect(hasErrors([{ code: 'x', severity: 'warning', message: 'm' }])).toBe(false)
    expect(hasErrors([{ code: 'x', severity: 'error', message: 'm' }])).toBe(true)
  })
})
