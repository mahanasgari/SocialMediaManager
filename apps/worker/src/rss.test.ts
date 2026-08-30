import { describe, expect, it } from 'vitest'
import { parseFeed, renderTemplate } from './rss.js'

/**
 * Feed parsing and templating.
 *
 * The SSRF tests moved to @smm/integrations with assertSafeUrl itself — the
 * check is shared with outbound webhooks, and a test that only covers one of
 * two callers is a test that lets the other regress.
 */

describe('feed parsing', () => {
  const rss = `<?xml version="1.0"?><rss><channel>
    <item>
      <title>First post</title>
      <link>https://example.com/1</link>
      <guid>https://example.com/1</guid>
      <pubDate>Wed, 27 Aug 2026 10:00:00 GMT</pubDate>
    </item>
    <item>
      <title><![CDATA[Second & <b>bold</b>]]></title>
      <link>https://example.com/2</link>
      <guid isPermaLink="false">tag:example,2026:2</guid>
    </item>
  </channel></rss>`

  const atom = `<?xml version="1.0"?><feed>
    <entry>
      <title>Atom entry</title>
      <link href="https://example.com/a1"/>
      <id>urn:uuid:1</id>
      <published>2026-08-27T10:00:00Z</published>
    </entry>
  </feed>`

  it('parses RSS items', () => {
    const items = parseFeed(rss)
    expect(items).toHaveLength(2)
    expect(items[0]).toMatchObject({ title: 'First post', link: 'https://example.com/1' })
  })

  it('unwraps CDATA and strips markup from titles', () => {
    // A title arriving with tags in it would otherwise be posted verbatim.
    expect(parseFeed(rss)[1]?.title).toBe('Second & bold')
  })

  it('parses Atom entries, whose link is an attribute', () => {
    const items = parseFeed(atom)
    expect(items[0]).toMatchObject({ title: 'Atom entry', link: 'https://example.com/a1' })
    expect(items[0]?.guid).toBe('urn:uuid:1')
  })

  it('parses dates, and tolerates a missing one', () => {
    expect(parseFeed(rss)[0]?.publishedAt).toBeInstanceOf(Date)
    expect(parseFeed(rss)[1]?.publishedAt).toBeNull()
  })

  it('ignores an item with no guid or title rather than posting a blank', () => {
    expect(parseFeed('<rss><channel><item><link>x</link></item></channel></rss>')).toHaveLength(0)
  })

  it('returns nothing for junk instead of throwing', () => {
    // A feed that stops parsing is a missed post, not an outage.
    expect(parseFeed('not xml at all')).toEqual([])
    expect(parseFeed('')).toEqual([])
  })

  it('caps how many items one fetch can produce', () => {
    const many = `<rss><channel>${'<item><title>t</title><guid>g</guid></item>'.repeat(200)}</channel></rss>`
    expect(parseFeed(many).length).toBeLessThanOrEqual(50)
  })
})

describe('templates', () => {
  const item = {
    guid: 'g',
    title: 'Shipping the scheduler',
    link: 'https://example.com/post',
    publishedAt: null,
  }

  it('substitutes title and link', () => {
    expect(renderTemplate('{{title}} {{link}}', item)).toBe(
      'Shipping the scheduler https://example.com/post'
    )
  })

  it('supports a template with extra copy', () => {
    expect(renderTemplate('New on the blog: {{title}} → {{link}}', item)).toBe(
      'New on the blog: Shipping the scheduler → https://example.com/post'
    )
  })

  it('leaves an unknown placeholder alone rather than emptying it', () => {
    expect(renderTemplate('{{title}} {{author}}', item)).toBe(
      'Shipping the scheduler {{author}}'
    )
  })
})
