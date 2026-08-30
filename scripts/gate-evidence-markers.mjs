#!/usr/bin/env node
// Gate: a [V] marker must cite a source URL and a retrieval date.
// "A [V] without a URL and date is an assumption wearing a badge."
//
// Scans markdown docs and provider source for [V]. Requires, on the same line
// or the two following, both an http(s) URL and an ISO date.
//
// Escape hatches, for marker *definitions* and summary tables whose citations
// live elsewhere in the same document:
//   <!-- evidence-gate:ignore -->              skip the line it appears on
//   <!-- evidence-gate:ignore-block-start -->  skip until ...-end
//   <!-- evidence-gate:ignore-block-end -->
import { readFileSync, globSync } from 'node:fs'

const FILES = [
  ...globSync('*.md'),
  ...globSync('docs/**/*.md'),
  // Build output is EXCLUDED. `dist/**/*.d.ts` matches `*.ts`, and declaration
  // files carry the JSDoc through verbatim — so without this every marker is
  // counted twice and a violation gets reported against a generated file nobody
  // can edit.
  //
  // `exclude`, not `ignore`: this is node:fs globSync, not the glob package, and
  // it silently ignores an option it does not recognise. Which is how the first
  // attempt at this fix appeared to work and changed nothing.
  ...globSync('packages/providers/**/*.ts', {
    exclude: (path) => path.includes('dist') || path.includes('node_modules'),
  }),
].sort()

const URL_RE = /https?:\/\/[^\s)\]]+/
const DATE_RE = /\b\d{4}-\d{2}-\d{2}\b/
const failures = []
let checked = 0

for (const file of FILES) {
  const lines = readFileSync(file, 'utf8').split('\n')
  let blocked = false

  lines.forEach((line, i) => {
    if (line.includes('evidence-gate:ignore-block-start')) { blocked = true; return }
    if (line.includes('evidence-gate:ignore-block-end')) { blocked = false; return }
    if (blocked) return
    if (line.includes('evidence-gate:ignore')) return
    if (!line.includes('[V]')) return

    checked++
    const window = lines.slice(i, i + 3).join('\n')
    const hasUrl = URL_RE.test(window)
    const hasDate = DATE_RE.test(window)
    if (hasUrl && hasDate) return

    const missing = [!hasUrl && 'source URL', !hasDate && 'retrieval date']
      .filter(Boolean)
      .join(' and ')
    failures.push(`${file}:${i + 1}  missing ${missing}\n    ${line.trim().slice(0, 120)}`)
  })
}

if (failures.length) {
  console.error(`\n[V] markers missing evidence (${failures.length} of ${checked} checked):\n`)
  console.error(failures.join('\n\n'))
  console.error('\nAttach a source URL + ISO date, or downgrade the marker to [A].\n')
  process.exit(1)
}
console.log(`evidence gate: OK — ${checked} [V] marker(s) cited across ${FILES.length} file(s)`)
