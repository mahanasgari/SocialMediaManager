#!/usr/bin/env node
/**
 * Every migration adds; none takes away.
 *
 * `migrate` finishes before the API and worker restart, so on any real
 * deployment there is a window — seconds on one host, minutes on several —
 * where the NEW schema is live and the OLD code is still running. A dropped
 * column makes the old code's SELECT fail. A rename is a drop and an add
 * wearing a disguise. NOT NULL on an existing column makes the old code's
 * INSERT fail. None of it shows up in testing, because tests run one version
 * at a time.
 *
 * The history was already clean when this was written — thirty migrations, no
 * destructive operation in any of them — which made this gate cheap to add and
 * is exactly why it was worth adding then rather than after the first one.
 *
 * Removing a column takes two releases: one that stops using it, and a later
 * one that drops it. See DEPLOYMENT.md, "The schema compatibility rule".
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const DIR = 'packages/database/prisma/migrations'

/**
 * Each rule is checked against SQL with comments and strings stripped, so a
 * migration explaining why it does NOT drop something is not reported for
 * saying the word.
 */
const RULES = [
  {
    name: 'DROP COLUMN',
    pattern: /\bDROP\s+COLUMN\b/i,
    why: 'the old code still selects it during the restart window',
  },
  {
    name: 'DROP TABLE',
    pattern: /\bDROP\s+TABLE\b/i,
    why: 'the old code still queries it during the restart window',
  },
  {
    name: 'RENAME',
    pattern: /\bRENAME\s+(COLUMN|TO)\b/i,
    why: 'a rename is a drop and an add at once, and breaks the old code both ways',
  },
  {
    name: 'SET NOT NULL',
    pattern: /\bSET\s+NOT\s+NULL\b/i,
    why: "the old code's inserts omit it and would start failing",
  },
  {
    name: 'DROP NOT NULL on a column being added',
    pattern: /\bDROP\s+DEFAULT\b/i,
    why: 'rows inserted by the old code would have no value for it',
  },
]

/** Strips line comments, block comments and quoted strings. */
function strip(sql) {
  return sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''")
}

const failures = []
let checked = 0

for (const entry of readdirSync(DIR, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue
  const file = join(DIR, entry.name, 'migration.sql')

  let sql
  try {
    sql = readFileSync(file, 'utf8')
  } catch {
    continue
  }

  checked++
  const body = strip(sql)

  for (const rule of RULES) {
    if (rule.pattern.test(body)) {
      failures.push({ migration: entry.name, rule: rule.name, why: rule.why })
    }
  }
}

if (failures.length > 0) {
  console.log(`\n  Destructive migrations (${failures.length}):\n`)
  for (const f of failures) {
    console.log(`  ✗ ${f.migration}`)
    console.log(`      ${f.rule} — ${f.why}\n`)
  }
  console.log(
    '  Removing something takes two releases: one that stops using it, and a\n' +
      '  later one that drops it. See DEPLOYMENT.md, "The schema compatibility rule".\n'
  )
  process.exit(1)
}

console.log(`migration gate: OK — ${checked} migrations, all additive`)
