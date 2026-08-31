/**
 * Templates with variables.
 *
 * A template is text with `{{placeholders}}` in it. The interesting part is not
 * the substitution — that is a regex — it is what happens when a value is
 * MISSING.
 *
 * Two obvious behaviours are both wrong. Leaving `{{first_name}}` in the output
 * publishes it to a public timeline, which is the mail-merge failure everyone
 * has seen and nobody forgets. Silently substituting an empty string publishes
 * "Hi , thanks for following" instead, which is the same failure wearing a
 * disguise: quieter, and therefore likelier to survive review.
 *
 * So rendering REPORTS what is missing and the caller decides. The composer
 * shows it before you post; the API refuses the write. Neither guesses.
 */

/** `{{ name }}` — letters, digits, underscore and hyphen, with optional spaces. */
const PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_-]+)\s*\}\}/g

export type RenderResult = {
  text: string
  /** Variables the template uses that were not supplied. Empty means complete. */
  missing: string[]
  /** Variables supplied that the template does not use. Harmless, worth showing. */
  unused: string[]
}

/**
 * Every variable a template refers to, in first-appearance order.
 *
 * Order matters because it drives the form the author fills in, and a form
 * whose fields are alphabetised does not match the sentence being written.
 */
export function variablesIn(template: string): string[] {
  const seen: string[] = []
  for (const match of template.matchAll(PLACEHOLDER)) {
    const name = match[1]!
    if (!seen.includes(name)) seen.push(name)
  }
  return seen
}

/**
 * Substitutes values, reporting anything it could not fill.
 *
 * An empty-string value counts as SUPPLIED. "Leave this blank" is a legitimate
 * choice — an optional sign-off, say — and conflating it with "you forgot" would
 * make the deliberate case impossible to express.
 */
export function render(template: string, values: Record<string, string>): RenderResult {
  const used = new Set<string>()
  const missing: string[] = []

  const text = template.replace(PLACEHOLDER, (whole, rawName: string) => {
    const name = rawName
    const value = values[name]
    if (value === undefined) {
      if (!missing.includes(name)) missing.push(name)
      // The placeholder is left INTACT rather than blanked. If a caller ignores
      // `missing` and publishes anyway, the visible damage should point at the
      // cause — "{{first_name}}" is debuggable, a missing word is not.
      return whole
    }
    used.add(name)
    return value
  })

  return {
    text,
    missing,
    unused: Object.keys(values).filter((k) => !used.has(k)),
  }
}

/** True when every variable the template needs has a value. */
export function isComplete(template: string, values: Record<string, string>): boolean {
  return render(template, values).missing.length === 0
}
