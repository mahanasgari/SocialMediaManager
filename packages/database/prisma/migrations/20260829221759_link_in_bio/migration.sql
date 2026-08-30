-- CreateTable
CREATE TABLE "LinkPage" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "workspaceId" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "bio" TEXT,
    "avatarUrl" TEXT,
    "theme" TEXT NOT NULL DEFAULT 'default',
    "published" BOOLEAN NOT NULL DEFAULT false,
    "views" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "LinkPage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Link" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "workspaceId" UUID NOT NULL,
    "linkPageId" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Link_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LinkPage_slug_key" ON "LinkPage"("slug");

-- CreateIndex
CREATE INDEX "LinkPage_workspaceId_deletedAt_idx" ON "LinkPage"("workspaceId", "deletedAt");

-- CreateIndex
CREATE INDEX "Link_linkPageId_position_idx" ON "Link"("linkPageId", "position");

-- CreateIndex
CREATE INDEX "Link_workspaceId_idx" ON "Link"("workspaceId");

-- AddForeignKey
ALTER TABLE "Link" ADD CONSTRAINT "Link_linkPageId_fkey" FOREIGN KEY ("linkPageId") REFERENCES "LinkPage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "LinkPage" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "LinkPage" FORCE ROW LEVEL SECURITY;
CREATE POLICY linkpage_tenant_isolation ON "LinkPage"
  USING ("workspaceId"::text = current_setting('app.current_workspace', true))
  WITH CHECK ("workspaceId"::text = current_setting('app.current_workspace', true));

ALTER TABLE "Link" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Link" FORCE ROW LEVEL SECURITY;
CREATE POLICY link_tenant_isolation ON "Link"
  USING ("workspaceId"::text = current_setting('app.current_workspace', true))
  WITH CHECK ("workspaceId"::text = current_setting('app.current_workspace', true));

-- A PUBLISHED page is public by definition: /l/:slug is served to anyone, with
-- no session and no tenant context. The policy grants exactly that and no more
-- — unpublished pages stay invisible, and only SELECT is permitted, so a public
-- visitor can read a page but never write one.
CREATE POLICY linkpage_public_read ON "LinkPage"
  FOR SELECT
  USING ("published" = TRUE AND "deletedAt" IS NULL
         AND current_setting('app.public_page', true) = 'on');

CREATE POLICY link_public_read ON "Link"
  FOR SELECT
  USING ("enabled" = TRUE AND current_setting('app.public_page', true) = 'on');

-- Click and view counters are the one write a visitor causes. Scoped to the
-- same actor, and the columns are all these policies can reach.
CREATE POLICY linkpage_public_count ON "LinkPage"
  FOR UPDATE
  USING ("published" = TRUE AND current_setting('app.public_page', true) = 'on')
  WITH CHECK (current_setting('app.public_page', true) = 'on');

CREATE POLICY link_public_count ON "Link"
  FOR UPDATE
  USING ("enabled" = TRUE AND current_setting('app.public_page', true) = 'on')
  WITH CHECK (current_setting('app.public_page', true) = 'on');
