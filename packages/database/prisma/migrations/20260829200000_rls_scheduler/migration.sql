-- The scheduler's cross-workspace read.
--
-- "Which posts are due right now?" spans every workspace by definition — a
-- single scanner serves the whole deployment, and there is no one value for
-- app.current_workspace. With only tenant-keyed policies the sweep returned
-- zero rows: correct RLS, and a scheduler that silently never publishes
-- anything. That is the worst kind of failure, because nothing errors.
--
-- The escape is NAMED and NARROW rather than a bypass:
--
--   * It is a distinct GUC, app.scheduler, set only by withScheduler() — so
--     every use is greppable and shows up in review.
--   * SELECT is permitted on Post and PostVariant; UPDATE only on PostVariant,
--     because the scanner's only write is a status transition. It cannot read a
--     credential, touch a workspace, or alter content.
--   * Policies are PERMISSIVE and OR'd, so this adds a path for one actor
--     without weakening tenant isolation for anyone else.
--
-- The publisher still does its real work under withTenant(), so everything past
-- the claim is fully tenant-scoped. This grant covers the claim alone.

CREATE POLICY post_scheduler_read ON "Post"
  FOR SELECT
  USING (current_setting('app.scheduler', true) = 'on');

CREATE POLICY postvariant_scheduler_read ON "PostVariant"
  FOR SELECT
  USING (current_setting('app.scheduler', true) = 'on');

CREATE POLICY postvariant_scheduler_update ON "PostVariant"
  FOR UPDATE
  USING (current_setting('app.scheduler', true) = 'on')
  WITH CHECK (current_setting('app.scheduler', true) = 'on');
