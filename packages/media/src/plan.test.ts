import { describe, expect, it } from 'vitest'
import { ffmpegVideoCodec, planTranscode, renditionKey } from './plan.js'
import { parseFrameRate } from './probe.js'
import type { MediaProbe } from './probe.js'
import type { MediaProfile } from '@smm/providers/capabilities'

/** A conforming Instagram Reel: h264, yuv420p, 30fps, aac 44.1k, faststart. */
const conforming: MediaProbe = {
  container: 'mov,mp4,m4a,3gp',
  durationSec: 30,
  bytes: 5_000_000,
  video: { codec: 'h264', width: 1080, height: 1920, fps: 30, pixelFormat: 'yuv420p' },
  audio: { codec: 'aac', sampleRateHz: 44_100, channels: 2 },
  faststart: true,
}

const reelProfile: MediaProfile = {
  mime: ['video/mp4', 'video/quicktime'],
  maxCount: 1,
  maxBytes: 1024 * 1024 * 1024,
  videoCodec: ['h264', 'hevc'],
  audioCodec: ['aac'],
  audioMaxHz: 48_000,
  fps: { min: 23, max: 60 },
  container: { moovAtomFront: true, closedGop: true, chroma: '4:2:0' },
}

const plan = (probe: MediaProbe, profile = reelProfile) =>
  planTranscode({ probe, profile, isVideo: true })

/**
 * A profile with no container requirements.
 *
 * The key is OMITTED rather than set to undefined: under
 * exactOptionalPropertyTypes those are different types, and "absent" is what
 * a provider that has no such requirement actually looks like.
 */
function withoutContainer(profile: MediaProfile, overrides: Partial<MediaProfile> = {}) {
  const { container: _container, ...rest } = profile
  return { ...rest, ...overrides } as MediaProfile
}

describe('doing nothing', () => {
  it('returns null when the file already conforms', () => {
    // "Already conforms" is the common case and must be free. Re-encoding a
    // conforming file wastes minutes of CPU, loses a generation of quality, and
    // is indistinguishable from the tool being slow.
    expect(plan(conforming)).toBeNull()
  })

  it('returns null for an image, whatever the video rules say', () => {
    expect(
      planTranscode({ probe: { ...conforming, video: null }, profile: reelProfile, isVideo: false })
    ).toBeNull()
  })

  it('accepts 29.97 fps against a 23–60 range', () => {
    // 30000/1001. A naive parse would read this as 30000 and reject a file every
    // platform accepts.
    expect(plan({ ...conforming, video: { ...conforming.video!, fps: 29.97 } })).toBeNull()
  })

  it('accepts a codec alias, so avc1 is not re-encoded to h264', () => {
    expect(plan({ ...conforming, video: { ...conforming.video!, codec: 'avc1' } })).toBeNull()
  })
})

describe('video codec', () => {
  it('re-encodes an unsupported codec', () => {
    const result = plan({ ...conforming, video: { ...conforming.video!, codec: 'vp9' } })
    expect(result?.args).toContain('libx264')
    expect(result?.reasons.join(' ')).toMatch(/vp9/)
  })

  it('COPIES a conforming video stream when only the audio is wrong', () => {
    // The distinction that decides whether a publish takes two seconds or two
    // minutes.
    const result = plan({ ...conforming, audio: { codec: 'mp3', sampleRateHz: 44_100, channels: 2 } })
    expect(result?.args).toContain('copy')
    expect(result?.args).toContain('aac')
  })

  it('maps codec names to the encoders that produce them', () => {
    expect(ffmpegVideoCodec('h264')).toBe('libx264')
    expect(ffmpegVideoCodec('hevc')).toBe('libx265')
    expect(ffmpegVideoCodec('vp9')).toBe('libvpx-vp9')
  })

  it('falls back to h264 for anything unrecognised', () => {
    // The only codec every platform in the roster accepts.
    expect(ffmpegVideoCodec('some-new-codec')).toBe('libx264')
  })
})

describe('pixel format', () => {
  it('converts 4:2:2 to 4:2:0', () => {
    // Not cosmetic: several platforms reject non-4:2:0 outright, and rarely say
    // why.
    const result = plan({
      ...conforming,
      video: { ...conforming.video!, pixelFormat: 'yuv422p' },
    })
    expect(result?.args.join(' ')).toContain('format=yuv420p')
  })

  it('cannot stream-copy a pixel format change, so the VIDEO is re-encoded', () => {
    // A copy physically cannot change pixel format. Emitting `-c:v copy` with a
    // format filter would produce a file that is still 4:2:2.
    const result = plan({
      ...conforming,
      video: { ...conforming.video!, pixelFormat: 'yuv422p' },
    })
    const videoCodec = result!.args[result!.args.indexOf('-c:v') + 1]
    expect(videoCodec).toBe('libx264')

    // The audio is untouched and still copied — that is correct, and is why
    // asserting on a bare 'copy' anywhere in the argument list would be wrong.
    expect(result!.args[result!.args.indexOf('-c:a') + 1]).toBe('copy')
  })
})

