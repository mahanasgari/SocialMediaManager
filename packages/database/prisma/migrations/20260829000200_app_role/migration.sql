-- The application must NOT connect as a superuser, or RLS is silently a no-op.
--
-- This migration exists because of a real failure caught by the isolation suite.
-- The previous migration enabled RLS and set FORCE ROW LEVEL SECURITY on every
-- tenant table, and `pg_policies` confirmed all four policies were present — yet
-- raw SQL still returned every tenant's rows.
--
-- The reason: FORCE removes the TABLE OWNER's exemption from RLS. It does
-- nothing about superusers. A superuser, or any role with BYPASSRLS, ignores row
-- security entirely and no table-level setting can change that. The official
-- postgres image creates POSTGRES_USER as a superuser, so the default
-- docker-compose connection bypassed every policy while looking perfectly
-- configured from the outside.
--
-- "Looks enabled but isn't" is the worst state a security control can be in, so
-- there are now two defences:
--
--   1. This role — an unprivileged identity the application connects as.
--   2. A boot-time assertion (packages/database/src/rls-assert.ts) that refuses
--      to start if the connected role can bypass RLS. Configuration can drift;
--      an assertion against actual behaviour cannot be quietly wrong.
--
-- Migrations continue to run as the owner. Only the application runtime uses
-- this role.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'smm_app') THEN
    -- NOLOGIN: this is a privilege set, not an identity. Deployment grants it to
    -- whatever login role it uses, so no password ever lives in a migration.
    CREATE ROLE smm_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  ELSE
    -- Defensive: if the role already exists, make sure it has not been granted
    -- the two attributes that would defeat the entire mechanism.
    ALTER ROLE smm_app NOSUPERUSER NOBYPASSRLS;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO smm_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO smm_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO smm_app;

-- Tables created by FUTURE migrations must be reachable too. Without this, every
-- new model would silently be invisible to the application until someone
-- remembered to re-grant — and the symptom would be a permission error in
-- production long after the migration looked fine locally.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO smm_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO smm_app;
