-- CreateTable
CREATE TABLE "PostMetric" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "workspaceId" UUID NOT NULL,
    "postVariantId" UUID NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "impressions" INTEGER,
    "reach" INTEGER,
    "views" INTEGER,
    "likes" INTEGER,
    "comments" INTEGER,
    "shares" INTEGER,
    "saves" INTEGER,
    "clicks" INTEGER,
    "videoViews" INTEGER,
    "watchTimeMs" INTEGER,
    "engagementRate" DOUBLE PRECISION,
    "raw" JSONB,
    "source" TEXT NOT NULL DEFAULT 'poll',

    CONSTRAINT "PostMetric_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountMetric" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "workspaceId" UUID NOT NULL,
    "socialAccountId" UUID NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "followers" INTEGER,
    "following" INTEGER,
    "postCount" INTEGER,
    "followerGrowth" INTEGER,
    "raw" JSONB,

    CONSTRAINT "AccountMetric_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PostMetric_postVariantId_capturedAt_idx" ON "PostMetric"("postVariantId", "capturedAt");

-- CreateIndex
CREATE INDEX "PostMetric_workspaceId_capturedAt_idx" ON "PostMetric"("workspaceId", "capturedAt");

-- CreateIndex
CREATE INDEX "AccountMetric_socialAccountId_capturedAt_idx" ON "AccountMetric"("socialAccountId", "capturedAt");

-- CreateIndex
CREATE INDEX "AccountMetric_workspaceId_capturedAt_idx" ON "AccountMetric"("workspaceId", "capturedAt");

-- AddForeignKey
ALTER TABLE "PostMetric" ADD CONSTRAINT "PostMetric_postVariantId_fkey" FOREIGN KEY ("postVariantId") REFERENCES "PostVariant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountMetric" ADD CONSTRAINT "AccountMetric_socialAccountId_fkey" FOREIGN KEY ("socialAccountId") REFERENCES "SocialAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS. Metrics belong to a workspace like everything else.
ALTER TABLE "PostMetric" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PostMetric" FORCE ROW LEVEL SECURITY;
CREATE POLICY postmetric_tenant_isolation ON "PostMetric"
  USING ("workspaceId"::text = current_setting('app.current_workspace', true))
  WITH CHECK ("workspaceId"::text = current_setting('app.current_workspace', true));

ALTER TABLE "AccountMetric" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AccountMetric" FORCE ROW LEVEL SECURITY;
CREATE POLICY accountmetric_tenant_isolation ON "AccountMetric"
  USING ("workspaceId"::text = current_setting('app.current_workspace', true))
  WITH CHECK ("workspaceId"::text = current_setting('app.current_workspace', true));

-- The ingestion sweep is cross-workspace for the same reason the scheduler is:
-- one worker serves the whole deployment. Same narrow, named actor.
CREATE POLICY postvariant_scheduler_metrics ON "PostMetric"
  FOR ALL
  USING (current_setting('app.scheduler', true) = 'on')
  WITH CHECK (current_setting('app.scheduler', true) = 'on');

CREATE POLICY accountmetric_scheduler ON "AccountMetric"
  FOR ALL
  USING (current_setting('app.scheduler', true) = 'on')
  WITH CHECK (current_setting('app.scheduler', true) = 'on');
