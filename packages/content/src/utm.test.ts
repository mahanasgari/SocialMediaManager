import { describe, expect, it } from 'vitest'
import { linksIn, presetVariables, resolvePreset, tagText, tagUrl } from './utm.js'

const BASE = { source: 'mastodon', medium: 'social' }

describe('finding links', () => {
  it('finds http and https links', () => {
    expect(linksIn('See http://a.example and https://b.example')).toEqual([
      'http://a.example',
      'https://b.example',
    ])
  })

  it('stops before a sentence-ending full stop', () => {
    // Swallowing the full stop produces a link that 404s, which is worse than
    // not tagging at all.
    expect(linksIn('Read it at https://example.com/post.')).toEqual(['https://example.com/post'])
  })

  it('keeps a balanced closing bracket, drops an unbalanced one', () => {
    expect(linksIn('https://en.wikipedia.org/wiki/Ada_(name)')).toEqual([
      'https://en.wikipedia.org/wiki/Ada_(name)',
    ])
    expect(linksIn('(see https://example.com/x)')).toEqual(['https://example.com/x'])
  })

  it('ignores non-http schemes', () => {
    expect(linksIn('mailto:a@b.example and ftp://x.example')).toEqual([])
  })

  it('lists a repeated link once', () => {
    expect(linksIn('https://a.example twice: https://a.example')).toEqual(['https://a.example'])
  })
})

describe('tagging one URL', () => {
  it('adds the parameters', () => {
    const { url } = tagUrl('https://example.com/post', BASE)
    expect(url).toContain('utm_source=mastodon')
    expect(url).toContain('utm_medium=social')
  })

  it('keeps existing query parameters', () => {
    const { url } = tagUrl('https://example.com/p?ref=newsletter', BASE)
    expect(url).toContain('ref=newsletter')
    expect(url).toContain('utm_source=mastodon')
  })

  it('does NOT overwrite a UTM parameter the author wrote', () => {
    // Someone who typed utm_source=newsletter meant it. A workspace default
    // silently replacing a deliberate choice corrupts a quarter of the
    // attribution data before anyone notices it is happening.
    const { url } = tagUrl('https://example.com/p?utm_source=newsletter', BASE)
    expect(url).toContain('utm_source=newsletter')
    expect(url).not.toContain('mastodon')
    // The parameters that were NOT specified are still added.
    expect(url).toContain('utm_medium=social')
  })

  it('preserves the fragment', () => {
    const { url } = tagUrl('https://example.com/p#section', BASE)
    expect(url).toContain('#section')
    expect(url).toContain('utm_source=mastodon')
  })

  it('leaves a non-http scheme alone', () => {
    expect(tagUrl('mailto:someone@example.com', BASE)).toEqual({
      url: 'mailto:someone@example.com',
      changed: false,
    })
  })

  it('leaves an unparseable string alone rather than throwing', () => {
    expect(tagUrl('not a url', BASE).changed).toBe(false)
  })

  it('skips empty values instead of emitting an empty parameter', () => {
    const { url } = tagUrl('https://example.com', { ...BASE, campaign: '' })
    expect(url).not.toContain('utm_campaign')
  })

  it('returns the original string untouched when nothing changed', () => {
    // Not the URL normalised by href. Correct either way for a browser, but a
    // silent trailing slash appearing in a diff is a distraction.
    const input = 'https://example.com/p?utm_source=a&utm_medium=b'
    expect(tagUrl(input, BASE).url).toBe(input)
  })
})

describe('tagging text', () => {
  it('tags every link and counts them', () => {
    const result = tagText('One https://a.example and two https://b.example', BASE)
    expect(result.tagged).toBe(2)
    expect(result.text).toContain('a.example/?utm_source=mastodon')
    expect(result.text).toContain('b.example/?utm_source=mastodon')
  })

  it('leaves the surrounding text exactly as written', () => {
    const result = tagText('Read this: https://example.com/p. Thanks!', BASE)
    expect(result.text.startsWith('Read this: ')).toBe(true)
    expect(result.text.endsWith('. Thanks!')).toBe(true)
  })

  it('reports what it skipped and why', () => {
    const result = tagText('https://example.com/p?utm_source=x&utm_medium=y', BASE)
    expect(result.tagged).toBe(0)
    expect(result.skipped[0]!.reason).toMatch(/left as the author wrote them/)
  })

  it('does nothing to a post with no links', () => {
    const result = tagText('Just some words.', BASE)
    expect(result.text).toBe('Just some words.')
    expect(result.tagged).toBe(0)
  })
})

describe('presets', () => {
  it('resolves per-variant variables', () => {
    // The whole reason a preset is a template: utm_source differs by network,
    // which is what the parameter is for. One hard-coded "social" produces a
    // report saying traffic came from "social".
    const { params } = resolvePreset(
      { source: '{{network}}', medium: 'social', campaign: '{{campaign}}-{{month}}' },
      { network: 'bluesky', campaign: 'launch', month: '2026-08' }
    )
    expect(params.source).toBe('bluesky')
    expect(params.campaign).toBe('launch-2026-08')
  })

  it('drops a parameter it cannot resolve rather than emitting template syntax', () => {
    // An absent dimension is recoverable. A dimension polluted with "{{network}}"
    // has to be cleaned up in someone else's analytics, where we have no access.
    const { params, missing } = resolvePreset(
      { source: '{{network}}', medium: 'social' },
      {}
    )
    expect(params.source).toBe('')
    expect(missing).toEqual(['network'])
  })

  it('lists the variables a preset needs', () => {
    expect(
      presetVariables({ source: '{{network}}', medium: 'social', campaign: '{{campaign}}' })
    ).toEqual(['network', 'campaign'])
  })

  it('needs no variables when nothing is templated', () => {
    expect(presetVariables(BASE)).toEqual([])
  })
})
