import { describe, expect, it } from 'vitest'
import { mapColumns, parseAccounts, parseCsv, parseWhen } from './csv.js'

/**
 * Reading CSV.
 *
 * Every test here is a file a spreadsheet actually produces. The naive
 * split-on-comma parser passes the first two and corrupts the rest — silently,
 * shifting columns rather than erroring, which is why this is a state machine
 * and why the tests are this specific.
 */

describe('parsing rows and cells', () => {
  it('reads a plain file', () => {
    expect(parseCsv('a,b\n1,2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
  })

  it('keeps a comma inside a quoted cell', () => {
    // The first thing that breaks a split parser, and the most common: any
    // sentence with a comma in it.
    expect(parseCsv('content\n"Hello, world"')).toEqual([['content'], ['Hello, world']])
  })

  it('keeps a NEWLINE inside a quoted cell', () => {
    // The one that corrupts silently rather than loudly. A post body with a
    // line break becomes two rows in a naive parser, and every column after it
    // shifts — no error, just wrong data.
    const rows = parseCsv('content,date\n"line one\nline two",2026-01-01')
    expect(rows).toHaveLength(2)
    expect(rows[1]).toEqual(['line one\nline two', '2026-01-01'])
  })

  it('unescapes a doubled quote', () => {
    expect(parseCsv('content\n"say ""hi"""')).toEqual([['content'], ['say "hi"']])
  })

  it('treats a quote mid-cell as literal text', () => {
    // 6" nails. A quote only opens a cell at its start, which is what a
    // spreadsheet does.
    expect(parseCsv('content\n6" nails')).toEqual([['content'], ['6" nails']])
  })

  it('accepts CRLF, which is what Excel writes', () => {
    expect(parseCsv('a,b\r\n1,2\r\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
  })

  it('strips a UTF-8 BOM', () => {
    // Excel prefixes one. Left in place it becomes an invisible part of the
    // first header, and the file reports having no recognisable columns.
    const withBom = '\uFEFFcontent,date\nhello,2026-01-01'
    const rows = parseCsv(withBom)
    expect(rows[0]).toEqual(['content', 'date'])
    expect(mapColumns(rows[0]!)).toMatchObject({ content: 0 })
  })

  it('does not invent a trailing empty row', () => {
    // A file ending in a newline would otherwise produce a final row of one
    // empty cell, which reads downstream as a post with no content.
    expect(parseCsv('a\n1\n')).toEqual([['a'], ['1']])
  })

  it('keeps empty cells rather than dropping them', () => {
    // Column positions must survive; dropping an empty shifts everything after.
    expect(parseCsv('a,b,c\n1,,3')).toEqual([
      ['a', 'b', 'c'],
      ['1', '', '3'],
    ])
  })

  it('handles an empty file', () => {
    expect(parseCsv('')).toEqual([])
  })

  it('keeps a quoted empty cell', () => {
    expect(parseCsv('a,b\n"",x')).toEqual([
      ['a', 'b'],
      ['', 'x'],
    ])
  })
})

describe('recognising columns', () => {
  it('accepts the names people actually use', () => {
    // Nobody exports a file whose header happens to match one chosen name.
    for (const name of ['content', 'Text', 'POST', 'message', 'Body', 'caption']) {
      expect(mapColumns([name])).toMatchObject({ content: 0 })
    }
  })

  it('ignores case, spaces and underscores', () => {
    expect(mapColumns(['Scheduled At', 'content'])).toMatchObject({
      content: 1,
      scheduledAt: 0,
    })
    expect(mapColumns(['scheduled_at', 'content'])).toMatchObject({ scheduledAt: 0 })
  })

  it('says what is missing rather than failing vaguely', () => {
    const result = mapColumns(['title', 'author'])
    expect(result).toHaveProperty('error')
    expect((result as { error: string }).error).toMatch(/content/i)
  })

  it('treats date and accounts as optional', () => {
    // A row with no date is a draft, which is an ordinary thing to bulk-import.
    expect(mapColumns(['content'])).toEqual({ content: 0, scheduledAt: null, accounts: null })
  })
})

describe('reading a date cell', () => {
  it('distinguishes empty from unparseable', () => {
    // Three-way on purpose. Empty means "no date, make it a draft"; garbage
    // means "this row is wrong, say which". Collapsing them turns a typo into
    // a silent draft.
    expect(parseWhen('')).toBeNull()
    expect(parseWhen('   ')).toBeNull()
    expect(parseWhen('not a date')).toBeUndefined()
    expect(parseWhen('2026-03-01T09:00:00Z')?.toISOString()).toBe('2026-03-01T09:00:00.000Z')
  })
})

describe('reading an accounts cell', () => {
  it('splits on the separators people use', () => {
    expect(parseAccounts('@one, @two')).toEqual(['@one', '@two'])
    expect(parseAccounts('@one; @two')).toEqual(['@one', '@two'])
    expect(parseAccounts('@one | @two')).toEqual(['@one', '@two'])
  })

  it('drops empties rather than producing blank handles', () => {
    expect(parseAccounts('@one,,@two')).toEqual(['@one', '@two'])
    expect(parseAccounts('')).toEqual([])
  })
})
