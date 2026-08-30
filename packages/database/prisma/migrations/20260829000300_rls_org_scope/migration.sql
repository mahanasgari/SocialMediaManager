-- Organization-scoped access under RLS.
--
-- The first RLS migration keyed every policy on `app.current_workspace` alone.
-- That is correct for reads inside a workspace, but it makes two legitimate
-- operations impossible:
--
--   1. CREATING a workspace. The policy checks the row's own id against the
--      current workspace setting — but the id does not exist until the insert
--      happens, so there is no value to set beforehand. A workspace could never
--      be created at all.
--
--   2. Listing across a workspace boundary. "All members of this organization"
--      and "every workspace I can see" are organization-level questions with no
--      single workspace answer.
--
-- So there is a second setting, `app.current_organization`, and the policies
-- accept either. Both are still set with set_config(..., true) — transaction
-- local, rolled back at commit, safe under pgBouncer transaction pooling.
--
-- WITH CHECK is deliberately NARROWER than USING on Workspace: a row may be READ
-- under either scope, but may only be WRITTEN under an organization scope. A
-- workspace scope must not be able to move a workspace into a different
-- organization.

-- Workspace ------------------------------------------------------------------
DROP POLICY IF EXISTS workspace_tenant_isolation ON "Workspace";
CREATE POLICY workspace_tenant_isolation ON "Workspace"
  USING (
    "id"::text = current_setting('app.current_workspace', true)
    OR "organizationId"::text = current_setting('app.current_organization', true)
  )
  WITH CHECK (
    "organizationId"::text = current_setting('app.current_organization', true)
  );

-- Membership -----------------------------------------------------------------
DROP POLICY IF EXISTS membership_tenant_isolation ON "Membership";
CREATE POLICY membership_tenant_isolation ON "Membership"
  USING (
    "workspaceId"::text = current_setting('app.current_workspace', true)
    OR "organizationId"::text = current_setting('app.current_organization', true)
  )
  WITH CHECK (
    "workspaceId"::text = current_setting('app.current_workspace', true)
    OR "organizationId"::text = current_setting('app.current_organization', true)
  );

-- Invite ---------------------------------------------------------------------
DROP POLICY IF EXISTS invite_tenant_isolation ON "Invite";
CREATE POLICY invite_tenant_isolation ON "Invite"
  USING (
    "workspaceId"::text = current_setting('app.current_workspace', true)
    OR "organizationId"::text = current_setting('app.current_organization', true)
  )
  WITH CHECK (
    "workspaceId"::text = current_setting('app.current_workspace', true)
    OR "organizationId"::text = current_setting('app.current_organization', true)
  );

-- AuditLog -------------------------------------------------------------------
DROP POLICY IF EXISTS auditlog_tenant_isolation ON "AuditLog";
CREATE POLICY auditlog_tenant_isolation ON "AuditLog"
  USING (
    "workspaceId"::text = current_setting('app.current_workspace', true)
    OR "organizationId"::text = current_setting('app.current_organization', true)
  )
  WITH CHECK (
    "workspaceId"::text = current_setting('app.current_workspace', true)
    OR "organizationId"::text = current_setting('app.current_organization', true)
  );
