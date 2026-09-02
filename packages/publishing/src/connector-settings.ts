import { decrypt, keyProvider, withConnectorSettings } from '@smm/database'
import { setProviderSettings } from '@smm/providers'

/**
 * Loading operator-set connector credentials into the adapters.
 *
 * The adapters ask a SYNCHRONOUS function (`providerSetting`) for a value, and
 * a synchronous function cannot await a query. So the values live in process
 * memory, and something has to put them there. This is that something.
 *
 * It lives in @smm/publishing for a boundary reason rather than a thematic one.
 * @smm/providers must not import @smm/database — it is the package the browser
 * reaches through the capabilities subpath, and giving it a Prisma client would
 * end that. @smm/database must not import @smm/providers either, or the
 * dependency graph has a cycle. @smm/publishing is the package that already
 * depends on both, so it is the only legal place for the edge, and putting it
 * here keeps ONE implementation rather than one in the API and a second in the
 * worker that drifts.
 */
export type LoadResult = {
  /** How many overrides are now in force. */
  loaded: number
  /** Keys whose stored value could not be decrypted, if any. */
  unreadable: string[]
}

export async function loadConnectorSettings(): Promise<LoadResult> {
  const rows = await withConnectorSettings(async (tx) =>
    tx.providerSetting.findMany({ select: { key: true, value: true } })
  )

  const keys = keyProvider()
  const values: Record<string, string> = {}
  const unreadable: string[] = []

  for (const row of rows) {
    try {
      values[row.key] = decrypt(row.value, keys)
    } catch {
      // One unreadable row must not take the others down with it.
      //
      // This happens for exactly one reason worth handling — the KEK was
      // rotated and the old one was not kept in ENCRYPTION_KEY_PREVIOUS — and
      // the useful behaviour is to carry on with what is still readable and
      // report which key needs re-entering. Throwing here would boot a process
      // with no credentials at all and no explanation of why.
      unreadable.push(row.key)
    }
  }

  // Replaces wholesale rather than merging, so a key deleted in the database
  // stops overriding the environment on the next load. A merge would leave a
  // cleared value in force until the process restarted, which is precisely the
  // bug the settings screen exists to avoid.
  setProviderSettings(values)

  return { loaded: Object.keys(values).length, unreadable }
}
