import { describe, expect, it } from 'vitest'
import * as registry from './registry.js'

/**
 * Which surface a post targets.
 *
 * This existed as the literal string 'feed' in two places in the API — the
 * validate endpoint and the variant writer — and eleven of twenty-six
 * connectors have no feed at all. Instagram publishes to feedImage, reel or
 * story; YouTube to feedVideo or short; Pinterest to pin; Medium, WordPress,
 * Blogger and WeChat to article.
 *
 * The failure was silent in both directions. `provider.text['feed']` returned
 * undefined, so those channels showed no character limit and were validated
 * against nothing — a 5,000-character Instagram caption passed the composer
 * and would be refused at publish time. And variants were written with a
 * surface the provider does not have, so they stayed unvalidatable for life.
 */
describe('every provider has a usable default surface', () => {
  const providers = registry.all()

  it('names a surface it actually declares a media profile for', () => {
    for (const provider of providers) {
      const surface = registry.defaultSurfaceOf(provider)
      expect(
        Object.keys(provider.media),
        `${provider.id} defaults to "${surface}", which it has no media profile for`
      ).toContain(surface)
    }
  })

  it('names a surface it declares a TEXT profile for', () => {
    // Both profiles are keyed by surface, and the composer reads the text one
    // for its character limit. A default present in media but missing from text
    // would put the limit back to null for that connector.
    for (const provider of providers) {
      const surface = registry.defaultSurfaceOf(provider)
      expect(
        Object.keys(provider.text),
        `${provider.id} has no text profile for its default surface "${surface}"`
      ).toContain(surface)
    }
  })

  it('reports a character limit for every connector', () => {
    // The symptom anyone would notice: no counter in the composer. Stories are
    // the honest exception — Instagram and Snapchat stories carry no caption,
    // so their limit is genuinely 0 rather than unknown.
    for (const provider of providers) {
      const surface = registry.defaultSurfaceOf(provider)
      const limit = provider.text[surface]?.maxLength
      expect(typeof limit, `${provider.id} exposes no maxLength for "${surface}"`).toBe('number')
    }
  })

  it('picks the surface the connector leads with, not alphabetically', () => {
    // Order in the profile is the author's statement of what the connector is
    // mainly for. Instagram leads with feedImage rather than reel or story.
    const instagram = providers.find((p) => p.id === 'instagram')
    expect(instagram && registry.defaultSurfaceOf(instagram)).toBe('feedImage')

    const youtube = providers.find((p) => p.id === 'youtube')
    expect(youtube && registry.defaultSurfaceOf(youtube)).toBe('feedVideo')

    const pinterest = providers.find((p) => p.id === 'pinterest')
    expect(pinterest && registry.defaultSurfaceOf(pinterest)).toBe('pin')
  })

  it('is exposed on the descriptor the UI renders from', () => {
    // The composer must not re-derive this. One place decides, and it is the
    // same place the API validates against.
    for (const provider of providers) {
      const described = registry.describe(provider)
      expect(described.defaultSurface).toBe(registry.defaultSurfaceOf(provider))
      expect(described.surfaces).toContain(described.defaultSurface)
    }
  })
})
