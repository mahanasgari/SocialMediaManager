/**
 * Rich-text facets.
 *
 * Bluesky does NOT parse post text server-side. A URL, a @mention or a #hashtag
 * is inert plain text unless we send a facet alongside it describing where it
 * sits. Skip this and posts look fine in our composer and have dead links on
 * the network — the kind of bug nobody notices until a campaign underperforms.
 *
 * The offsets are into UTF-8 BYTES, not JavaScript string indices. That
 * distinction is the whole reason this file exists: `"café".length` is 4 but its
 * UTF-8 length is 5, so any emoji or accent before a link shifts every
 * subsequent byte offset. Computing offsets from string indices produces facets
 * that point at the wrong span, which either breaks the link or corrupts
 * neighbouring text.
 */

export type Facet = {
  index: { byteStart: number; byteEnd: number }
  features: Array<
    | { $type: 'app.bsky.richtext.facet#link'; uri: string }
    | { $type: 'app.bsky.richtext.facet#mention'; did: string }
    | { $type: 'app.bsky.richtext.facet#tag'; tag: string }
  >
}

const encoder = new TextEncoder()

/** UTF-8 byte length of a string. */
export function byteLength(text: string): number {
  return encoder.encode(text).length
}

/** Byte offset of a character index. */
export function byteOffsetOf(text: string, charIndex: number): number {
  return byteLength(text.slice(0, charIndex))
}

const URL_RE = /https?:\/\/[^\s<>()[\]{}"']+/g
const TAG_RE = /(^|\s)(#[^\d\s][^\s#]*)/g

export function detectFacets(text: string): Facet[] {
  const facets: Facet[] = []

  for (const match of text.matchAll(URL_RE)) {
    if (match.index === undefined) continue
    // Trailing punctuation is almost always sentence punctuation rather than
    // part of the URL. Including it produces a link that 404s.
    const raw = match[0].replace(/[.,;:!?)]+$/, '')
    facets.push({
      index: {
        byteStart: byteOffsetOf(text, match.index),
        byteEnd: byteOffsetOf(text, match.index + raw.length),
      },
      features: [{ $type: 'app.bsky.richtext.facet#link', uri: raw }],
    })
  }

  for (const match of text.matchAll(TAG_RE)) {
    if (match.index === undefined) continue
    const tag = match[2]!
    const start = match.index + match[1]!.length
    facets.push({
      index: {
        byteStart: byteOffsetOf(text, start),
        byteEnd: byteOffsetOf(text, start + tag.length),
      },
      features: [{ $type: 'app.bsky.richtext.facet#tag', tag: tag.slice(1) }],
    })
  }

  // Mentions are deliberately NOT detected here: a mention facet needs the
  // target's DID, which requires a network lookup, and this function is pure so
  // the composer can preview facets without making requests. An undetected
  // mention renders as plain text — visibly imperfect, which is far better than
  // a facet pointing at the wrong account.

  return facets.sort((a, b) => a.index.byteStart - b.index.byteStart)
}
