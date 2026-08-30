-- The retention actor.
--
-- Retention is a cross-cutting sweep like the scheduler: it must find due rows
-- across every workspace before any tenancy is established. Without a policy it
-- matched nothing, and the purge reported success having deleted nothing — the
-- same silent-empty failure as the inbound router, and the third time this
-- shape has appeared.
--
-- A SEPARATE actor rather than widening app.scheduler, because this is the only
-- actor in the system that DELETES a workspace. That grant does not belong on
-- the actor that publishes posts every thirty seconds.
--
-- The grants are exactly what the job needs and nothing more. Note especially
-- what is ABSENT: it cannot read Post, SocialAccount, OAuthCredential or
-- Message. It does not need to — deleting the Workspace row cascades those at
-- the database level — so a bug in the purge cannot become a data leak.

-- Find due workspaces, and destroy them.
CREATE POLICY workspace_retention ON "Workspace"
  FOR ALL
  USING (current_setting('app.retention', true) = 'on')
  WITH CHECK (current_setting('app.retention', true) = 'on');

-- Minimise audit rows. SELECT and UPDATE only.
--
-- DELETE is deliberately NOT granted: the evidence that a workspace was deleted
-- must outlive the workspace, and a deletion record that can delete itself is
-- not a record. AuditLog.workspaceId is onDelete: SetNull for the same reason.
CREATE POLICY auditlog_retention_read ON "AuditLog"
  FOR SELECT
  USING (current_setting('app.retention', true) = 'on');

CREATE POLICY auditlog_retention_minimise ON "AuditLog"
  FOR UPDATE
  USING (current_setting('app.retention', true) = 'on')
  WITH CHECK (current_setting('app.retention', true) = 'on');

-- Reap spent and expired tokens.
CREATE POLICY verificationtoken_retention ON "VerificationToken"
  FOR ALL
  USING (current_setting('app.retention', true) = 'on')
  WITH CHECK (current_setting('app.retention', true) = 'on');

-- Null out raw payloads past 90 days. These already have scheduler policies;
-- retention gets its own so the job runs under one actor rather than two.
CREATE POLICY postmetric_retention ON "PostMetric"
  FOR ALL
  USING (current_setting('app.retention', true) = 'on')
  WITH CHECK (current_setting('app.retention', true) = 'on');

CREATE POLICY accountmetric_retention ON "AccountMetric"
  FOR ALL
  USING (current_setting('app.retention', true) = 'on')
  WITH CHECK (current_setting('app.retention', true) = 'on');

CREATE POLICY unroutedinboundevent_retention ON "UnroutedInboundEvent"
  FOR ALL
  USING (current_setting('app.retention', true) = 'on')
  WITH CHECK (current_setting('app.retention', true) = 'on');
