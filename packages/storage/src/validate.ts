/**
 * Upload validation.
 *
 * The rule that shapes this file: MIME type is determined by SNIFFING THE
 * BYTES, never by the client's Content-Type header or the filename extension.
 * Both are attacker-controlled, and trusting either is how a .jpg that is
 * actually an HTML document ends up served back to a browser.
 */

export type SniffResult = {
  mime: string
  extension: string
  /** Dimensions, where the format header carries them. */
  width?: number
  height?: number
}

export class UnsupportedUpload extends Error {
  override readonly name = 'UnsupportedUpload'
  constructor(message: string) {
    super(message)
  }
}

/** Formats we accept at all. A provider may still refuse a subset. */
export const ACCEPTED_MIME = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'video/mp4',
  'video/quicktime',
] as const

/** 512 MB. Video for TikTok and YouTube is the reason this is not smaller. */
export const MAX_UPLOAD_BYTES = 512 * 1024 * 1024

/**
 * Identifies a file from its magic bytes.
 *
 * Returns null for anything unrecognised, which the caller must treat as a
 * rejection — an unknown format is not "probably fine".
 */
export function sniff(buffer: Buffer): SniffResult | null {
  if (buffer.length < 12) return null

  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { mime: 'image/jpeg', extension: 'jpg', ...(jpegDimensions(buffer) ?? {}) }
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return {
      mime: 'image/png',
      extension: 'png',
      width: buffer.readUInt32BE(16),
      height: buffer.readUInt32BE(20),
    }
  }

  // GIF87a / GIF89a
  if (buffer.subarray(0, 3).toString('ascii') === 'GIF') {
    return {
      mime: 'image/gif',
      extension: 'gif',
      width: buffer.readUInt16LE(6),
      height: buffer.readUInt16LE(8),
    }
  }

  // WebP: RIFF....WEBP
  if (
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return { mime: 'image/webp', extension: 'webp' }
  }

  // ISO base media (MP4 / MOV): size, then 'ftyp', then a brand.
  if (buffer.subarray(4, 8).toString('ascii') === 'ftyp') {
    const brand = buffer.subarray(8, 12).toString('ascii')
    if (brand === 'qt  ') return { mime: 'video/quicktime', extension: 'mov' }
    return { mime: 'video/mp4', extension: 'mp4' }
  }

  return null
}

/**
 * Walks JPEG segment markers to the frame header.
 *
 * Worth doing rather than trusting a client-reported size: aspect-ratio rules
 * are enforced against these numbers, and a lie here would let a post through
 * that the platform then rejects hours later at publish time.
 */
function jpegDimensions(buffer: Buffer): { width: number; height: number } | undefined {
  let offset = 2
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset++
      continue
    }
    const marker = buffer[offset + 1]!
    // SOF0..SOF15, excluding the non-frame markers in that range.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) }
    }
    const length = buffer.readUInt16BE(offset + 2)
    if (length < 2) return undefined
    offset += 2 + length
  }
  return undefined
}

export type UploadCheck = {
  declaredMime?: string | undefined
  filename?: string | undefined
  bytes: number
  buffer: Buffer
}

export type UploadVerdict = {
  mime: string
  extension: string
  width?: number | undefined
  height?: number | undefined
}

/**
 * Accepts or rejects an upload.
 *
 * Note what happens on a mismatch between the sniffed type and the declared one:
 * the SNIFFED type wins and the upload proceeds under it. The declared value is
 * simply discarded rather than treated as an attack — most mismatches are a
 * browser guessing badly, and rejecting them would break ordinary uploads for no
 * security gain, since we never use the declared value anyway.
 */
export function checkUpload(input: UploadCheck): UploadVerdict {
  if (input.bytes <= 0) {
    throw new UnsupportedUpload('That file is empty.')
  }

  if (input.bytes > MAX_UPLOAD_BYTES) {
    const limitMb = Math.round(MAX_UPLOAD_BYTES / (1024 * 1024))
    throw new UnsupportedUpload(`That file is larger than ${limitMb} MB, which is the upload limit.`)
  }

  const sniffed = sniff(input.buffer)
  if (!sniffed) {
    throw new UnsupportedUpload(
      `That file type is not supported. Accepted formats: ${ACCEPTED_MIME.join(', ')}.`
    )
  }

  if (!ACCEPTED_MIME.includes(sniffed.mime as (typeof ACCEPTED_MIME)[number])) {
    throw new UnsupportedUpload(
      `${sniffed.mime} files are not supported. Accepted formats: ${ACCEPTED_MIME.join(', ')}.`
    )
  }

  return {
    mime: sniffed.mime,
    extension: sniffed.extension,
    width: sniffed.width,
    height: sniffed.height,
  }
}
