-- CreateEnum
CREATE TYPE "VariantStatus" AS ENUM ('DRAFT', 'SCHEDULED', 'QUEUED', 'PREPARING_MEDIA', 'PUBLISHING', 'PUBLISHED', 'FAILED', 'CANCELLED', 'MISSED', 'NEEDS_REVIEW');

-- CreateEnum
CREATE TYPE "PostStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SCHEDULED', 'PUBLISHING', 'PUBLISHED', 'PARTIALLY_PUBLISHED', 'FAILED', 'CANCELLED', 'MISSED', 'NEEDS_REVIEW');

-- CreateEnum
CREATE TYPE "PublishAttemptStatus" AS ENUM ('IN_FLIGHT', 'SUCCEEDED', 'FAILED', 'RATE_LIMITED', 'RECONCILED');

-- CreateTable
CREATE TABLE "Post" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "workspaceId" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "authorId" UUID,
    "status" "PostStatus" NOT NULL DEFAULT 'DRAFT',
    "baseContent" TEXT NOT NULL DEFAULT '',
    "scheduledAt" TIMESTAMP(3),
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Post_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PostVariant" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "postId" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "socialAccountId" UUID NOT NULL,
    "surface" TEXT NOT NULL DEFAULT 'feed',
    "contentOverride" TEXT,
    "platformOptions" JSONB NOT NULL DEFAULT '{}',
    "status" "VariantStatus" NOT NULL DEFAULT 'DRAFT',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "lastErrorCode" TEXT,
    "idempotencyKey" TEXT,
    "fingerprint" TEXT,
    "remoteId" TEXT,
    "remoteUrl" TEXT,
    "publishedAt" TIMESTAMP(3),
    "publishedLate" BOOLEAN NOT NULL DEFAULT false,
    "latenessSeconds" INTEGER,
    "estimatedCostCents" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PostVariant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PublishAttempt" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "postVariantId" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "status" "PublishAttemptStatus" NOT NULL DEFAULT 'IN_FLIGHT',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "providerRequestId" TEXT,
    "providerResponseId" TEXT,
    "errorCode" TEXT,
    "fenceToken" INTEGER,

    CONSTRAINT "PublishAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Post_workspaceId_status_scheduledAt_idx" ON "Post"("workspaceId", "status", "scheduledAt");

-- CreateIndex
CREATE INDEX "Post_workspaceId_deletedAt_createdAt_idx" ON "Post"("workspaceId", "deletedAt", "createdAt");

-- CreateIndex
CREATE INDEX "PostVariant_workspaceId_status_idx" ON "PostVariant"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "PostVariant_status_postId_idx" ON "PostVariant"("status", "postId");

-- CreateIndex
CREATE INDEX "PostVariant_socialAccountId_status_idx" ON "PostVariant"("socialAccountId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PostVariant_postId_socialAccountId_surface_key" ON "PostVariant"("postId", "socialAccountId", "surface");

-- CreateIndex
CREATE INDEX "PublishAttempt_status_startedAt_idx" ON "PublishAttempt"("status", "startedAt");

-- CreateIndex
CREATE INDEX "PublishAttempt_postVariantId_startedAt_idx" ON "PublishAttempt"("postVariantId", "startedAt");

-- AddForeignKey
ALTER TABLE "Post" ADD CONSTRAINT "Post_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Post" ADD CONSTRAINT "Post_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PostVariant" ADD CONSTRAINT "PostVariant_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PostVariant" ADD CONSTRAINT "PostVariant_socialAccountId_fkey" FOREIGN KEY ("socialAccountId") REFERENCES "SocialAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PublishAttempt" ADD CONSTRAINT "PublishAttempt_postVariantId_fkey" FOREIGN KEY ("postVariantId") REFERENCES "PostVariant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS for the content tables.
ALTER TABLE "Post" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Post" FORCE ROW LEVEL SECURITY;
CREATE POLICY post_tenant_isolation ON "Post"
  USING (
    "workspaceId"::text = current_setting('app.current_workspace', true)
    OR "organizationId"::text = current_setting('app.current_organization', true)
  )
  WITH CHECK (
    "workspaceId"::text = current_setting('app.current_workspace', true)
    OR "organizationId"::text = current_setting('app.current_organization', true)
  );

ALTER TABLE "PostVariant" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PostVariant" FORCE ROW LEVEL SECURITY;
CREATE POLICY postvariant_tenant_isolation ON "PostVariant"
  USING (
    "workspaceId"::text = current_setting('app.current_workspace', true)
    OR "organizationId"::text = current_setting('app.current_organization', true)
  )
  WITH CHECK (
    "workspaceId"::text = current_setting('app.current_workspace', true)
    OR "organizationId"::text = current_setting('app.current_organization', true)
  );

ALTER TABLE "PublishAttempt" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PublishAttempt" FORCE ROW LEVEL SECURITY;
CREATE POLICY publishattempt_tenant_isolation ON "PublishAttempt"
  USING ("workspaceId"::text = current_setting('app.current_workspace', true))
  WITH CHECK ("workspaceId"::text = current_setting('app.current_workspace', true));

-- Partial index for the scanner. The vast majority of variants are in terminal
-- states and have no business being in the index the scheduler hits every 30s.
CREATE INDEX "PostVariant_due_idx" ON "PostVariant" ("status")
  WHERE "status" IN ('SCHEDULED', 'QUEUED');

-- Partial index for reconciliation: only stale IN_FLIGHT attempts are ever scanned.
CREATE INDEX "PublishAttempt_inflight_idx" ON "PublishAttempt" ("startedAt")
  WHERE "status" = 'IN_FLIGHT';
