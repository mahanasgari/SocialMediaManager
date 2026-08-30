-- CreateTable
CREATE TABLE "MediaRendition" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "workspaceId" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "mediaAssetId" UUID NOT NULL,
    "providerId" TEXT NOT NULL,
    "surface" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "bytes" INTEGER NOT NULL,
    "reasons" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MediaRendition_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MediaRendition_storageKey_key" ON "MediaRendition"("storageKey");

-- CreateIndex
CREATE INDEX "MediaRendition_workspaceId_idx" ON "MediaRendition"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "MediaRendition_mediaAssetId_providerId_surface_key" ON "MediaRendition"("mediaAssetId", "providerId", "surface");

-- AddForeignKey
ALTER TABLE "MediaRendition" ADD CONSTRAINT "MediaRendition_mediaAssetId_fkey" FOREIGN KEY ("mediaAssetId") REFERENCES "MediaAsset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "MediaRendition" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MediaRendition" FORCE ROW LEVEL SECURITY;

CREATE POLICY mediarendition_tenant_isolation ON "MediaRendition"
  USING (
    "workspaceId"::text = current_setting('app.current_workspace', true)
    OR "organizationId"::text = current_setting('app.current_organization', true)
  )
  WITH CHECK (
    "workspaceId"::text = current_setting('app.current_workspace', true)
    OR "organizationId"::text = current_setting('app.current_organization', true)
  );

-- The worker transcodes under the scheduler actor, before any request scope
-- exists.
CREATE POLICY mediarendition_scheduler ON "MediaRendition"
  FOR ALL
  USING (current_setting('app.scheduler', true) = 'on')
  WITH CHECK (current_setting('app.scheduler', true) = 'on');

-- Purge needs to find rendition storage keys to delete the objects.
CREATE POLICY mediarendition_retention ON "MediaRendition"
  FOR ALL
  USING (current_setting('app.retention', true) = 'on')
  WITH CHECK (current_setting('app.retention', true) = 'on');
