-- AlterTable
ALTER TABLE "Post" ADD COLUMN     "campaignId" UUID;

-- CreateTable
CREATE TABLE "Campaign" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "workspaceId" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "color" TEXT NOT NULL DEFAULT '#6366f1',
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Campaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Label" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "workspaceId" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT '#64748b',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Label_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PostLabel" (
    "postId" UUID NOT NULL,
    "labelId" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PostLabel_pkey" PRIMARY KEY ("postId","labelId")
);

-- CreateTable
CREATE TABLE "Template" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "workspaceId" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "body" TEXT NOT NULL,
    "variables" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdById" UUID,
    "usageCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Template_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UtmPreset" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "workspaceId" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "medium" TEXT NOT NULL,
    "campaign" TEXT,
    "term" TEXT,
    "content" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UtmPreset_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Campaign_workspaceId_archived_deletedAt_idx" ON "Campaign"("workspaceId", "archived", "deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Campaign_workspaceId_name_key" ON "Campaign"("workspaceId", "name");

-- CreateIndex
CREATE INDEX "Label_workspaceId_idx" ON "Label"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "Label_workspaceId_name_key" ON "Label"("workspaceId", "name");

-- CreateIndex
CREATE INDEX "PostLabel_workspaceId_labelId_idx" ON "PostLabel"("workspaceId", "labelId");

-- CreateIndex
CREATE INDEX "Template_workspaceId_deletedAt_usageCount_idx" ON "Template"("workspaceId", "deletedAt", "usageCount");

-- CreateIndex
CREATE UNIQUE INDEX "Template_workspaceId_name_key" ON "Template"("workspaceId", "name");

-- CreateIndex
CREATE INDEX "UtmPreset_workspaceId_isDefault_idx" ON "UtmPreset"("workspaceId", "isDefault");

-- CreateIndex
CREATE UNIQUE INDEX "UtmPreset_workspaceId_name_key" ON "UtmPreset"("workspaceId", "name");

-- CreateIndex
CREATE INDEX "Post_workspaceId_campaignId_idx" ON "Post"("workspaceId", "campaignId");

-- AddForeignKey
ALTER TABLE "Post" ADD CONSTRAINT "Post_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Label" ADD CONSTRAINT "Label_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PostLabel" ADD CONSTRAINT "PostLabel_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PostLabel" ADD CONSTRAINT "PostLabel_labelId_fkey" FOREIGN KEY ("labelId") REFERENCES "Label"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Template" ADD CONSTRAINT "Template_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Template" ADD CONSTRAINT "Template_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UtmPreset" ADD CONSTRAINT "UtmPreset_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Row Level Security
--
-- Five new tenant-scoped tables. The isolation suite enumerates them from the
-- Prisma DMMF at test time, so any one of these arriving without a policy fails
-- CI rather than shipping as a table anyone can read.
--
-- PostLabel is the one worth a second look. It is a join row, and the obvious
-- reading is that isolation via Post and Label is enough — but RLS does not
-- work through a join. A policy-free join table is directly queryable, and
-- "which labels are on which posts" leaks the shape of another workspace's
-- content calendar even without its text. Hence its own workspaceId column and
-- its own policy, denormalised for exactly this reason.
-- ---------------------------------------------------------------------------

ALTER TABLE "Campaign" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Campaign" FORCE ROW LEVEL SECURITY;
CREATE POLICY campaign_tenant_isolation ON "Campaign"
  USING ("workspaceId"::text = current_setting('app.current_workspace', true))
  WITH CHECK ("workspaceId"::text = current_setting('app.current_workspace', true));

ALTER TABLE "Label" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Label" FORCE ROW LEVEL SECURITY;
CREATE POLICY label_tenant_isolation ON "Label"
  USING ("workspaceId"::text = current_setting('app.current_workspace', true))
  WITH CHECK ("workspaceId"::text = current_setting('app.current_workspace', true));

