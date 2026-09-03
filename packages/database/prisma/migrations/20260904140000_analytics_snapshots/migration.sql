-- Daily analytics rollups.
--
-- The plan says dashboards read snapshots and never raw rows. Until now the
-- analytics endpoint ran a DISTINCT ON over every PostMetric in the window on
-- every page load — fine at demo scale, and worse every hour the ingestion job
-- runs, because the table it scans only ever grows.
--
-- This is the read model rather than a cache. Retention nulls raw payloads
-- after 90 days and rolls hourly metrics to daily after 30, so a year-old chart
-- can only come from here.

CREATE TABLE "AnalyticsSnapshot" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "workspaceId" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    -- Midnight UTC of the day summarised. A UTC day, not a workspace-local one:
    -- two workspaces in different zones sharing an account would otherwise
    -- disagree about which day a metric belongs to.
    "day" TIMESTAMP(3) NOT NULL,
    -- Null means the whole workspace, across every account.
    "socialAccountId" UUID,
    "postsPublished" INTEGER NOT NULL DEFAULT 0,
    "impressions" INTEGER,
    "reach" INTEGER,
    "likes" INTEGER,
    "comments" INTEGER,
    "shares" INTEGER,
    "saves" INTEGER,
    "clicks" INTEGER,
    "videoViews" INTEGER,
    "followers" INTEGER,
    -- Averaged across the variants measured that day, not summed. A rate that
    -- adds up is not a rate.
    "engagementRate" DOUBLE PRECISION,
    -- How many variants contributed, so a day built from two posts is not read
    -- as confidently as one built from two hundred.
    "sampleSize" INTEGER NOT NULL DEFAULT 0,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AnalyticsSnapshot_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "AnalyticsSnapshot" ADD CONSTRAINT "AnalyticsSnapshot_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Idempotency for the rollup job. It re-computes recent days on every run
-- because late-arriving metrics change yesterday's totals, so a re-run must
-- REPLACE a day rather than add a second copy of it.
--
-- NULLS NOT DISTINCT is load-bearing: socialAccountId is null for the
-- workspace-wide row, and under the default NULLS DISTINCT two such rows for
-- the same day would both be allowed.
CREATE UNIQUE INDEX "AnalyticsSnapshot_workspaceId_day_socialAccountId_key"
  ON "AnalyticsSnapshot"("workspaceId", "day", "socialAccountId") NULLS NOT DISTINCT;
CREATE INDEX "AnalyticsSnapshot_workspaceId_day_idx"
  ON "AnalyticsSnapshot"("workspaceId", "day");

-- Tenant isolation, the same shape as every other tenant-scoped table here.
ALTER TABLE "AnalyticsSnapshot" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AnalyticsSnapshot" FORCE ROW LEVEL SECURITY;
CREATE POLICY analytics_snapshot_tenant_isolation ON "AnalyticsSnapshot"
  USING (
    "workspaceId"::text = current_setting('app.current_workspace', true)
    OR "organizationId"::text = current_setting('app.current_organization', true)
  )
  WITH CHECK (
    "workspaceId"::text = current_setting('app.current_workspace', true)
    OR "organizationId"::text = current_setting('app.current_organization', true)
  );

-- The rollup runs across every workspace before any tenancy exists, exactly
-- like the publish sweep and the retention sweep. Without a named actor it
-- would match zero rows and report success having aggregated nothing.
CREATE POLICY analytics_snapshot_aggregator ON "AnalyticsSnapshot"
  FOR ALL
  USING (current_setting('app.aggregator', true) = 'on')
  WITH CHECK (current_setting('app.aggregator', true) = 'on');
