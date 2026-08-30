import { describe, expect, it } from 'vitest'
import { byteLength, byteOffsetOf, detectFacets } from './facets.js'

const bytesOf = (s: string) => new TextEncoder().encode(s)

/** What Bluesky itself would slice out, given a facet. */
function sliceByFacet(text: string, byteStart: number, byteEnd: number): string {
  return new TextDecoder().decode(bytesOf(text).slice(byteStart, byteEnd))
}

describe('byte offsets', () => {
  it('matches character length for ASCII', () => {
    expect(byteLength('hello')).toBe(5)
  })

  it('diverges from character length for accents', () => {
    // 4 characters, 5 bytes. Every facet after this point shifts by one.
    expect('café'.length).toBe(4)
    expect(byteLength('café')).toBe(5)
  })

  it('diverges sharply for emoji', () => {
    expect(byteLength('👍')).toBe(4)
    expect(byteLength('👍🏽')).toBe(8)
  })

  it('computes an offset past multibyte characters', () => {
    expect(byteOffsetOf('café ', 5)).toBe(6)
  })
})

describe('link facets', () => {
  it('finds a plain URL', () => {
    const [facet] = detectFacets('See https://example.com for more')
    expect(facet?.features[0]).toMatchObject({
      $type: 'app.bsky.richtext.facet#link',
      uri: 'https://example.com',
    })
  })

  it('the byte span selects exactly the URL', () => {
    const text = 'See https://example.com for more'
    const [facet] = detectFacets(text)
    expect(sliceByFacet(text, facet!.index.byteStart, facet!.index.byteEnd)).toBe(
      'https://example.com'
    )
  })

  // THE bug this file exists to prevent.
  it('stays correct when emoji precede the link', () => {
    const text = '🎉👍🏽 launch day https://example.com/launch'
    const [facet] = detectFacets(text)
    expect(sliceByFacet(text, facet!.index.byteStart, facet!.index.byteEnd)).toBe(
      'https://example.com/launch'
    )
  })

  it('stays correct when accented text precedes the link', () => {
    const text = 'Café ouvert — https://example.com/menu'
    const [facet] = detectFacets(text)
    expect(sliceByFacet(text, facet!.index.byteStart, facet!.index.byteEnd)).toBe(
      'https://example.com/menu'
    )
  })

  it('excludes trailing sentence punctuation from the URL', () => {
    // Including the full stop produces a link that 404s.
    const [facet] = detectFacets('Read it at https://example.com/post.')
    expect(facet?.features[0]).toMatchObject({ uri: 'https://example.com/post' })
  })

  it('keeps a trailing slash, which is part of the URL', () => {
    const [facet] = detectFacets('https://example.com/blog/')
    expect(facet?.features[0]).toMatchObject({ uri: 'https://example.com/blog/' })
  })

  it('finds several links', () => {
    const text = 'a https://one.example b https://two.example'
    const facets = detectFacets(text)
    expect(facets).toHaveLength(2)
    expect(sliceByFacet(text, facets[1]!.index.byteStart, facets[1]!.index.byteEnd)).toBe(
      'https://two.example'
    )
  })
})

describe('hashtag facets', () => {
  it('finds a hashtag and strips the hash from the tag value', () => {
    const [facet] = detectFacets('Shipping today #launch')
    expect(facet?.features[0]).toMatchObject({
      $type: 'app.bsky.richtext.facet#tag',
      tag: 'launch',
    })
  })

  it('does not treat a URL fragment as a hashtag', () => {
    const facets = detectFacets('https://example.com/page#section')
    expect(facets.filter((f) => f.features[0]?.$type.endsWith('#tag'))).toHaveLength(0)
  })

  it('ignores a bare number, which is not a tag', () => {
    expect(detectFacets('costs #100')).toHaveLength(0)
  })

  it('spans the tag correctly after multibyte text', () => {
    const text = '🚀 déjà vu #again'
    const [facet] = detectFacets(text)
    expect(sliceByFacet(text, facet!.index.byteStart, facet!.index.byteEnd)).toBe('#again')
  })
})

describe('ordering and purity', () => {
  it('returns facets sorted by byte start', () => {
    const facets = detectFacets('#first then https://example.com then #second')
    const starts = facets.map((f) => f.index.byteStart)
    expect(starts).toEqual([...starts].sort((a, b) => a - b))
  })

  it('is pure — the same text yields the same facets', () => {
    const text = 'hello https://example.com #tag'
    expect(detectFacets(text)).toEqual(detectFacets(text))
  })

  it('returns nothing for plain text', () => {
    expect(detectFacets('just some words')).toEqual([])
  })

  it('does not emit mention facets', () => {
    // A mention facet needs the target's DID, which requires a network lookup.
    // This function is pure so the composer can preview without requests; an
    // undetected mention renders as plain text, which is visibly imperfect and
    // far better than a facet pointing at the wrong account.
    expect(detectFacets('hello @someone.bsky.social')).toEqual([])
  })
})
