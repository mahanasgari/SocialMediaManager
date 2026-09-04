import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  createTestClient,
  encrypt,
  keyProvider,
  withConnectorSettings,
  withConnectorSettingsWrite,
  withSystemScope,
  type Db,
} from '@smm/database'
import { loadConnectorSettings } from '@smm/publishing'
import { clearProviderSettings, providerSetting, registry } from '@smm/providers'

/**
 * Connector settings against a real database.
 *
 * Three things can only be proven here, and each has already failed silently
 * somewhere in this codebase in a way unit tests could not see.
 *
 * THE RLS GRANTS. Six times now a cross-cutting query that legitimately runs
 * before any tenancy has returned zero rows under row-level security while
 * nothing errored. A settings table that reads as empty would present as every
 * connector having been mysteriously unconfigured — with the rows plainly
 * visible in psql.
 *
 * THE ACTOR SPLIT. The read actor must NOT be able to write. That is the whole
 * reason there are two, and a policy that grants more than intended looks
 * identical to one that does not until something tries.
 *
 * THE ROUND TRIP. Encrypt, store, load, decrypt, and have an adapter report
 * itself configured — the actual sequence an administrator triggers by typing a
 * secret into a form.
 */

const dbUrl = process.env['TEST_DATABASE_URL']
const ownerUrl = process.env['TEST_DATABASE_OWNER_URL'] ?? dbUrl

const suite = dbUrl ? describe : describe.skip
if (!dbUrl) console.warn('\n  [skipped] connector settings — run: bash scripts/test-db.sh up\n')

/**
 * Whatever the deployment already had, held for the duration.
 *
 * These rows are keyed by setting NAME — META_APP_ID and friends — so a test
 * writing META_APP_ID writes the same row a real deployment uses. There is no
 * separate namespace to hide in. Wiping the table between tests therefore
 * destroys real configuration, which is exactly what happened: several runs of
 * this suite silently deleted an operator's stored Meta and Google credentials,
 * and the only symptom was two connectors quietly reverting to "needs
 * credentials".
 *
 * So the suite borrows the table and gives it back.
 */
let saved: Array<{
  key: string
  value: string
  keyId: string
  hint: string
  updatedById: string | null
}> = []

let owner: Db
let app: Db

