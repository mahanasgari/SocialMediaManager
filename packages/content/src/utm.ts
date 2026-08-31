/**
 * UTM tagging.
 *
 * Appends campaign parameters to the links in a post so the traffic shows up
 * attributed in whatever analytics the workspace already uses. It is the one
 * feature here that reaches into someone else's system, which is why it is
 * conservative about what it touches.
 *
 * The per-variant part is the point. `utm_source` is different for every
 * network — that is the whole reason the parameter exists — so a preset is a
 * TEMPLATE, resolved once per variant with the network's own name, not a fixed
 * string applied everywhere. A single hard-coded `utm_source=social` produces a
 * report that says traffic came from "social", which is a fact nobody needed.
 */

import { variablesIn, render } from './template.js'

export type UtmParams = {
  source: string
  medium: string
  campaign?: string | undefined
  term?: string | undefined
  content?: string | undefined
}

export type TagResult = {
  text: string
  /** How many links were tagged. Zero on a post with no links is normal. */
  tagged: number
  /** Links left alone, with the reason. Shown in the composer, never silent. */
  skipped: Array<{ url: string; reason: string }>
}

/**
 * URLs in plain text.
 *
 * Deliberately conservative: http and https only, and the match stops before
 * trailing punctuation. A URL at the end of a sentence is followed by a full
 * stop that is not part of it, and swallowing that produces a link that 404s —
 * a worse outcome than not tagging at all.
 */
const URL_PATTERN = /https?:\/\/[^\s<>"']+/g

function trimTrailingPunctuation(url: string): string {
  let end = url.length
  while (end > 0 && '.,;:!?'.includes(url[end - 1]!)) end -= 1
  // Closing brackets only count as punctuation when unbalanced — Wikipedia
  // URLs really do end in ")".
  while (end > 0 && url[end - 1] === ')') {
    const slice = url.slice(0, end)
    const opens = (slice.match(/\(/g) ?? []).length
    const closes = (slice.match(/\)/g) ?? []).length
    if (closes <= opens) break
    end -= 1
  }
  return url.slice(0, end)
}

/** Every http(s) link in the text, de-duplicated, in order. */
export function linksIn(text: string): string[] {
  const found: string[] = []
  for (const match of text.matchAll(URL_PATTERN)) {
    const url = trimTrailingPunctuation(match[0])
    if (url && !found.includes(url)) found.push(url)
  }
  return found
}

const PARAM_FOR: Record<keyof UtmParams, string> = {
  source: 'utm_source',
  medium: 'utm_medium',
  campaign: 'utm_campaign',
  term: 'utm_term',
  content: 'utm_content',
}

/**
 * Adds UTM parameters to one URL.
 *
 * Existing `utm_*` parameters are NOT overwritten. An author who typed
 * `?utm_source=newsletter` into the composer meant it, and a workspace default
 * silently replacing a deliberate choice is the kind of helpfulness that
 * corrupts a quarter of attribution data before anyone notices. The composer
 * reports which parameters it left alone, so the override is visible rather
 * than merely tolerated.
 */
export function tagUrl(url: string, params: UtmParams): { url: string; changed: boolean } {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { url, changed: false }
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { url, changed: false }
  }

  let changed = false
  for (const [key, param] of Object.entries(PARAM_FOR) as Array<[keyof UtmParams, string]>) {
    const value = params[key]
    if (value === undefined || value === '') continue
    if (parsed.searchParams.has(param)) continue
    parsed.searchParams.set(param, value)
    changed = true
  }

  // href re-encodes, which is correct — but it also normalises a bare origin to
  // a trailing slash. Harmless for a link, surprising in a diff, so it is only
  // returned when something actually changed.
  return changed ? { url: parsed.href, changed: true } : { url, changed: false }
}

/**
 * Tags every link in a piece of text.
 *
 * Replacement is done by scanning rather than by a global regex replace,
 * because the same URL can appear twice and only the untagged occurrences
 * should change — and because a replace callback cannot report why it skipped.
 */
export function tagText(text: string, params: UtmParams): TagResult {
  const skipped: TagResult['skipped'] = []
  let tagged = 0

  const out = text.replace(URL_PATTERN, (raw) => {
    const url = trimTrailingPunctuation(raw)
    const trailing = raw.slice(url.length)

    const result = tagUrl(url, params)
    if (result.changed) {
      tagged += 1
      return result.url + trailing
    }

    skipped.push({
      url,
      reason: url.includes('utm_')
        ? 'already carries UTM parameters, which were left as the author wrote them'
        : 'not an http or https link',
    })
    return raw
  })

  return { text: out, tagged, skipped }
}

/**
 * Resolves a preset's templated values for one variant.
 *
 * `{{network}}`, `{{campaign}}` and the rest are filled per variant — this is
 * what makes one preset usable across every channel instead of one preset per
 * channel per campaign, which is how UTM configuration becomes a spreadsheet
 * nobody maintains.
 *
 * A variable with no value falls back to leaving the parameter OFF rather than
 * emitting a literal `{{network}}` into somebody's analytics. An absent
 * dimension is recoverable; a dimension polluted with template syntax has to be
 * cleaned up in the destination, where we have no access.
 */
export function resolvePreset(
  preset: UtmParams,
  context: Record<string, string>
): { params: UtmParams; missing: string[] } {
  const missing = new Set<string>()

  const resolve = (value: string | undefined): string | undefined => {
    if (value === undefined || value === '') return undefined
    const result = render(value, context)
    if (result.missing.length > 0) {
      for (const name of result.missing) missing.add(name)
      return undefined
    }
    return result.text
  }

  return {
    params: {
      source: resolve(preset.source) ?? '',
      medium: resolve(preset.medium) ?? '',
      campaign: resolve(preset.campaign),
      term: resolve(preset.term),
      content: resolve(preset.content),
    },
    missing: [...missing],
  }
}

/** Every variable a preset refers to, for the UI to explain what it needs. */
export function presetVariables(preset: UtmParams): string[] {
  const all = [preset.source, preset.medium, preset.campaign, preset.term, preset.content]
  const seen: string[] = []
  for (const value of all) {
    if (!value) continue
    for (const name of variablesIn(value)) if (!seen.includes(name)) seen.push(name)
  }
  return seen
}
