import { describe, expect, it } from 'vitest'
import { escapeCell, toCsv } from './reports.controller.js'

describe('CSV escaping', () => {
  it('leaves an ordinary value alone', () => {
    expect(escapeCell('hello')).toBe('hello')
    expect(escapeCell(42)).toBe('42')
  })

  it('quotes a value containing a comma', () => {
    expect(escapeCell('one, two')).toBe('"one, two"')
  })

  it('doubles embedded quotes', () => {
    expect(escapeCell('say "hi"')).toBe('"say ""hi"""')
  })

  it('quotes a value containing a newline, so a post body cannot break the row', () => {
    expect(escapeCell('line one\nline two')).toBe('"line one\nline two"')
  })

  it('renders null and undefined as empty, never as the word', () => {
    // "null" in a spreadsheet cell is worse than nothing: it looks like data.
    expect(escapeCell(null)).toBe('')
    expect(escapeCell(undefined)).toBe('')
  })

  it('renders 0 as 0, not as empty', () => {
    // The distinction the whole nullability discipline rests on: a measured
    // zero is data, an unmeasured metric is not.
    expect(escapeCell(0)).toBe('0')
  })
})

describe('formula injection', () => {
  // A cell beginning with =, +, - or @ is EXECUTED by Excel and Sheets. A post
  // whose text starts with one — or one written to — becomes code running on the
  // machine of whoever opens the export.
  it.each(['=1+1', '+1', '-1', '@SUM(A1)', '=cmd|\' /c calc\'!A0'])(
    'neutralises %s',
    (payload) => {
      expect(escapeCell(payload).startsWith("'")).toBe(true)
    }
  )

  it('neutralises a leading tab or carriage return, which also trigger it', () => {
    // The apostrophe is applied FIRST, then quoting may wrap the whole cell —
    // so the carriage-return case comes out as `"'\r=1+1"`, quoted and
    // neutralised. What matters is that the apostrophe precedes the payload,
    // not that it is the first byte of the field.
    expect(escapeCell('\t=1+1')).toContain("'\t=1+1")
    expect(escapeCell('\r=1+1')).toContain("'\r=1+1")
  })

  it('still quotes a dangerous value that also contains a comma', () => {
    const result = escapeCell('=SUM(1,2)')
    expect(result).toBe(`"'=SUM(1,2)"`)
  })

  it('does not touch a minus sign in the middle of a value', () => {
    expect(escapeCell('a-b')).toBe('a-b')
  })

  it('does not mangle a negative number that is genuinely data', () => {
    // Prefixed, because Excel cannot tell -5 from a formula either — and a
    // visible apostrophe beats an executed cell.
    expect(escapeCell(-5)).toBe("'-5")
  })
})

describe('document assembly', () => {
  const rows = [
    { id: '1', channel: '@one', likes: 10 },
    { id: '2', channel: '@two', likes: 0 },
  ]

  it('emits a header row from the first record', () => {
    expect(toCsv(rows).split('\r\n')[0]).toBe('id,channel,likes')
  })

  it('uses CRLF, which is what the spec says and Excel expects', () => {
    expect(toCsv(rows)).toContain('\r\n')
  })

  it('emits one line per row plus the header', () => {
    expect(toCsv(rows).split('\r\n')).toHaveLength(3)
  })

  it('returns an empty string for no rows rather than a lone header', () => {
    expect(toCsv([])).toBe('')
  })

  it('keeps column order stable across rows', () => {
    const mixed = [
      { a: 1, b: 2 },
      { b: 4, a: 3 },
    ]
    expect(toCsv(mixed).split('\r\n')[2]).toBe('3,4')
  })
})
