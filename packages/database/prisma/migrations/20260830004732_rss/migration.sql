-- CreateTable
CREATE TABLE "RSSFeed" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "workspaceId" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "url" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "targetAccountIds" TEXT[],
    "template" TEXT NOT NULL DEFAULT '{{title}} {{link}}',
    "autoPublish" BOOLEAN NOT NULL DEFAULT false,
    "lastFetchedAt" TIMESTAMP(3),
    "lastItemGuid" TEXT,
    "pausedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "RSSFeed_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RSSItem" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "workspaceId" UUID NOT NULL,
    "feedId" UUID NOT NULL,
    "guid" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "link" TEXT NOT NULL,
    "publishedAt" TIMESTAMP(3),
    "postId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RSSItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RSSFeed_workspaceId_deletedAt_idx" ON "RSSFeed"("workspaceId", "deletedAt");

-- CreateIndex
CREATE INDEX "RSSFeed_pausedAt_lastFetchedAt_idx" ON "RSSFeed"("pausedAt", "lastFetchedAt");

-- CreateIndex
CREATE INDEX "RSSItem_workspaceId_createdAt_idx" ON "RSSItem"("workspaceId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "RSSItem_feedId_guid_key" ON "RSSItem"("feedId", "guid");

-- AddForeignKey
ALTER TABLE "RSSItem" ADD CONSTRAINT "RSSItem_feedId_fkey" FOREIGN KEY ("feedId") REFERENCES "RSSFeed"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "RSSFeed" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RSSFeed" FORCE ROW LEVEL SECURITY;
CREATE POLICY rssfeed_tenant_isolation ON "RSSFeed"
  USING ("workspaceId"::text = current_setting('app.current_workspace', true))
  WITH CHECK ("workspaceId"::text = current_setting('app.current_workspace', true));
CREATE POLICY rssfeed_scheduler ON "RSSFeed"
  FOR ALL
  USING (current_setting('app.scheduler', true) = 'on')
  WITH CHECK (current_setting('app.scheduler', true) = 'on');

ALTER TABLE "RSSItem" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RSSItem" FORCE ROW LEVEL SECURITY;
CREATE POLICY rssitem_tenant_isolation ON "RSSItem"
  USING ("workspaceId"::text = current_setting('app.current_workspace', true))
  WITH CHECK ("workspaceId"::text = current_setting('app.current_workspace', true));
CREATE POLICY rssitem_scheduler ON "RSSItem"
  FOR ALL
  USING (current_setting('app.scheduler', true) = 'on')
  WITH CHECK (current_setting('app.scheduler', true) = 'on');
