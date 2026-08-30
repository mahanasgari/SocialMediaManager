-- Five models carried an organizationId that their RLS policy could not see.
--
-- The failure mode is the dangerous one: the Prisma tenancy extension ALLOWS an
-- organization-scoped query on a model with an organizationId column, the query
-- runs, RLS filters every row out, and the caller gets an empty result with no
-- error. An organization-wide count of webhooks returned 0 with rows plainly
-- present in the table.
--
-- Post and PostVariant already had the OR clause; these five were simply
-- missed. `models_have_org_clause` in the isolation suite now asserts the
-- invariant so it cannot drift again.

DROP POLICY IF EXISTS apikey_tenant_isolation ON "ApiKey";
CREATE POLICY apikey_tenant_isolation ON "ApiKey"
  USING (
    "workspaceId"::text = current_setting('app.current_workspace', true)
    OR "organizationId"::text = current_setting('app.current_organization', true)
  )
  WITH CHECK (
    "workspaceId"::text = current_setting('app.current_workspace', true)
    OR "organizationId"::text = current_setting('app.current_organization', true)
  );

DROP POLICY IF EXISTS conversation_tenant_isolation ON "Conversation";
CREATE POLICY conversation_tenant_isolation ON "Conversation"
  USING (
    "workspaceId"::text = current_setting('app.current_workspace', true)
    OR "organizationId"::text = current_setting('app.current_organization', true)
  )
  WITH CHECK (
    "workspaceId"::text = current_setting('app.current_workspace', true)
    OR "organizationId"::text = current_setting('app.current_organization', true)
  );

DROP POLICY IF EXISTS linkpage_tenant_isolation ON "LinkPage";
CREATE POLICY linkpage_tenant_isolation ON "LinkPage"
  USING (
    "workspaceId"::text = current_setting('app.current_workspace', true)
    OR "organizationId"::text = current_setting('app.current_organization', true)
  )
  WITH CHECK (
    "workspaceId"::text = current_setting('app.current_workspace', true)
    OR "organizationId"::text = current_setting('app.current_organization', true)
  );

DROP POLICY IF EXISTS rssfeed_tenant_isolation ON "RSSFeed";
CREATE POLICY rssfeed_tenant_isolation ON "RSSFeed"
  USING (
    "workspaceId"::text = current_setting('app.current_workspace', true)
    OR "organizationId"::text = current_setting('app.current_organization', true)
  )
  WITH CHECK (
    "workspaceId"::text = current_setting('app.current_workspace', true)
    OR "organizationId"::text = current_setting('app.current_organization', true)
  );

DROP POLICY IF EXISTS webhook_tenant_isolation ON "Webhook";
CREATE POLICY webhook_tenant_isolation ON "Webhook"
  USING (
    "workspaceId"::text = current_setting('app.current_workspace', true)
    OR "organizationId"::text = current_setting('app.current_organization', true)
  )
  WITH CHECK (
    "workspaceId"::text = current_setting('app.current_workspace', true)
    OR "organizationId"::text = current_setting('app.current_organization', true)
  );
