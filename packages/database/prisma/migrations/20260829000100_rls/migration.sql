-- Row-level security: the backstop for tenant isolation.
--
-- The PRIMARY guard is the Prisma client extension (src/tenancy.ts), which
-- refuses to query a tenant-scoped model without a workspace scope. RLS exists
-- to catch what that extension cannot see: a $queryRaw, a hand-written query, or
-- any future code path that bypasses the client.
--
-- Two details that decide whether this works at all:
--
--   1. FORCE ROW LEVEL SECURITY. Postgres exempts a table's OWNER from RLS
--      unless FORCE is set. In the default compose the application connects as
--      the owner, so ENABLE alone would make every policy below a silent no-op
--      — the most dangerous possible outcome, because it looks enabled.
--
--   2. current_setting(..., true) returns NULL when the setting is absent, and
--      `col = NULL` is NULL, so rows are filtered out. Unset context therefore
--      means "see nothing", not "see everything". That is the safe direction.
--
-- The context is set with SET LOCAL, never SET, and only inside a transaction —
-- see src/tenancy.ts. SET would persist on a pooled connection and leak into the
-- next request that borrowed it, which is the exact cross-tenant leak this file
-- is meant to prevent. Because we only use SET LOCAL, pgBouncer transaction
-- pooling is safe; do not "fix" it back to session mode.

-- Workspace: the row's own id is the tenancy key.
ALTER TABLE "Workspace" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Workspace" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_tenant_isolation ON "Workspace"
  USING ("id"::text = current_setting('app.current_workspace', true))
  WITH CHECK ("id"::text = current_setting('app.current_workspace', true));

-- Membership: nullable workspaceId means an organization-wide membership, which
-- is not visible under a workspace context. Org-scoped reads go through the
-- client extension's organization scope instead.
ALTER TABLE "Membership" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Membership" FORCE ROW LEVEL SECURITY;
CREATE POLICY membership_tenant_isolation ON "Membership"
  USING ("workspaceId"::text = current_setting('app.current_workspace', true))
  WITH CHECK ("workspaceId"::text = current_setting('app.current_workspace', true));

ALTER TABLE "Invite" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Invite" FORCE ROW LEVEL SECURITY;
CREATE POLICY invite_tenant_isolation ON "Invite"
  USING ("workspaceId"::text = current_setting('app.current_workspace', true))
  WITH CHECK ("workspaceId"::text = current_setting('app.current_workspace', true));

ALTER TABLE "AuditLog" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AuditLog" FORCE ROW LEVEL SECURITY;
CREATE POLICY auditlog_tenant_isolation ON "AuditLog"
  USING ("workspaceId"::text = current_setting('app.current_workspace', true))
  WITH CHECK ("workspaceId"::text = current_setting('app.current_workspace', true));

-- Deliberately NOT under RLS, and why:
--
--   Organization, User, Session — not workspace-scoped. Cross-organization
--     isolation is enforced by membership checks in packages/auth plus the
--     client extension's organization scope.
--   Outbox — drained by a system principal that must scan across every
--     workspace. It carries workspaceId so the consumer can establish tenancy
--     context downstream, but the dispatcher itself is intentionally global.
--
-- Later phases add SocialAccount, OAuthCredential, MediaAsset, Post,
-- PostVariant, Conversation and Message to the list above. The isolation suite
-- enumerates tenant-scoped models from the Prisma DMMF, so forgetting one fails
-- CI rather than shipping quietly.
