/**
 * Reading CSV, which is harder than it looks and usually done wrong.
 *
 * `text.split('\n').map((line) => line.split(','))` handles the file nobody
 * has. Real exports from a spreadsheet contain commas inside quoted cells,
 * quotes inside those, and — the one that breaks naive parsers silently — post
 * bodies with newlines in them, which turn one row into three and shift every
 * column after it.
 *
 * So this is a character-by-character state machine rather than a split. It is
 * small enough to read in one sitting and is the only place in the codebase
 * that needs to understand the format.
 *
 * What it deliberately does NOT do: guess types, trim significant whitespace,
 * or infer a delimiter. A cell is text; what a column MEANS is decided by the
 * caller against a header it recognises.
 */

/** A parsed row: cells in file order. */
export type CsvRow = string[]

/**
 * Splits CSV text into rows of cells.
 *
 * Accepts CRLF, LF and a UTF-8 BOM, because those are what spreadsheets
 * actually emit — Excel writes CRLF and a BOM, and a parser that treats the BOM
 * as part of the first header matches no column and reports a file with no
 * recognisable columns at all.
 */
export function parseCsv(input: string): CsvRow[] {
  // Strip a BOM. Left in place it becomes an invisible prefix on the first
  // header, and the resulting "unknown column content" is baffling to read.
  const text = input.replace(/^\uFEFF/, '')

  const rows: CsvRow[] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  let i = 0

  /** Ends the current cell. */
  const endCell = () => {
    row.push(cell)
    cell = ''
  }

  /** Ends the current row, discarding a trailing blank line. */
  const endRow = () => {
    endCell()
    // A file ending in a newline would otherwise produce a final row of one
    // empty cell, which then reads as a post with no content.
    if (!(row.length === 1 && row[0] === '')) rows.push(row)
    row = []
  }

  while (i < text.length) {
    const char = text[i]!

    if (quoted) {
      if (char === '"') {
        // A doubled quote inside a quoted cell is a literal quote.
        if (text[i + 1] === '"') {
          cell += '"'
          i += 2
          continue
        }
        quoted = false
        i++
        continue
      }
      // Newlines inside quotes belong to the cell. This is the whole reason
      // for the state machine.
      cell += char
      i++
      continue
    }

    if (char === '"' && cell === '') {
      // A quote only opens a cell at its start. Mid-cell it is literal text,
      // which is what a spreadsheet does with 6" nails.
      quoted = true
      i++
      continue
    }

    if (char === ',') {
      endCell()
      i++
      continue
    }

    if (char === '\r') {
      // CRLF or a lone CR; both end the row.
      endRow()
      i += text[i + 1] === '\n' ? 2 : 1
      continue
    }

    if (char === '\n') {
      endRow()
      i++
      continue
    }

    cell += char
    i++
  }

  // Whatever is left is the last row, unless the file ended on a newline.
  if (cell !== '' || row.length > 0) endRow()

  return rows
}

/** Column names this understands, and the aliases people actually type. */
const HEADERS: Record<string, readonly string[]> = {
  content: ['content', 'text', 'post', 'message', 'body', 'caption'],
  scheduledAt: ['scheduledat', 'scheduled', 'date', 'when', 'publishat', 'time'],
  accounts: ['accounts', 'account', 'channels', 'channel', 'handles', 'handle'],
}

export type ColumnMap = { content: number; scheduledAt: number | null; accounts: number | null }

/**
 * Works out which column is which, from the header row.
 *
 * Aliases because nobody exports a file whose header happens to match one
 * chosen name, and asking someone to rename a column before a tool will read
 * their file is a poor first impression. Case and spacing are ignored for the
 * same reason.
 *
 * Only `content` is required. A row with no date is a draft, which is a
 * perfectly ordinary thing to bulk-import.
 */
export function mapColumns(header: CsvRow): ColumnMap | { error: string } {
  const normalised = header.map((h) => h.trim().toLowerCase().replace(/[\s_-]/g, ''))
  const find = (field: keyof typeof HEADERS): number =>
    normalised.findIndex((h) => HEADERS[field]!.includes(h))

  const content = find('content')
  if (content === -1) {
    return {
      error:
        'No content column. The first row must name the columns — one of ' +
        HEADERS['content']!.join(', ') +
        ' is needed, and scheduled/date and accounts are optional.',
    }
  }

  const scheduledAt = find('scheduledAt')
  const accounts = find('accounts')

  return {
    content,
    scheduledAt: scheduledAt === -1 ? null : scheduledAt,
    accounts: accounts === -1 ? null : accounts,
  }
}

/**
 * Reads a date cell, returning null for empty and undefined for unparseable.
 *
 * The three-way answer matters: empty means "no date, make it a draft", while
 * garbage means "this row is wrong and you should be told which". Collapsing
 * them would silently turn a typo into a draft.
 */
export function parseWhen(cell: string): Date | null | undefined {
  const value = cell.trim()
  if (value === '') return null

  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return undefined
  return parsed
}

/** Splits an accounts cell on the separators people actually use. */
export function parseAccounts(cell: string): string[] {
  return cell
    .split(/[;,|]/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
}
