import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { TranscodePlan } from './plan.js'

const run = promisify(execFile)

/**
 * Running ffmpeg.
 *
 * Kept separate from the planning so the decisions can be tested without
 * encoding anything. This file does one thing: take a plan and a file, and
 * produce a file.
 */

export class TranscodeFailed extends Error {
  override readonly name = 'TranscodeFailed'
  constructor(
    readonly detail: string,
    readonly humanMessage: string
  ) {
    super(humanMessage)
  }
}

export type TranscodeOptions = {
  ffmpegPath?: string
  /**
   * Hard ceiling. A transcode that will not finish must fail with a usable
   * message rather than holding a publish job open indefinitely, and a video
   * long enough to exceed this is one no platform in the roster accepts anyway.
   */
  timeoutMs?: number
  /**
   * Threads per job.
   *
   * Deliberately bounded. ffmpeg defaults to every core, so two concurrent
   * transcodes on a small self-hosted box will starve the scheduler and the API
   * — the publish tick stops running because a video is being re-encoded.
   */
  threads?: number
}

const DEFAULT_TIMEOUT_MS = 10 * 60_000
const DEFAULT_THREADS = 2

export async function transcode(
  inputPath: string,
  plan: TranscodePlan,
  options: TranscodeOptions = {}
): Promise<{ outputPath: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'smm-transcode-'))
  const outputPath = join(dir, `output.${plan.extension}`)

  const args = plan.args.map((arg) =>
    arg === '{input}' ? inputPath : arg === '{output}' ? outputPath : arg
  )

  // Inserted rather than baked into the plan so the plan stays a pure statement
  // of what the FORMAT requires, with nothing about this machine in it.
  args.unshift('-hide_banner', '-loglevel', 'error', '-nostdin')
  args.splice(args.indexOf(outputPath), 0, '-threads', String(options.threads ?? DEFAULT_THREADS))

  try {
    await run(options.ffmpegPath ?? 'ffmpeg', args, {
      timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
    })
  } catch (error) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)

    const err = error as { stderr?: string; killed?: boolean; code?: string }
    if (err.killed || err.code === 'ETIMEDOUT') {
      throw new TranscodeFailed(
        'timed out',
        'This video took too long to convert. Try a shorter clip, or one already in the ' +
          'format the platform expects.'
      )
    }

    // ffmpeg's last stderr line is usually the actual reason. Kept, because
    // "conversion failed" sends someone to open a support ticket while
    // "Invalid data found when processing input" tells them the file is corrupt.
    const detail = err.stderr?.trim().split('\n').pop() ?? 'unknown error'
    throw new TranscodeFailed(detail, humanise(detail))
  }

  return {
    outputPath,
    cleanup: () => rm(dir, { recursive: true, force: true }).catch(() => undefined),
  }
}

/**
 * Turns an ffmpeg error into something a person can act on.
 *
 * The mapping reads ffmpeg's own prose, which is fragile — so the fallthrough
 * PRESERVES the original rather than replacing it. An unrecognised error stays
 * diagnosable.
 */
export function humanise(detail: string): string {
  const lower = detail.toLowerCase()

  if (lower.includes('invalid data found') || lower.includes('moov atom not found')) {
    return 'This file appears to be corrupt or incompletely uploaded. Try uploading it again.'
  }
  if (lower.includes('no such file')) {
    return 'The media for this post could not be found in storage.'
  }
  if (lower.includes('unknown encoder')) {
    // An operator problem, not a user problem, and the message says so — the
    // person seeing it cannot fix a missing codec by changing their video.
    return (
      'This server’s ffmpeg build cannot produce the format that platform requires. ' +
      'Ask whoever runs this server to install a full ffmpeg build.'
    )
  }
  if (lower.includes('no space left')) {
    return 'The server ran out of disk space while converting this video.'
  }
  if (lower.includes('permission denied')) {
    return 'The server could not write the converted file.'
  }

  return `This video could not be converted: ${detail}`
}
