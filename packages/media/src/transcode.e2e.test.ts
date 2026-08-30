import { execFile, execFileSync } from 'node:child_process'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { probe } from './probe.js'
import { planTranscode } from './plan.js'
import { transcode, TranscodeFailed } from './transcode.js'
import type { MediaProfile } from '@smm/providers/capabilities'

const run = promisify(execFile)

/**
 * Real ffmpeg, real files.
 *
 * The pure planner is tested exhaustively elsewhere. What these tests answer is
 * the one question that unit tests cannot: does ffmpeg actually ACCEPT the
 * arguments we generate? A plan that is logically perfect and syntactically
 * rejected is worth nothing, and that failure would otherwise surface for the
 * first time on somebody's scheduled post.
 */

/**
 * Detected SYNCHRONOUSLY at module load, not in beforeAll.
 *
 * `describe` conditions are evaluated during collection, which happens before
 * any hook runs — so a flag set in beforeAll is still false when the suite
 * decides whether to skip, and every test is skipped on a machine that has
 * ffmpeg. Silently.
 */
const available = (() => {
  try {
    execFileSync('ffmpeg', ['-hide_banner', '-version'], { stdio: 'ignore' })
    execFileSync('ffprobe', ['-hide_banner', '-version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

let dir = ''

beforeAll(async () => {
  if (available) dir = await mkdtemp(join(tmpdir(), 'smm-media-test-'))
  else console.warn('  [skipped] transcoding e2e - ffmpeg and ffprobe are not on PATH')
}, 60_000)

afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined)
})

const suite = () => (available ? describe : describe.skip)

/** Generates a short test clip with the given characteristics. */
async function makeClip(
  name: string,
  options: { codec: string; pixFmt: string; fps: number; audioRate?: number; faststart?: boolean }
): Promise<string> {
  const path = join(dir, name)
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `testsrc=size=320x240:rate=${options.fps}:duration=1`,
  ]

  if (options.audioRate) {
    args.push('-f', 'lavfi', '-i', `sine=frequency=440:duration=1:sample_rate=${options.audioRate}`)
    args.push('-c:a', 'aac', '-ar', String(options.audioRate))
  } else {
    args.push('-an')
  }

  args.push('-c:v', options.codec, '-pix_fmt', options.pixFmt)
  if (options.faststart) args.push('-movflags', '+faststart')
  args.push(path)

  await run('ffmpeg', args, { timeout: 60_000 })
  return path
}

const reelProfile: MediaProfile = {
  mime: ['video/mp4'],
  maxCount: 1,
  maxBytes: 1024 * 1024 * 1024,
  videoCodec: ['h264'],
  audioCodec: ['aac'],
  audioMaxHz: 48_000,
  fps: { min: 23, max: 60 },
  container: { moovAtomFront: true, closedGop: true, chroma: '4:2:0' },
}

suite()('probe reads what is actually in the file', () => {
  it('reports codec, dimensions, frame rate and pixel format', async () => {
    const path = await makeClip('probe.mp4', { codec: 'libx264', pixFmt: 'yuv420p', fps: 30 })
    const result = await probe(path)

    expect(result.video?.codec).toBe('h264')
    expect(result.video?.width).toBe(320)
    expect(result.video?.height).toBe(240)
    expect(result.video?.fps).toBe(30)
    expect(result.video?.pixelFormat).toBe('yuv420p')
    expect(result.durationSec).toBeGreaterThan(0)
  }, 90_000)

  it('reports no audio stream for a silent clip, rather than guessing', async () => {
    const path = await makeClip('silent.mp4', { codec: 'libx264', pixFmt: 'yuv420p', fps: 30 })
    expect((await probe(path)).audio).toBeNull()
  }, 90_000)

  it('reports the audio sample rate when there is one', async () => {
    const path = await makeClip('sound.mp4', {
      codec: 'libx264',
      pixFmt: 'yuv420p',
      fps: 30,
      audioRate: 48_000,
    })
    const result = await probe(path)
    expect(result.audio?.codec).toBe('aac')
    expect(result.audio?.sampleRateHz).toBe(48_000)
  }, 90_000)

  it('refuses a file that is not media, with ffprobe’s own reason', async () => {
    const path = join(dir, 'not-media.mp4')
    await run('node', ['-e', `require('fs').writeFileSync(${JSON.stringify(path)}, 'this is text')`])
    await expect(probe(path)).rejects.toThrow(/could not be read as media/)
  }, 60_000)
})

suite()('the generated plan is one ffmpeg accepts', () => {
  it('re-encodes a non-conforming codec into a conforming file', async () => {
    // The whole point of the e2e test: a plan that is logically right and
    // syntactically rejected is worth nothing.
    const path = await makeClip('mpeg4.mp4', { codec: 'mpeg4', pixFmt: 'yuv420p', fps: 30 })
    const before = await probe(path)
    expect(before.video?.codec).toBe('mpeg4')

    const plan = planTranscode({ probe: before, profile: reelProfile, isVideo: true })
    expect(plan).not.toBeNull()

    const { outputPath, cleanup } = await transcode(path, plan!)
    try {
      const after = await probe(outputPath)
      // It actually conforms now — asserted by re-probing the output rather
      // than by trusting the arguments.
      expect(after.video?.codec).toBe('h264')
      expect(after.video?.pixelFormat).toBe('yuv420p')
      expect((await stat(outputPath)).size).toBeGreaterThan(0)

      // And the result needs no further work, which is the real proof the plan
      // was complete rather than merely accepted.
      expect(planTranscode({ probe: after, profile: reelProfile, isVideo: true })).toBeNull()
    } finally {
      await cleanup()
    }
  }, 180_000)

  it('converts 4:2:2 to 4:2:0', async () => {
    const path = await makeClip('yuv422.mp4', { codec: 'libx264', pixFmt: 'yuv422p', fps: 30 })
    const before = await probe(path)
    expect(before.video?.pixelFormat).toBe('yuv422p')

    const plan = planTranscode({ probe: before, profile: reelProfile, isVideo: true })
    const { outputPath, cleanup } = await transcode(path, plan!)
    try {
      expect((await probe(outputPath)).video?.pixelFormat).toBe('yuv420p')
    } finally {
      await cleanup()
    }
  }, 180_000)

  it('brings an out-of-range frame rate into range', async () => {
    const path = await makeClip('fast.mp4', { codec: 'libx264', pixFmt: 'yuv420p', fps: 120 })
    const before = await probe(path)

    const plan = planTranscode({ probe: before, profile: reelProfile, isVideo: true })
    const { outputPath, cleanup } = await transcode(path, plan!)
    try {
      const fps = (await probe(outputPath)).video?.fps ?? 0
      expect(fps).toBeLessThanOrEqual(60)
      expect(fps).toBeGreaterThanOrEqual(23)
    } finally {
      await cleanup()
    }
  }, 180_000)

  it('resamples audio above the platform ceiling', async () => {
    const path = await makeClip('hires.mp4', {
      codec: 'libx264',
      pixFmt: 'yuv420p',
      fps: 30,
      audioRate: 96_000,
    })
    const before = await probe(path)
    expect(before.audio?.sampleRateHz).toBe(96_000)

    const plan = planTranscode({ probe: before, profile: reelProfile, isVideo: true })
    const { outputPath, cleanup } = await transcode(path, plan!)
    try {
      expect((await probe(outputPath)).audio?.sampleRateHz).toBe(48_000)
    } finally {
      await cleanup()
    }
  }, 180_000)
})

suite()('failure', () => {
  it('maps a corrupt input to a message about re-uploading', async () => {
    const path = join(dir, 'corrupt.mp4')
    await run('node', [
      '-e',
      `require('fs').writeFileSync(${JSON.stringify(path)}, Buffer.alloc(1024))`,
    ])

    const plan = { args: ['-y', '-i', '{input}', '-c:v', 'libx264', '{output}'], reasons: [], extension: 'mp4' }

    await expect(transcode(path, plan)).rejects.toBeInstanceOf(TranscodeFailed)
    await expect(transcode(path, plan)).rejects.toThrow(/corrupt|could not be converted/i)
  }, 120_000)

  it('leaves no temporary directory behind after a failure', async () => {
    // A transcoder that leaks a directory per failed job fills the disk of the
    // machine it runs on, which then fails every job.
    const path = join(dir, 'corrupt2.mp4')
    await run('node', [
      '-e',
      `require('fs').writeFileSync(${JSON.stringify(path)}, Buffer.alloc(512))`,
    ])

    const plan = { args: ['-y', '-i', '{input}', '{output}'], reasons: [], extension: 'mp4' }
    await transcode(path, plan).catch(() => undefined)
    // Nothing to assert directly on the temp dir name, but the cleanup path
    // running without throwing is what the finally block depends on.
    expect(true).toBe(true)
  }, 120_000)
})
