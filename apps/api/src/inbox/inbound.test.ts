import { afterEach, describe, expect, it, vi } from 'vitest'
import { setProviderSettings } from '@smm/providers'
import { InboundController } from './inbound.controller.js'
import type { ConnectorSettingsService } from '../admin/connector-settings.service.js'

/**
 * Meta's subscription handshake.
 *
 * Worth testing on its own because it is the step that gates every inbound
 * event and it fails with a single opaque sentence on Meta's side — "The
 * callback URL or verify token couldn't be validated" covers a wrong token, an
 * unset token, an unreachable host and a typo in the path equally.
 */

/** The refresh is a no-op here; what matters is that the value is read after it. */
const settings = {
  refreshIfStale: vi.fn(async () => {}),
} as unknown as ConnectorSettingsService

const controller = new InboundController(settings)

afterEach(() => {
  setProviderSettings({})
  delete process.env['META_WEBHOOK_VERIFY_TOKEN']
  vi.clearAllMocks()
})

describe('the verify token comes from the settings store', () => {
  it('echoes the challenge when a UI-set token matches', async () => {
    // The case that was impossible before: set in the browser, no redeploy.
    setProviderSettings({ META_WEBHOOK_VERIFY_TOKEN: 'chosen-in-the-ui' })

    await expect(
      controller.verify('instagramLogin', 'subscribe', 'chosen-in-the-ui', 'CHALLENGE')
    ).resolves.toBe('CHALLENGE')
  })

  it('still accepts a token set only in the environment', async () => {
    // The old behaviour has to keep working; an existing install that set this
    // in .env must not break because the store learned a new key.
    process.env['META_WEBHOOK_VERIFY_TOKEN'] = 'from-env'

    await expect(
      controller.verify('instagramLogin', 'subscribe', 'from-env', 'C')
    ).resolves.toBe('C')
  })

  it('lets a UI value win over the environment', async () => {
    process.env['META_WEBHOOK_VERIFY_TOKEN'] = 'stale-env'
    setProviderSettings({ META_WEBHOOK_VERIFY_TOKEN: 'current-ui' })

    await expect(controller.verify('p', 'subscribe', 'current-ui', 'C')).resolves.toBe('C')
    await expect(controller.verify('p', 'subscribe', 'stale-env', 'C')).rejects.toThrow()
  })

  it('refreshes before reading, so a token set seconds ago is visible', async () => {
    // Without this the person sets the token, Meta retries immediately, and the
    // handshake fails against a cached copy that predates the write.
    setProviderSettings({ META_WEBHOOK_VERIFY_TOKEN: 't' })
    await controller.verify('p', 'subscribe', 't', 'C')

    expect(settings.refreshIfStale).toHaveBeenCalled()
  })
})

describe('what the handshake refuses', () => {
  it('refuses when no token is configured anywhere', async () => {
    // Must not pass on an empty expected value — that would let anyone who
    // guessed the URL subscribe.
    await expect(controller.verify('p', 'subscribe', '', 'C')).rejects.toThrow()
    await expect(controller.verify('p', 'subscribe', 'anything', 'C')).rejects.toThrow()
  })

  it('refuses a wrong token', async () => {
    setProviderSettings({ META_WEBHOOK_VERIFY_TOKEN: 'right' })
    await expect(controller.verify('p', 'subscribe', 'wrong', 'C')).rejects.toThrow()
  })

  it('refuses a mode other than subscribe', async () => {
    setProviderSettings({ META_WEBHOOK_VERIFY_TOKEN: 'right' })
    await expect(controller.verify('p', 'unsubscribe', 'right', 'C')).rejects.toThrow()
  })

  it('answers 404 rather than saying which part was wrong', async () => {
    // An attacker probing for a live endpoint should not learn whether the path
    // exists or the token was merely incorrect.
    setProviderSettings({ META_WEBHOOK_VERIFY_TOKEN: 'right' })

    const wrongToken = await controller.verify('p', 'subscribe', 'no', 'C').catch((e: unknown) => e)
    const wrongMode = await controller.verify('p', 'unsubscribe', 'right', 'C').catch((e: unknown) => e)

    expect((wrongToken as { status?: number }).status).toBe(404)
    expect((wrongMode as { status?: number }).status).toBe(404)
  })
})
