import { describe, expect, it } from 'vitest'
import { CAPABILITY_KEYS, type CapabilityKey } from './capabilities/index.js'
import { declaredOperations, OPERATION_CLASSES, windowMs } from './limits.js'
import { MockProvider } from './mock/mock.provider.js'
import * as registry from './registry.js'
import type { AnyProvider } from './base.js'

/**
 * The shared provider contract suite — CI gates G1 and G2 for connectors.
 *
 * Every adapter must pass this. It runs over the REGISTRY rather than a
 * hand-written list, so registering a provider automatically subjects it to
 * these assertions and forgetting is not possible.
 */

const providers: AnyProvider[] = registry.all()

/** Capabilities that require a method of the same name to exist. */
const METHOD_FOR: Partial<Record<CapabilityKey, string>> = {
  retrievePosts: 'retrievePosts',
  deletePost: 'deletePost',
  editPost: 'editPost',
  revokeToken: 'revokeToken',
  comments: 'fetchComments',
  replies: 'replyToComment',
  dm: 'sendMessage',
  analytics: 'fetchPostMetrics',
  audienceAnalytics: 'fetchAudience',
  webhooks: 'verifyWebhook',
}

describe('registry', () => {
  it('has at least the mock provider, so nothing is ever developed blind', () => {
    expect(providers.length).toBeGreaterThan(0)
    expect(providers.some((p) => p.id === 'mock')).toBe(true)
  })
})

describe.each(providers.map((p) => [p.id, p] as const))('contract: %s', (_id, provider) => {
  // --- capability exhaustiveness -------------------------------------------

  it('declares a position on EVERY capability, with no partials', () => {
    // A silently-defaulted false on a provider that supports the feature is a
    // permanently invisible gap; a defaulted true is a dead button in the UI.
    for (const key of CAPABILITY_KEYS) {
      expect(
        typeof provider.capabilities[key],
        `${provider.id} does not declare "${key}"`
      ).toBe('boolean')
    }
  })

  it('declares no capability outside the taxonomy', () => {
    const known = new Set<string>(CAPABILITY_KEYS)
    for (const key of Object.keys(provider.capabilities)) {
      expect(known.has(key), `${provider.id} declares unknown capability "${key}"`).toBe(true)
    }
  })

  // --- bidirectional agreement ---------------------------------------------

  it('implements every method it claims', () => {
    for (const [capability, method] of Object.entries(METHOD_FOR)) {
      if (!provider.capabilities[capability as CapabilityKey]) continue
      expect(
        typeof (provider as unknown as Record<string, unknown>)[method],
        `${provider.id} declares ${capability}: true but has no ${method}()`
      ).toBe('function')
    }
  })

  it('exposes no method it does not claim', () => {
    // The reverse direction matters just as much: a half-implemented method
    // behind a `false` flag is how a dead button eventually reaches the UI, and
    // how a caller ends up depending on behaviour that was never finished.
    for (const [capability, method] of Object.entries(METHOD_FOR)) {
      if (provider.capabilities[capability as CapabilityKey]) continue
      expect(
        (provider as unknown as Record<string, unknown>)[method],
        `${provider.id} declares ${capability}: false but still exposes ${method}()`
      ).toBeUndefined()
    }
  })

  // --- gate G2: budgets -----------------------------------------------------

  it('declares a rate budget — a connector arrives with its limits or not at all', () => {
    const ops = declaredOperations(provider.limits)
    expect(ops.length, `${provider.id} declares no operation budgets`).toBeGreaterThan(0)
  })

  it('declares a publish budget, because publishing is the point', () => {
    expect(provider.limits.publish, `${provider.id} has no publish budget`).toBeDefined()
  })

  it('declares budget scope explicitly', () => {
    // Both mistakes are real: per-app budgets applied per-account exhaust the app
    // quota, and the reverse throttles everyone needlessly. There is no safe default.
    expect(['app', 'account', 'both']).toContain(provider.limits.scope)
  })

  it('uses parseable windows and positive costs', () => {
    for (const op of OPERATION_CLASSES) {
      const budget = provider.limits[op]
      if (!budget) continue
      expect(() => windowMs(budget.window)).not.toThrow()
      expect(budget.cost).toBeGreaterThan(0)
      expect(budget.budget).toBeGreaterThan(0)
      expect(['requests', 'quota']).toContain(budget.unit)
    }
  })

  it('limits publishes to one per account at a time', () => {
    // Prevents thread and reply ordering corruption where a second call can
    // overtake the first, and keeps reconciliation tractable: a stale IN_FLIGHT
    // attempt can then only ever have one candidate.
    expect(provider.limits.concurrency.perAccount).toBe(1)
  })

  // --- profiles -------------------------------------------------------------

  it('declares media and text profiles for the same surfaces', () => {
    const mediaSurfaces = Object.keys(provider.media)
    const textSurfaces = Object.keys(provider.text)
    expect(mediaSurfaces.length).toBeGreaterThan(0)
    for (const surface of mediaSurfaces) {
      expect(
        textSurfaces,
        `${provider.id} has a media profile for "${surface}" but no text profile`
      ).toContain(surface)
    }
  })

  it('validate() is pure — the same draft yields the same issues', () => {
    const draft = {
      surface: 'feed' as const,
      text: 'hello world',
      media: [],
    }
    expect(provider.validate(draft)).toEqual(provider.validate(draft))
  })

  // --- honesty --------------------------------------------------------------

  it('is in exactly one declared state', () => {
    expect(['implemented', 'skeleton', 'mock']).toContain(provider.state)
  })

  it('a skeleton is never reported as configured', () => {
    if (provider.state === 'skeleton') expect(provider.isConfigured()).toBe(false)
  })

  it('describe() gives a disabled provider a stated reason', () => {
    const descriptor = registry.describe(provider)
    if (!descriptor.configured || descriptor.state === 'skeleton') {
      expect(descriptor.disabledReason, `${provider.id} is disabled with no reason`).toBeTruthy()
    } else {
      expect(descriptor.disabledReason).toBeNull()
    }
  })
})

describe('withCapability guard', () => {
  it('throws before any network call when a capability is absent', async () => {
    const provider = new MockProvider()
    // Declared false in the mock's capability set.
    expect(provider.capabilities.story).toBe(false)

    const { withCapability, UnsupportedCapability } = await import('./base.js')
    expect(() => withCapability(provider, 'audienceAnalytics')).toThrow(UnsupportedCapability)
  })

  it('passes for a declared capability', async () => {
    const provider = new MockProvider()
    const { withCapability } = await import('./base.js')
    expect(() => withCapability(provider, 'dm')).not.toThrow()
  })
})
