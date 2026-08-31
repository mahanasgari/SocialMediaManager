import { describe, expect, it } from 'vitest'
import { isComplete, render, variablesIn } from './template.js'

describe('template variables', () => {
  it('finds variables in the order they appear', () => {
    // Appearance order, not alphabetical: the list drives the form somebody
    // fills in, and a form that does not follow the sentence is harder to fill.
    expect(variablesIn('Hi {{name}}, your {{plan}} renews {{date}}')).toEqual([
      'name',
      'plan',
      'date',
    ])
  })

  it('reports each variable once however often it is used', () => {
    expect(variablesIn('{{name}} {{name}} {{name}}')).toEqual(['name'])
  })

  it('tolerates spaces inside the braces', () => {
    expect(variablesIn('{{ name }} and {{  plan  }}')).toEqual(['name', 'plan'])
  })

  it('ignores single braces and unclosed placeholders', () => {
    expect(variablesIn('{name} and {{unclosed and }} alone')).toEqual([])
  })

  it('finds nothing in text with no placeholders', () => {
    expect(variablesIn('A perfectly ordinary post.')).toEqual([])
  })
})

describe('rendering', () => {
  it('substitutes every supplied value', () => {
    const result = render('Hi {{name}}, welcome to {{product}}.', {
      name: 'Ada',
      product: 'Lovelace',
    })
    expect(result.text).toBe('Hi Ada, welcome to Lovelace.')
    expect(result.missing).toEqual([])
  })

  it('replaces every occurrence, not just the first', () => {
    expect(render('{{x}} {{x}} {{x}}', { x: 'a' }).text).toBe('a a a')
  })

  it('LEAVES the placeholder visible when a value is missing', () => {
    // Not blanked. If a caller ignores `missing` and publishes anyway, the
    // visible damage should point at its own cause: "{{first_name}}" is
    // debuggable, a sentence with a hole in it is not.
    const result = render('Hi {{first_name}}, thanks for following.', {})
    expect(result.text).toBe('Hi {{first_name}}, thanks for following.')
    expect(result.missing).toEqual(['first_name'])
  })

  it('treats an empty string as supplied, not missing', () => {
    // "Leave this blank" is a legitimate choice — an optional sign-off, say.
    // Conflating it with "you forgot" makes the deliberate case impossible.
    const result = render('Thanks!{{signoff}}', { signoff: '' })
    expect(result.text).toBe('Thanks!')
    expect(result.missing).toEqual([])
  })

  it('reports a missing variable once however often it appears', () => {
    expect(render('{{a}} {{a}} {{b}}', { b: '2' }).missing).toEqual(['a'])
  })

  it('reports values the template does not use', () => {
    // Harmless, but worth showing: it usually means a renamed variable.
    const result = render('Hi {{name}}', { name: 'Ada', plan: 'pro' })
    expect(result.unused).toEqual(['plan'])
  })

  it('does not treat a substituted value as a template', () => {
    // A value containing {{x}} must NOT be expanded — otherwise a caller who
    // interpolates untrusted text gets a second, unintended round of
    // substitution against whatever else is in scope.
    const result = render('{{a}}', { a: '{{b}}', b: 'boom' })
    expect(result.text).toBe('{{b}}')
  })

  it('isComplete agrees with render', () => {
    expect(isComplete('Hi {{name}}', { name: 'Ada' })).toBe(true)
    expect(isComplete('Hi {{name}}', {})).toBe(false)
    expect(isComplete('No variables here', {})).toBe(true)
  })
})
