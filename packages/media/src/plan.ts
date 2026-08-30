import type { MediaProfile } from '@smm/providers/capabilities'
import type { MediaProbe } from './probe.js'

/**
 * Deciding what, if anything, needs re-encoding.
 *
 * PURE. It takes what the file is and what the surface requires, and returns
 * the ffmpeg arguments to get from one to the other — or nothing, if the file
 * already conforms.
 *
 * Keeping this pure is what makes transcoding testable at all: the alternative
 * is asserting on the contents of re-encoded video, which is slow, flaky, and
 * tests ffmpeg rather than our decisions.
 */

export type TranscodePlan = {
  /** Empty when the file already conforms and should be uploaded untouched. */
  args: string[]
  /** Human-readable, shown while the variant sits in PREPARING_MEDIA. */
  reasons: string[]
  /** The container extension the output will have. */
  extension: string
}

export type PlanInput = {
  probe: MediaProbe
  profile: MediaProfile
  /** Some surfaces are image-only; a plan for those never re-encodes video. */
  isVideo: boolean
}

/**
 * Returns null when nothing needs doing.
 *
 * "Already conforms" is the common case and must be free. Re-encoding a
 * conforming file wastes minutes of CPU, loses a generation of quality, and is
 * indistinguishable to the user from the tool being slow.
 */
export function planTranscode(input: PlanInput): TranscodePlan | null {
  const { probe, profile, isVideo } = input
  if (!isVideo || !probe.video) return null

  const reasons: string[] = []
  const filters: string[] = []
  const args: string[] = ['-y', '-i', '{input}']

  // --- video codec ---------------------------------------------------------
  const wantedVideo = normaliseCodecs(profile.videoCodec)
  const codecOk = wantedVideo.length === 0 || wantedVideo.includes(normalise(probe.video.codec))

  // --- pixel format --------------------------------------------------------
  // 4:2:0 is not cosmetic. A 4:2:2 or 10-bit file is rejected outright by
  // several platforms, and the rejection message rarely says why.
  const chromaWanted = profile.container?.chroma
  const chromaOk =
    !chromaWanted || (probe.video.pixelFormat ?? '').includes(chromaWanted.replace(/:/g, ''))

  // --- frame rate ----------------------------------------------------------
  const fps = probe.video.fps
  const fpsOk = !profile.fps || fps === null || (fps >= profile.fps.min && fps <= profile.fps.max)

  // --- audio ---------------------------------------------------------------
  const wantedAudio = normaliseCodecs(profile.audioCodec)
  const audioCodecOk =
    wantedAudio.length === 0 ||
    probe.audio === null ||
    wantedAudio.includes(normalise(probe.audio.codec))

  const audioRateOk =
    !profile.audioMaxHz ||
    probe.audio?.sampleRateHz === null ||
    probe.audio === null ||
    (probe.audio.sampleRateHz ?? 0) <= profile.audioMaxHz

  // --- faststart -----------------------------------------------------------
  const faststartWanted = profile.container?.moovAtomFront === true
  const faststartOk = !faststartWanted || probe.faststart

  if (codecOk && chromaOk && fpsOk && audioCodecOk && audioRateOk && faststartOk) {
    return null
  }

  // Video and audio are decided INDEPENDENTLY and composed at the end.
  //
  // An earlier version pushed `-c:v copy` and then spliced it back out when the
  // pixel format turned out to be wrong. That worked, and it was impossible to
  // read: the array by then also contained `-c:a copy`, so the splice was
  // hunting for a string that appeared twice and meant different things.
  //
  // A stream copy CANNOT change pixel format OR frame rate. ffmpeg does not
  // complain about either — it accepts "-r 60 -c:v copy" and silently ignores
  // the rate — so the output looks converted and is not.
  //
  // That was caught by running ffmpeg for real against a 120fps clip. No amount
  // of reasoning about the argument list would have shown it, because the
  // argument list is perfectly valid.
  //
  // These are the interactions between the decisions below, stated once, here.
  const mustReencodeVideo = !codecOk || !chromaOk || !fpsOk

  if (mustReencodeVideo) {
    args.push('-c:v', ffmpegVideoCodec(wantedVideo[0] ?? 'h264'))
    if (!codecOk) {
      reasons.push(`re-encoding video from ${probe.video.codec} to ${wantedVideo[0] ?? 'h264'}`)
    }
    if (!chromaOk) {
      filters.push('format=yuv420p')
      reasons.push(`converting to ${chromaWanted} chroma`)
    }
  } else {
    // Copy where possible. Re-encoding a stream that already conforms costs
    // minutes and a generation of quality for no gain.
    args.push('-c:v', 'copy')
  }

  if (!fpsOk && fps !== null && profile.fps) {
    const target = Math.min(Math.max(fps, profile.fps.min), profile.fps.max)
    args.push('-r', String(Math.round(target)))
    reasons.push(`changing frame rate from ${fps} to ${Math.round(target)} fps`)
  }

  if (probe.audio === null) {
    args.push('-an')
  } else if (!audioCodecOk || !audioRateOk) {
    args.push('-c:a', wantedAudio[0] ?? 'aac')
    if (!audioCodecOk) reasons.push(`re-encoding audio to ${wantedAudio[0] ?? 'aac'}`)
    if (!audioRateOk && profile.audioMaxHz) {
      args.push('-ar', String(profile.audioMaxHz))
      reasons.push(`resampling audio to ${profile.audioMaxHz} Hz`)
    }
  } else {
    args.push('-c:a', 'copy')
  }

  if (filters.length > 0) args.push('-vf', filters.join(','))

  if (faststartWanted) {
    // The whole reason this flag exists. Without it the upload is ACCEPTED and
    // then fails during the platform's own processing, which is far harder to
    // diagnose than an outright rejection.
    args.push('-movflags', '+faststart')
    if (!faststartOk) reasons.push('moving the index to the front of the file')
  }

  if (profile.container?.closedGop && mustReencodeVideo) {
    // Only meaningful when re-encoding — a copied stream keeps whatever GOP
    // structure it already had, and the flag would be a silent no-op.
    args.push('-flags', '+cgop')
  }

  args.push('{output}')

  return { args, reasons, extension: extensionFor(profile) }
}

