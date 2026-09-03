-- What the rollup actor may READ.
--
-- Eighth appearance of the same pattern: a cross-cutting query that
-- legitimately precedes tenancy. "Which metrics arrived yesterday, across every
-- workspace?" has no single value for app.current_workspace, and under
-- tenant-keyed RLS it matches nothing while nothing errors — the job reports
-- success having aggregated zero rows, forever.
--
-- Narrow on purpose. It reads the numbers it aggregates and the rows it needs
-- to attribute them, and nothing else: not post CONTENT, not credentials, not
-- messages. An aggregation job that could read message bodies would be a
-- reporting feature with a data-exfiltration path attached.

CREATE POLICY post_metric_aggregator ON "PostMetric"
  FOR SELECT
  USING (current_setting('app.aggregator', true) = 'on');

CREATE POLICY account_metric_aggregator ON "AccountMetric"
  FOR SELECT
  USING (current_setting('app.aggregator', true) = 'on');

-- Needed to attribute a metric to an account and a workspace, and to count what
-- published on a given day. SELECT only.
CREATE POLICY post_variant_aggregator ON "PostVariant"
  FOR SELECT
  USING (current_setting('app.aggregator', true) = 'on');

CREATE POLICY social_account_aggregator ON "SocialAccount"
  FOR SELECT
  USING (current_setting('app.aggregator', true) = 'on');

-- Which workspaces exist, and which organization each belongs to — the snapshot
-- carries both tenancy columns like every other tenant-scoped row.
CREATE POLICY workspace_aggregator ON "Workspace"
  FOR SELECT
  USING (current_setting('app.aggregator', true) = 'on');