describe('frame rate', () => {
  it('caps a rate above the maximum', () => {
    const result = plan({ ...conforming, video: { ...conforming.video!, fps: 120 } })
    expect(result?.args).toContain('-r')
    expect(result?.args[result.args.indexOf('-r') + 1]).toBe('60')
  })

  it('raises a rate below the minimum', () => {
    const result = plan({ ...conforming, video: { ...conforming.video!, fps: 12 } })
    expect(result?.args[result!.args.indexOf('-r') + 1]).toBe('23')
  })

  it('leaves an unknown frame rate alone rather than guessing', () => {
    expect(plan({ ...conforming, video: { ...conforming.video!, fps: null } })).toBeNull()
  })
})

describe('audio', () => {
  it('resamples above the platform ceiling', () => {
    const result = plan({
      ...conforming,
      audio: { codec: 'aac', sampleRateHz: 96_000, channels: 2 },
    })
    expect(result?.args).toContain('-ar')
    expect(result?.args).toContain('48000')
  })

  it('drops audio handling entirely for a silent video', () => {
    const result = plan({ ...conforming, audio: null, faststart: false })
    expect(result?.args).toContain('-an')
  })
})

describe('faststart', () => {
  it('moves the index to the front when the platform requires it', () => {
    // Without this the upload is ACCEPTED and then fails during the platform's
    // own processing — far harder to diagnose than an outright rejection.
    const result = plan({ ...conforming, faststart: false })
    expect(result?.args).toContain('-movflags')
    expect(result?.args).toContain('+faststart')
    expect(result?.reasons.join(' ')).toMatch(/front of the file/)
  })

  it('still sets the flag when re-encoding for another reason', () => {
    // The output is a new file; the flag has to be applied or it comes out
    // without a front-loaded index regardless of what the input had.
    const result = plan({ ...conforming, video: { ...conforming.video!, codec: 'vp9' } })
    expect(result?.args).toContain('+faststart')
  })

  it('does not set it for a platform that does not care', () => {
    const noContainer = withoutContainer(reelProfile)
    const result = planTranscode({
      probe: { ...conforming, video: { ...conforming.video!, codec: 'vp9' } },
      profile: noContainer,
      isVideo: true,
    })
    expect(result?.args).not.toContain('+faststart')
  })
})

describe('output container', () => {
  it('produces mp4 for an mp4 profile', () => {
    expect(plan({ ...conforming, faststart: false })?.extension).toBe('mp4')
  })

  it('produces webm for a webm-only profile', () => {
    const webm = withoutContainer(reelProfile, { mime: ['video/webm'] })
    const result = planTranscode({
      probe: { ...conforming, video: { ...conforming.video!, codec: 'vp8' } },
      profile: webm,
      isVideo: true,
    })
    expect(result?.extension).toBe('webm')
  })
})

describe('frame rate parsing', () => {
  it('reads a rational', () => {
    expect(parseFrameRate('30000/1001')).toBe(29.97)
    expect(parseFrameRate('30/1')).toBe(30)
  })

  it('handles a bare number', () => {
    expect(parseFrameRate('25')).toBe(25)
  })

  it('returns null rather than Infinity for a zero denominator', () => {
    // ffprobe reports 0/0 for streams with no meaningful rate. Dividing would
    // give NaN and every comparison against it would silently be false.
    expect(parseFrameRate('0/0')).toBe(0)
    expect(parseFrameRate(undefined)).toBeNull()
    expect(parseFrameRate('nonsense')).toBeNull()
  })
})

describe('rendition cache key', () => {
  it('keys on asset and surface, not on the post', () => {
    // The same video going to Reels from four posts is ONE transcode. A key
    // including the post would redo it every time, which for a two-minute
    // encode is the difference between a usable tool and an unusable one.
    expect(renditionKey('asset-1', 'instagram', 'reel')).toBe('asset-1:instagram:reel')
  })

  it('distinguishes surfaces on the same provider', () => {
    // Instagram feed images and Reels have incompatible rules; sharing a key
    // would serve a feed rendition to a Reel.
    expect(renditionKey('a', 'instagram', 'reel')).not.toBe(
      renditionKey('a', 'instagram', 'feedImage')
    )
  })
})

describe('what a stream copy cannot do', () => {
  // Both of these were found by running ffmpeg for real. ffmpeg accepts the
  // arguments and silently ignores them, so the output looks converted and is
  // not — a failure no argument-level assertion would ever have shown.
  it('re-encodes for a frame rate change, never copies', () => {
    const result = plan({ ...conforming, video: { ...conforming.video!, fps: 120 } })
    expect(result!.args[result!.args.indexOf('-c:v') + 1]).toBe('libx264')
  })

  it('re-encodes for a pixel format change, never copies', () => {
    const result = plan({
      ...conforming,
      video: { ...conforming.video!, pixelFormat: 'yuv422p' },
    })
    expect(result!.args[result!.args.indexOf('-c:v') + 1]).toBe('libx264')
  })

  it('still copies when only the audio or the container needs changing', () => {
    // The distinction that decides whether a publish takes two seconds or two
    // minutes, so it must not be lost to over-caution.
    const audioOnly = plan({
      ...conforming,
      audio: { codec: 'mp3', sampleRateHz: 44_100, channels: 2 },
    })
    expect(audioOnly!.args[audioOnly!.args.indexOf('-c:v') + 1]).toBe('copy')

    const faststartOnly = plan({ ...conforming, faststart: false })
    expect(faststartOnly!.args[faststartOnly!.args.indexOf('-c:v') + 1]).toBe('copy')
  })
})
