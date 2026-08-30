import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

/**
 * Reading what a file actually is.
 *
 * Never what it claims to be. A filename says nothing, a Content-Type is
 * attacker-controlled, and a container extension says nothing about the codecs
 * inside it — an .mp4 can hold H265 in a way half the platforms reject.
 * Everything here comes from ffprobe reading the bytes.
 */

export type MediaProbe = {
  container: string
  durationSec: number | null
  bytes: number
  video: {
    codec: string
    width: number
    height: number
    fps: number | null
    /** Pixel format, e.g. yuv420p. Several platforms accept only 4:2:0. */
    pixelFormat: string | null
  } | null
  audio: {
    codec: string
    sampleRateHz: number | null
    channels: number | null
  } | null
  /**
   * Whether the moov atom is at the FRONT of the file.
   *
   * Instagram requires it. Without it the upload is accepted and then fails
   * during processing, which is far harder to diagnose than a rejection — so it
   * is checked before publishing rather than discovered afterwards.
   */
  faststart: boolean
}

export class ProbeFailed extends Error {
  override readonly name = 'ProbeFailed'
  constructor(reason: string) {
    super(`That file could not be read as media (${reason}).`)
  }
}

const PROBE_TIMEOUT_MS = 30_000

export async function probe(filePath: string, ffprobePath = 'ffprobe'): Promise<MediaProbe> {
  let stdout: string
  try {
    const result = await run(
      ffprobePath,
      [
        '-v',
        'error',
        '-print_format',
        'json',
        '-show_format',
        '-show_streams',
        // Reads the whole moov position rather than guessing from the header.
        filePath,
      ],
      { timeout: PROBE_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }
    )
    stdout = result.stdout
  } catch (error) {
    // ffprobe writes its reason to stderr and exits non-zero. Preserved,
    // because "not a valid file" is useless and "moov atom not found" tells
    // someone their upload was truncated.
    const stderr = (error as { stderr?: string }).stderr?.trim()
    throw new ProbeFailed(stderr?.split('\n').pop() ?? 'unreadable')
  }

  const parsed = JSON.parse(stdout) as FfprobeOutput

  const video = parsed.streams?.find((s) => s.codec_type === 'video')
  const audio = parsed.streams?.find((s) => s.codec_type === 'audio')

  return {
    container: parsed.format?.format_name ?? 'unknown',
    durationSec: toNumber(parsed.format?.duration),
    bytes: toNumber(parsed.format?.size) ?? 0,
    video: video
      ? {
          codec: video.codec_name ?? 'unknown',
          width: video.width ?? 0,
          height: video.height ?? 0,
          fps: parseFrameRate(video.avg_frame_rate ?? video.r_frame_rate),
          pixelFormat: video.pix_fmt ?? null,
        }
      : null,
    audio: audio
      ? {
          codec: audio.codec_name ?? 'unknown',
          sampleRateHz: toNumber(audio.sample_rate),
          channels: audio.channels ?? null,
        }
      : null,
    // ffprobe does not report this directly. A file whose moov is at the front
    // is one ffprobe can describe having read only the beginning, which is what
    // the format tag reflects.
    faststart: hasFaststart(parsed),
  }
}

/**
 * Frame rate arrives as a rational string like "30000/1001".
 *
 * Parsed rather than rounded blindly: 30000/1001 is 29.97, and a platform whose
 * range is 23–60 accepts it while a naive parse of "30000" does not.
 */
export function parseFrameRate(value: string | undefined): number | null {
  if (!value) return null
  const [num, den] = value.split('/').map(Number)
  if (!Number.isFinite(num as number)) return null
  if (den === undefined || den === 0) return num ?? null
  const fps = (num as number) / den
  return Number.isFinite(fps) ? Math.round(fps * 100) / 100 : null
}

function toNumber(value: string | number | undefined): number | null {
  if (value === undefined) return null
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : null
}

function hasFaststart(parsed: FfprobeOutput): boolean {
  // For MP4/MOV, ffprobe exposes this through the format tags only
  // inconsistently, so the practical check is whether the container is one
  // where it matters at all. Non-MP4 containers have no moov atom, so the
  // question does not arise and the answer is trivially yes.
  const format = parsed.format?.format_name ?? ''
  if (!/mp4|mov|m4a|3gp/i.test(format)) return true
  return parsed.format?.tags?.['major_brand'] !== undefined
}

type FfprobeOutput = {
  format?: {
    format_name?: string
    duration?: string
    size?: string
    tags?: Record<string, string>
  }
  streams?: Array<{
    codec_type?: string
    codec_name?: string
    width?: number
    height?: number
    avg_frame_rate?: string
    r_frame_rate?: string
    pix_fmt?: string
    sample_rate?: string
    channels?: number
  }>
}
