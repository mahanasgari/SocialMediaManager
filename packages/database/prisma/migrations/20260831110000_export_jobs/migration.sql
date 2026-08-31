-- CreateEnum
CREATE TYPE "ExportKind" AS ENUM ('WORKSPACE', 'SUBJECT');

-- CreateEnum
CREATE TYPE "ExportStatus" AS ENUM ('PENDING', 'RUNNING', 'READY', 'FAILED', 'EXPIRED');

-- CreateTable
CREATE TABLE "ExportJob" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "workspaceId" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "kind" "ExportKind" NOT NULL,
    "subjectHandle" TEXT,
    "status" "ExportStatus" NOT NULL DEFAULT 'PENDING',
    "requestedById" UUID,
    "storageKey" TEXT,
    "bytes" INTEGER,
    "summary" JSONB,
    "error" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExportJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ExportJob_workspaceId_status_createdAt_idx" ON "ExportJob"("workspaceId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "ExportJob_status_createdAt_idx" ON "ExportJob"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "ExportJob" ADD CONSTRAINT "ExportJob_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExportJob" ADD CONSTRAINT "ExportJob_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Row Level Security
--
-- Tenant isolation, plus the organization clause, because ExportJob carries an
-- organizationId and a policy that cannot see it produces the empty-result-with-
-- no-error failure this codebase has hit twice.
-- ---------------------------------------------------------------------------

ALTER TABLE "ExportJob" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ExportJob" FORCE ROW LEVEL SECURITY;
CREATE POLICY exportjob_tenant_isolation ON "ExportJob"
  USING (
    "workspaceId"::text = current_setting('app.current_workspace', true)
    OR "organizationId"::text = current_setting('app.current_organization', true)
  )
  WITH CHECK (
    "workspaceId"::text = current_setting('app.current_workspace', true)
    OR "organizationId"::text = current_setting('app.current_organization', true)
  );

-- "Which exports are waiting?" spans every workspace, like every other sweep in
-- this system. It reuses app.scheduler rather than earning a seventh actor:
-- the worker already reads and updates PostVariant under that grant, and an
-- ExportJob row is the same kind of thing — a unit of queued work with no
-- personal data in it. The DATA an export contains is read afterwards, under
-- withTenant(), by the same code every other reader uses.
CREATE POLICY exportjob_scheduler_claim ON "ExportJob"
  FOR SELECT
  USING (current_setting('app.scheduler', true) = 'on');

CREATE POLICY exportjob_scheduler_update ON "ExportJob"
  FOR UPDATE
  USING (current_setting('app.scheduler', true) = 'on')
  WITH CHECK (current_setting('app.scheduler', true) = 'on');