ALTER TABLE "PostLabel" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PostLabel" FORCE ROW LEVEL SECURITY;
CREATE POLICY postlabel_tenant_isolation ON "PostLabel"
  USING ("workspaceId"::text = current_setting('app.current_workspace', true))
  WITH CHECK ("workspaceId"::text = current_setting('app.current_workspace', true));

ALTER TABLE "Template" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Template" FORCE ROW LEVEL SECURITY;
CREATE POLICY template_tenant_isolation ON "Template"
  USING ("workspaceId"::text = current_setting('app.current_workspace', true))
  WITH CHECK ("workspaceId"::text = current_setting('app.current_workspace', true));

ALTER TABLE "UtmPreset" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "UtmPreset" FORCE ROW LEVEL SECURITY;
CREATE POLICY utmpreset_tenant_isolation ON "UtmPreset"
  USING ("workspaceId"::text = current_setting('app.current_workspace', true))
  WITH CHECK ("workspaceId"::text = current_setting('app.current_workspace', true));

-- The scheduler already reads Post to find what is due. It now needs Campaign
-- alongside it, because a scheduled post carries a campaignId and the sweep
-- selects the post row whole. SELECT only, consistent with the rest of that
-- actor's grant: it can see which campaign a post belongs to, and cannot
-- create, rename or delete one.
CREATE POLICY campaign_scheduler_read ON "Campaign"
  FOR SELECT
  USING (current_setting('app.scheduler', true) = 'on');

-- Organization scope.
--
-- Four of the five new models carry an organizationId, and a policy that cannot
-- see it produces the quiet failure this codebase has hit before: the tenancy
-- extension ALLOWS an organization-scoped query on a model with that column,
-- the query runs, RLS filters every row away, and the caller gets an empty
-- result with no error. An org-wide list of campaigns would return nothing with
-- the rows plainly in the table.
--
-- Written as DROP-then-CREATE rather than edited above, so the two concerns
-- stay legible: the block above is "these tables are tenant-isolated", this one
-- is "and organization scope reaches them". `models_have_org_clause` in the
-- isolation suite asserts it, which is what caught the omission here.
--
-- PostLabel is deliberately absent. It has no organizationId — a join row is
-- reachable only through a post that is already scoped, so a second tenancy
-- column on it would be a second thing to keep in step for no gain.

DROP POLICY IF EXISTS campaign_tenant_isolation ON "Campaign";
CREATE POLICY campaign_tenant_isolation ON "Campaign"
  USING (
    "workspaceId"::text = current_setting('app.current_workspace', true)
    OR "organizationId"::text = current_setting('app.current_organization', true)
  )
  WITH CHECK (
    "workspaceId"::text = current_setting('app.current_workspace', true)
    OR "organizationId"::text = current_setting('app.current_organization', true)
  );

DROP POLICY IF EXISTS label_tenant_isolation ON "Label";
CREATE POLICY label_tenant_isolation ON "Label"
  USING (
    "workspaceId"::text = current_setting('app.current_workspace', true)
    OR "organizationId"::text = current_setting('app.current_organization', true)
  )
  WITH CHECK (
    "workspaceId"::text = current_setting('app.current_workspace', true)
    OR "organizationId"::text = current_setting('app.current_organization', true)
  );

DROP POLICY IF EXISTS template_tenant_isolation ON "Template";
CREATE POLICY template_tenant_isolation ON "Template"
  USING (
    "workspaceId"::text = current_setting('app.current_workspace', true)
    OR "organizationId"::text = current_setting('app.current_organization', true)
  )
  WITH CHECK (
    "workspaceId"::text = current_setting('app.current_workspace', true)
    OR "organizationId"::text = current_setting('app.current_organization', true)
  );

DROP POLICY IF EXISTS utmpreset_tenant_isolation ON "UtmPreset";
CREATE POLICY utmpreset_tenant_isolation ON "UtmPreset"
  USING (
    "workspaceId"::text = current_setting('app.current_workspace', true)
    OR "organizationId"::text = current_setting('app.current_organization', true)
  )
  WITH CHECK (
    "workspaceId"::text = current_setting('app.current_workspace', true)
    OR "organizationId"::text = current_setting('app.current_organization', true)
  );
