import { describe, expect, it } from 'vitest'
import { checkUpload, sniff, UnsupportedUpload, MAX_UPLOAD_BYTES } from './validate.js'

/** Minimal but real headers — the bytes a sniffer actually reads. */
const JPEG = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  Buffer.from([0x00, 0x10]),
  Buffer.from('JFIF\0', 'ascii'),
  Buffer.alloc(9),
  // SOF0: marker, length, precision, height 600, width 800
  Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x58, 0x03, 0x20]),
  Buffer.alloc(16),
])

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from([0x00, 0x00, 0x00, 0x0d]),
  Buffer.from('IHDR', 'ascii'),
  (() => {
    const b = Buffer.alloc(8)
    b.writeUInt32BE(1920, 0)
    b.writeUInt32BE(1080, 4)
    return b
  })(),
  Buffer.alloc(8),
])

const GIF = Buffer.concat([
  Buffer.from('GIF89a', 'ascii'),
  (() => {
    const b = Buffer.alloc(4)
    b.writeUInt16LE(320, 0)
    b.writeUInt16LE(240, 2)
    return b
  })(),
  Buffer.alloc(8),
])

const WEBP = Buffer.concat([
  Buffer.from('RIFF', 'ascii'),
  Buffer.alloc(4),
  Buffer.from('WEBP', 'ascii'),
  Buffer.alloc(8),
])

const MP4 = Buffer.concat([
  Buffer.alloc(4),
  Buffer.from('ftyp', 'ascii'),
  Buffer.from('isom', 'ascii'),
  Buffer.alloc(8),
])

const MOV = Buffer.concat([
  Buffer.alloc(4),
  Buffer.from('ftyp', 'ascii'),
  Buffer.from('qt  ', 'ascii'),
  Buffer.alloc(8),
])

const HTML = Buffer.from('<!DOCTYPE html><html><body>hi</body></html>', 'ascii')

describe('format sniffing', () => {
  it.each([
    ['JPEG', JPEG, 'image/jpeg'],
    ['PNG', PNG, 'image/png'],
    ['GIF', GIF, 'image/gif'],
    ['WebP', WEBP, 'image/webp'],
    ['MP4', MP4, 'video/mp4'],
    ['QuickTime', MOV, 'video/quicktime'],
  ])('identifies %s', (_name, buffer, mime) => {
    expect(sniff(buffer)?.mime).toBe(mime)
  })

  it('reads JPEG dimensions from the frame header', () => {
    // Enforcing aspect ratios against a client-reported size would let a post
    // through that the platform rejects hours later at publish time.
    const result = sniff(JPEG)
    expect(result).toMatchObject({ width: 800, height: 600 })
  })

  it('reads PNG dimensions from IHDR', () => {
    expect(sniff(PNG)).toMatchObject({ width: 1920, height: 1080 })
  })

  it('reads GIF dimensions, which are little-endian', () => {
    expect(sniff(GIF)).toMatchObject({ width: 320, height: 240 })
  })

  it('returns null for an unrecognised format', () => {
    // Unknown is a rejection, not "probably fine".
    expect(sniff(HTML)).toBeNull()
    expect(sniff(Buffer.alloc(4))).toBeNull()
  })
})

describe('upload checking', () => {
  it('accepts a real image', () => {
    expect(checkUpload({ bytes: JPEG.length, buffer: JPEG })).toMatchObject({
      mime: 'image/jpeg',
      extension: 'jpg',
      width: 800,
    })
  })

  // THE case this exists for.
  it('rejects an HTML file wearing a .jpg name and an image Content-Type', () => {
    expect(() =>
      checkUpload({
        bytes: HTML.length,
        buffer: HTML,
        filename: 'holiday.jpg',
        declaredMime: 'image/jpeg',
      })
    ).toThrow(UnsupportedUpload)
  })

  it('ignores the declared type entirely and trusts the bytes', () => {
    // Most mismatches are a browser guessing badly, not an attack — so the
    // sniffed type simply wins and the upload proceeds under it.
    expect(
      checkUpload({ bytes: PNG.length, buffer: PNG, declaredMime: 'image/jpeg' }).mime
    ).toBe('image/png')
  })

  it('rejects an empty file', () => {
    expect(() => checkUpload({ bytes: 0, buffer: Buffer.alloc(0) })).toThrow(/empty/)
  })

  it('rejects a file over the size limit, and says the limit', () => {
    expect(() => checkUpload({ bytes: MAX_UPLOAD_BYTES + 1, buffer: JPEG })).toThrow(/512 MB/)
  })

  it('names the accepted formats when rejecting', () => {
    // Turns "rejected" into "convert to one of these".
    try {
      checkUpload({ bytes: HTML.length, buffer: HTML })
    } catch (err) {
      expect((err as Error).message).toContain('image/jpeg')
      expect((err as Error).message).toContain('video/mp4')
    }
  })

  it('rejects a truncated header rather than guessing', () => {
    expect(() => checkUpload({ bytes: 3, buffer: Buffer.from([0xff, 0xd8, 0xff]) })).toThrow(
      UnsupportedUpload
    )
  })
})