suite('connector settings, end to end', () => {
  beforeAll(() => {
    // TWO connections, and the distinction is the entire point of the RLS
    // assertions below. `owner` is the migration role — a superuser, which
    // bypasses row-level security unconditionally, FORCE or no FORCE. Running
    // these tests as the owner would make every policy silently inert while
    // pg_policies still listed them all. `app` is what the deployment actually
    // connects as.
    owner = createTestClient(ownerUrl!)
    app = createTestClient(dbUrl!)

    // The wrappers default to db(), so the code under test must reach the
    // unprivileged role too.
    process.env['DATABASE_URL'] = dbUrl!
    // Same 32-byte test key the other integration suites use. The real one
    // comes from the environment; keyProvider() refuses to run without it,
    // which is the behaviour we want and the reason it has to be set here.
    process.env['ENCRYPTION_KEY'] ??= Buffer.alloc(32, 7).toString('base64')
  })

  beforeAll(async () => {
    saved = await withSystemScope('connector settings backup', async () =>
      owner.providerSetting.findMany({
        select: { key: true, value: true, keyId: true, hint: true, updatedById: true },
      })
    )
  })

  afterEach(async () => {
    await withSystemScope('connector settings test reset', async () => {
      await owner.providerSetting.deleteMany({})
    })
    clearProviderSettings()
  })

  afterAll(async () => {
    // Put the deployment's own rows back, verbatim.
    await withSystemScope('connector settings restore', async () => {
      await owner.providerSetting.deleteMany({})
      for (const row of saved) {
        await owner.providerSetting.create({ data: row })
      }
    })
    await Promise.all([owner.$disconnect(), app.$disconnect()])
  }, 30_000)

  /** What the admin controller does, without going through HTTP. */
  async function save(key: string, value: string): Promise<void> {
    const keys = keyProvider()
    await withConnectorSettingsWrite(async (tx) => {
      const data = {
        value: encrypt(value, keys),
        keyId: keys.current().keyId,
        hint: '••••' + value.slice(-4),
      }
      await tx.providerSetting.upsert({ where: { key }, create: { key, ...data }, update: data })
    })
  }

  it('a saved credential reaches the adapter that needs it', async () => {
    // Through the registry, which is how the API and worker reach it — a
    // freshly constructed adapter would prove less.
    const linkedin = registry.get('linkedin')!
    clearProviderSettings()
    delete process.env['LINKEDIN_CLIENT_ID']
    delete process.env['LINKEDIN_CLIENT_SECRET']
    expect(linkedin.isConfigured()).toBe(false)

    await save('LINKEDIN_CLIENT_ID', 'the-client-id')
    await save('LINKEDIN_CLIENT_SECRET', 'the-client-secret')

    const result = await loadConnectorSettings()
    // The two keys THIS test wrote, not a count of the whole table. A
    // deployment's own rows share this table — there is no separate namespace
    // for tests — so a global count asserts on state the test does not own and
    // fails the moment an operator has configured anything.
    expect(result.loaded).toBeGreaterThanOrEqual(2)
    expect(result.unreadable).toEqual([])

    // The whole point: same process, no restart, connector now usable.
    expect(linkedin.isConfigured()).toBe(true)
    expect(providerSetting('LINKEDIN_CLIENT_SECRET')).toBe('the-client-secret')
  })

  it('stores the value encrypted, not as text', async () => {
    // An operator who can read the database must not thereby hold every app
    // secret. Asserting on the stored column rather than on the API response,
    // because the API could be masking a plaintext column and look identical.
    await save('META_APP_SECRET', 'super-secret-value')

    const row = await withConnectorSettings(async (tx) =>
      tx.providerSetting.findUniqueOrThrow({ where: { key: 'META_APP_SECRET' } })
    )

    expect(row.value).not.toContain('super-secret-value')
    expect(row.value.length).toBeGreaterThan('super-secret-value'.length)
    // The hint is the only thing derived from the plaintext, and it is a
    // suffix — enough to recognise the value, useless for reconstructing it.
    expect(row.hint).toBe('••••alue')
  })

  it('the read actor cannot write', async () => {
    // The reason there are two actors rather than one. Every process reads
    // these at boot; exactly one code path writes one. If the read grant also
    // permitted UPDATE, the analytics job polling Instagram every fifteen
    // minutes would hold write access to the credential authorising it.
    await expect(
      withConnectorSettings(async (tx) =>
        tx.providerSetting.create({
          data: { key: 'META_APP_ID', value: 'x', keyId: 'k1', hint: 'x' },
        })
      )
    ).rejects.toThrow()

    const rows = await withConnectorSettings(async (tx) => tx.providerSetting.findMany())
    expect(rows).toEqual([])
  })

  it('reads nothing at all without an actor', async () => {
    await save('META_APP_ID', 'visible-with-the-actor')

    // No set_config, so no policy matches. This is the failure mode that has
    // bitten this codebase six times: not an error, just an empty result.
    const rows = await app.$queryRawUnsafe<unknown[]>('SELECT * FROM "ProviderSetting"')
    expect(rows).toEqual([])

    const withActor = await withConnectorSettings(async (tx) => tx.providerSetting.findMany())
    expect(withActor).toHaveLength(1)
  })

  it('one unreadable row does not lose the others', async () => {
    // Happens for exactly one reason worth handling: the KEK was rotated and
    // the old one was not kept. Booting with no credentials and no explanation
    // would be much worse than carrying on with what is still readable.
    await save('META_APP_ID', 'readable')

    await withConnectorSettingsWrite(async (tx) => {
      await tx.providerSetting.create({
        data: {
          key: 'META_APP_SECRET',
          // Well-formed envelope, key this process has never seen.
          value: JSON.stringify({
            v: 1,
            keyId: 'a-key-from-another-installation',
            iv: 'AAAAAAAAAAAAAAAA',
            tag: 'AAAAAAAAAAAAAAAAAAAAAA==',
            ciphertext: 'AAAA',
          }),
          keyId: 'a-key-from-another-installation',
          hint: '••••????',
        },
      })
    })

    const result = await loadConnectorSettings()
    expect(result.unreadable).toEqual(['META_APP_SECRET'])
    expect(providerSetting('META_APP_ID')).toBe('readable')
  })

  it('clearing a stored value stops it overriding on the next load', async () => {
    await save('META_APP_ID', 'from-ui')
    await loadConnectorSettings()
    expect(providerSetting('META_APP_ID')).toBe('from-ui')

    await withConnectorSettingsWrite(async (tx) => {
      await tx.providerSetting.deleteMany({ where: { key: 'META_APP_ID' } })
    })
    await loadConnectorSettings()

    // Not merely absent from the map — actually no longer in force. A merging
    // load would leave the deleted value applied until the process restarted.
    expect(providerSetting('META_APP_ID')).toBeUndefined()
  })

  it('a later save replaces the earlier value rather than accumulating rows', async () => {
    // The key is the primary key, so the upsert has to be an upsert. A second
    // row for the same key would make which credential is in force depend on
    // row order.
    await save('META_APP_ID', 'first-value')
    await save('META_APP_ID', 'second-value')

    await loadConnectorSettings()
    expect(providerSetting('META_APP_ID')).toBe('second-value')

    const rows = await withConnectorSettings(async (tx) =>
      tx.providerSetting.findMany({ where: { key: 'META_APP_ID' } })
    )
    expect(rows).toHaveLength(1)
  })
})
