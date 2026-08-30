import { describe, expect, it } from 'vitest'
import { assertSafeUrl, isPrivateAddress, UnsafeFeedUrl } from './url-safety.js'

/**
 * Shared by RSS ingestion and outbound webhooks — both take a URL from a user
 * and cause a server-side request to it.
 */

describe('SSRF defence', () => {
  it('allows an ordinary public feed', () => {
    expect(assertSafeUrl('https://example.com/feed.xml').hostname).toBe('example.com')
  })

  it.each([
    ['loopback', 'http://127.0.0.1/feed'],
    ['localhost by name', 'http://localhost:8080/feed'],
    ['a .localhost subdomain', 'http://api.localhost/feed'],
    ['private class A', 'http://10.1.2.3/feed'],
    ['private class B', 'http://172.20.0.5/feed'],
    ['private class C', 'http://192.168.1.1/feed'],
    ['IPv6 loopback', 'http://[::1]/feed'],
    ['a .internal name', 'http://db.internal/feed'],
  ])('rejects %s', (_label, url) => {
    expect(() => assertSafeUrl(url)).toThrow(UnsafeFeedUrl)
  })

  it('rejects the cloud metadata endpoint specifically', () => {
    // 169.254.169.254 is the single highest-value SSRF target on any cloud host:
    // it hands out instance credentials to anything that can reach it.
    expect(() => assertSafeUrl('http://169.254.169.254/latest/meta-data/')).toThrow(UnsafeFeedUrl)
  })

  it.each(['file:///etc/passwd', 'gopher://example.com', 'ftp://example.com/feed'])(
    'rejects the %s scheme',
    (url) => {
      expect(() => assertSafeUrl(url)).toThrow(/http and https/)
    }
  )

  it('rejects a malformed address rather than guessing', () => {
    expect(() => assertSafeUrl('not a url')).toThrow(UnsafeFeedUrl)
  })

  it('classifies address ranges correctly', () => {
    expect(isPrivateAddress('172.15.0.1')).toBe(false) // just below the private block
    expect(isPrivateAddress('172.16.0.1')).toBe(true)
    expect(isPrivateAddress('172.31.255.255')).toBe(true)
    expect(isPrivateAddress('172.32.0.1')).toBe(false) // just above
    expect(isPrivateAddress('8.8.8.8')).toBe(false)
  })

  it('does not mistake a public hostname containing digits for an IP', () => {
    expect(isPrivateAddress('10-things.example.com')).toBe(false)
  })
})