/** Maps a codec name to the ffmpeg encoder that produces it. */
export function ffmpegVideoCodec(codec: string): string {
  switch (normalise(codec)) {
    case 'h264':
    case 'avc':
      return 'libx264'
    case 'h265':
    case 'hevc':
      return 'libx265'
    case 'vp9':
      return 'libvpx-vp9'
    default:
      // h264 is the only codec every platform in the roster accepts, so it is
      // the safe target for anything unrecognised.
      return 'libx264'
  }
}

function extensionFor(profile: MediaProfile): string {
  if (profile.mime.includes('video/mp4')) return 'mp4'
  if (profile.mime.includes('video/webm')) return 'webm'
  if (profile.mime.includes('video/quicktime')) return 'mov'
  return 'mp4'
}

function normalise(codec: string): string {
  const lower = codec.toLowerCase()
  if (lower === 'avc1' || lower === 'avc') return 'h264'
  if (lower === 'hev1' || lower === 'hvc1') return 'hevc'
  return lower
}

function normaliseCodecs(codecs: readonly string[] | undefined): string[] {
  return (codecs ?? []).map(normalise)
}

/**
 * The cache key for a rendition.
 *
 * Keyed on the ASSET and the PROFILE, not on the post. The same video going to
 * Instagram Reels from four different posts is one transcode, and a key that
 * included the post would redo it every time — which for a two-minute encode is
 * the difference between a usable tool and an unusable one.
 */
export function renditionKey(assetId: string, providerId: string, surface: string): string {
  return `${assetId}:${providerId}:${surface}`
}
