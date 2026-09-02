import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  PROVIDER_SETTING_KEYS,
  clearProviderSettings,
  isProviderSettingKey,
  providerSetting,
  settingSource,
  setProviderSettings,
  settingsAge,
} from './settings.js'
import { LinkedInProvider } from './linkedin/adapter.js'
import { metaApp } from './meta/graph.js'

/**
 * Where a connector credential comes from.
 *
 * Small surface, but it decides whether a provider is usable, so the cases
 * worth testing are the ones where the two sources disagree.
 */

const TOUCHED = ['LINKEDIN_CLIENT_ID', 'LINKEDIN_CLIENT_SECRET', 'META_APP_ID', 'META_APP_SECRET']

describe('connector settings', () => {
  const original = new Map<string, string | undefined>()

  beforeEach(() => {
    for (const key of TOUCHED) {
      original.set(key, process.env[key])
      delete process.env[key]
    }
    clearProviderSettings()
  })

  afterEach(() => {
    for (const [key, value] of original) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    clearProviderSettings()
  })

  it('falls back to the environment when nothing was set through the UI', () => {
    process.env['META_APP_ID'] = 'from-env'
    expect(providerSetting('META_APP_ID')).toBe('from-env')
    expect(settingSource('META_APP_ID')).toBe('environment')
  })

  it('prefers a UI value over the environment', () => {
    // The administrator typed a new value into a form. If the environment won,
    // the screen would show the change saved and nothing would behave
    // differently — with no way for them to find out why.
    process.env['META_APP_ID'] = 'from-env'
    setProviderSettings({ META_APP_ID: 'from-ui' })

    expect(providerSetting('META_APP_ID')).toBe('from-ui')
    expect(settingSource('META_APP_ID')).toBe('ui')
  })

  it('reveals the environment again when the UI value is cleared', () => {
    // Clearing an override does not necessarily leave the key unset, and the
    // screen has to be able to say so.
    process.env['META_APP_ID'] = 'from-env'
    setProviderSettings({ META_APP_ID: 'from-ui' })
    setProviderSettings({})

    expect(providerSetting('META_APP_ID')).toBe('from-env')
    expect(settingSource('META_APP_ID')).toBe('environment')
  })

  it('replaces wholesale rather than merging', () => {
    // A key deleted in the database must stop overriding on the next load. A
    // merge would leave the removed value in force until the process restarted.
    setProviderSettings({ META_APP_ID: 'a', META_APP_SECRET: 'b' })
    setProviderSettings({ META_APP_ID: 'a' })

    expect(providerSetting('META_APP_SECRET')).toBeUndefined()
    expect(settingSource('META_APP_SECRET')).toBe('unset')
  })

  it('treats an empty string as absent, from either source', () => {
    // A cleared form field arrives as ''. An empty client secret is not a
    // credential — it is the absence of one — and isConfigured() must agree,
    // or the connector reports itself ready and fails at the first call.
    setProviderSettings({ META_APP_ID: '' })
    expect(providerSetting('META_APP_ID')).toBeUndefined()

    process.env['META_APP_SECRET'] = ''
    expect(providerSetting('META_APP_SECRET')).toBeUndefined()
  })

  it('reports unset when neither source has a value', () => {
    expect(providerSetting('META_APP_ID')).toBeUndefined()
    expect(settingSource('META_APP_ID')).toBe('unset')
  })

  it('tracks how stale the loaded copy is', () => {
    // The API uses this to decide whether to reload before serving a request
    // that depends on the values.
    expect(settingsAge()).toBeNull()
    setProviderSettings({})
    expect(settingsAge()).toBeGreaterThanOrEqual(0)
  })

  it('allowlists the keys that may be written', () => {
    // The key is a path parameter. Without a fixed list,
    // PUT /connector-settings/DATABASE_URL looks like an ordinary request.
    expect(isProviderSettingKey('META_APP_SECRET')).toBe(true)
    expect(isProviderSettingKey('DATABASE_URL')).toBe(false)
    expect(isProviderSettingKey('ENCRYPTION_KEY')).toBe(false)
    expect(isProviderSettingKey('')).toBe(false)
  })

  it('declares every key exactly once, against a real provider', () => {
    const keys = PROVIDER_SETTING_KEYS.map((entry) => entry.key)
    expect(new Set(keys).size).toBe(keys.length)

    // A key naming a provider that does not exist would render a settings card
    // for a connector nobody can connect.
    const providers = new Set(PROVIDER_SETTING_KEYS.map((entry) => entry.provider))
    for (const provider of providers) {
      expect(['facebook', 'instagram', 'pinterest', 'youtube', 'tiktok', 'linkedin', 'telegram']).toContain(
        provider
      )
    }
  })

  it('changes what an adapter reports without a restart', () => {
    // The point of the whole mechanism: isConfigured() is synchronous and reads
    // through this, so saving a credential makes a connector usable in the same
    // process that was told it was unconfigured a moment earlier.
    const linkedin = new LinkedInProvider()
    expect(linkedin.isConfigured()).toBe(false)

    setProviderSettings({ LINKEDIN_CLIENT_ID: 'id', LINKEDIN_CLIENT_SECRET: 'secret' })
    expect(linkedin.isConfigured()).toBe(true)

    setProviderSettings({ LINKEDIN_CLIENT_ID: 'id' })
    // Half a credential is not a credential.
    expect(linkedin.isConfigured()).toBe(false)
  })

  it('feeds the shared Meta app used by both Facebook and Instagram', () => {
    expect(metaApp()).toBeNull()
    setProviderSettings({ META_APP_ID: 'app', META_APP_SECRET: 'shh' })
    expect(metaApp()).toEqual({ appId: 'app', appSecret: 'shh' })
  })
})
