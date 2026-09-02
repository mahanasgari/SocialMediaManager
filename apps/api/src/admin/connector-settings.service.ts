import { Injectable, Logger } from '@nestjs/common'
import { loadConnectorSettings } from '@smm/publishing'
import { settingsAge } from '@smm/providers'

/**
 * Keeping this API process's copy of the connector credentials current.
 *
 * The loading itself lives in @smm/publishing so the worker runs the same code
 * — see the comment there. What this adds is the API's answer to WHEN.
 *
 * Loading once at boot is not enough. An administrator who saves a Meta app
 * secret and immediately clicks Connect would hit a process that still believes
 * the connector is unconfigured, and the error would tell them to set the thing
 * they just set — advice that is not merely unhelpful but wrong. Reloading on
 * every request is the other extreme: a query in front of every OAuth redirect,
 * for a table that changes a handful of times in a deployment's whole life.
 *
 * So: load at boot, reload immediately after a write, and reload lazily when
 * the copy is stale at the two points that actually depend on it. The lazy path
 * exists for the multi-instance case — a write served by one API process leaves
 * every other one stale, and nothing else would ever tell them.
 */
@Injectable()
export class ConnectorSettingsService {
  private readonly logger = new Logger('connector-settings')

  /** How stale a copy may be before a read path reloads it. */
  private static readonly MAX_AGE_MS = 15_000

  /** Collapses a burst of concurrent requests into one reload. */
  private inFlight: Promise<void> | null = null

  async load(): Promise<void> {
    const result = await loadConnectorSettings()

    if (result.unreadable.length > 0) {
      this.logger.error(
        `Could not decrypt stored values for: ${result.unreadable.join(', ')}. ` +
          'They were encrypted with a key this process cannot read — re-enter them in ' +
          'Settings, or restore the previous key in ENCRYPTION_KEY_PREVIOUS. ' +
          'The environment is being used for those keys in the meantime.'
      )
    }
  }

  /** Reload if the in-memory copy is older than MAX_AGE_MS. Never throws. */
  async refreshIfStale(): Promise<void> {
    const age = settingsAge()
    if (age !== null && age < ConnectorSettingsService.MAX_AGE_MS) return
    if (this.inFlight) return this.inFlight

    this.inFlight = this.load()
      .catch((error: unknown) => {
        // A refresh failure must not fail the request that triggered it. The
        // process still holds the last good values, and serving those is
        // strictly better than a 500 on the provider list because the database
        // blipped for a second.
        this.logger.warn(`Connector settings refresh failed: ${String(error)}`)
      })
      .finally(() => {
        this.inFlight = null
      })

    return this.inFlight
  }
}
