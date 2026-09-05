-- Saved reports.
--
-- Stores the QUESTION, not the answer: a saved report re-runs against current
-- data. Storing rendered figures would make it a snapshot, which is a different
-- feature and the one people expect less.

CREATE TABLE "SavedReport" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "workspaceId" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    -- A rolling window, so a saved report follows time rather than pinning to
    -- the dates it happened to be created on. "Last 30 days" is what is meant.
    "windowDays" INTEGER NOT NULL DEFAULT 30,
    -- Empty means every account, so a report does not silently exclude a
    -- channel connected after it was saved.
    "accountIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SavedReport_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "SavedReport" ADD CONSTRAINT "SavedReport_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SavedReport" ADD CONSTRAINT "SavedReport_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE UNIQUE INDEX "SavedReport_workspaceId_name_key" ON "SavedReport"("workspaceId", "name");
CREATE INDEX "SavedReport_workspaceId_idx" ON "SavedReport"("workspaceId");

ALTER TABLE "SavedReport" ADD CONSTRAINT "SavedReport_windowDays_range"
  CHECK ("windowDays" >= 1 AND "windowDays" <= 365);

-- Tenant isolation, the same shape as every other tenant-scoped table here.
ALTER TABLE "SavedReport" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SavedReport" FORCE ROW LEVEL SECURITY;
CREATE POLICY saved_report_tenant_isolation ON "SavedReport"
  USING (
    "workspaceId"::text = current_setting('app.current_workspace', true)
    OR "organizationId"::text = current_setting('app.current_organization', true)
  )
  WITH CHECK (
    "workspaceId"::text = current_setting('app.current_workspace', true)
    OR "organizationId"::text = current_setting('app.current_organization', true)
  );
