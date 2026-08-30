import type { Db } from './client.js'

/**
 * Boot-time assertion that row-level security actually applies to us.
 *
 * This exists because of a failure that every configuration check reported as
 * fine. RLS was enabled, FORCE ROW LEVEL SECURITY was set, and all policies were
 * present in `pg_policies` — but the application connected as a superuser, and
 * superusers bypass row security unconditionally. FORCE only removes the table
 * OWNER's exemption; it has no effect on a superuser or a role with BYPASSRLS.
 *
 * Configuration can be inspected and still be wrong. Behaviour cannot. So this
 * checks the two role attributes that would defeat RLS entirely, and refuses to
 * start rather than run with a security control that is silently inert.
 */

export class RlsBypassDetected extends Error {
  override readonly name = 'RlsBypassDetected'

  constructor(role: string, reasons: string[]) {
    super(
      `The database role "${role}" can bypass row-level security (${reasons.join(', ')}). ` +
        `Tenant isolation policies would be silently ignored, and every workspace would be ` +
        `able to read every other workspace's data.\n\n` +
        `Connect as an unprivileged role instead. The migrations create "smm_app" for this; ` +
        `grant it to your login role and point DATABASE_URL at that role, keeping the owner ` +
        `credentials for MIGRATE_DATABASE_URL only. See SECURITY.md section 4.`
    )
  }
}

type RoleRow = { role: string; is_superuser: boolean; can_bypass_rls: boolean }

/**
 * Verifies the connected role cannot bypass RLS.
 *
 * `allowBypass` exists for the migration runner and for test fixtures that
 * legitimately need to set up cross-tenant data. It is deliberately a required,
 * explicit argument at those call sites rather than a default.
 */
export async function assertRlsApplies(client: Db, allowBypass = false): Promise<void> {
  const rows = await client.$queryRaw<RoleRow[]>`
    SELECT current_user AS role,
           rolsuper     AS is_superuser,
           rolbypassrls AS can_bypass_rls
    FROM pg_roles
    WHERE rolname = current_user
  `

  const row = rows[0]
  if (!row) return // Cannot determine; do not block startup on a missing catalog row.

  const reasons: string[] = []
  if (row.is_superuser) reasons.push('SUPERUSER')
  if (row.can_bypass_rls) reasons.push('BYPASSRLS')

  if (reasons.length > 0 && !allowBypass) {
    throw new RlsBypassDetected(row.role, reasons)
  }
}

/** Reports the bypass state without throwing — for the admin health panel. */
export async function rlsStatus(
  client: Db
): Promise<{ role: string; enforced: boolean; reasons: string[] }> {
  const rows = await client.$queryRaw<RoleRow[]>`
    SELECT current_user AS role,
           rolsuper     AS is_superuser,
           rolbypassrls AS can_bypass_rls
    FROM pg_roles
    WHERE rolname = current_user
  `
  const row = rows[0]
  if (!row) return { role: 'unknown', enforced: false, reasons: ['role not found in pg_roles'] }

  const reasons: string[] = []
  if (row.is_superuser) reasons.push('SUPERUSER')
  if (row.can_bypass_rls) reasons.push('BYPASSRLS')

  return { role: row.role, enforced: reasons.length === 0, reasons }
}
