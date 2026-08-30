-- CreateEnum
CREATE TYPE "ApprovalState" AS ENUM ('PENDING', 'APPROVED', 'CHANGES_REQUESTED');

-- CreateEnum
CREATE TYPE "ApprovalMode" AS ENUM ('ANY', 'ALL');

-- CreateTable
CREATE TABLE "Approval" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "workspaceId" UUID NOT NULL,
    "postId" UUID NOT NULL,
    "requestedById" UUID NOT NULL,
    "state" "ApprovalState" NOT NULL DEFAULT 'PENDING',
    "mode" "ApprovalMode" NOT NULL DEFAULT 'ANY',
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "decidedAt" TIMESTAMP(3),

    CONSTRAINT "Approval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApprovalStep" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "workspaceId" UUID NOT NULL,
    "approvalId" UUID NOT NULL,
    "approverId" UUID NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,
    "decision" "ApprovalState" NOT NULL DEFAULT 'PENDING',
    "note" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApprovalStep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PostComment" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "workspaceId" UUID NOT NULL,
    "postId" UUID NOT NULL,
    "authorId" UUID,
    "parentId" UUID,
    "body" TEXT NOT NULL,
    "mentions" TEXT[],
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "PostComment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "workspaceId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "href" TEXT,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Approval_postId_key" ON "Approval"("postId");

-- CreateIndex
CREATE INDEX "Approval_workspaceId_state_idx" ON "Approval"("workspaceId", "state");

-- CreateIndex
CREATE INDEX "ApprovalStep_workspaceId_decision_idx" ON "ApprovalStep"("workspaceId", "decision");

-- CreateIndex
CREATE UNIQUE INDEX "ApprovalStep_approvalId_approverId_key" ON "ApprovalStep"("approvalId", "approverId");

-- CreateIndex
CREATE INDEX "PostComment_workspaceId_postId_createdAt_idx" ON "PostComment"("workspaceId", "postId", "createdAt");

-- CreateIndex
CREATE INDEX "Notification_userId_readAt_createdAt_idx" ON "Notification"("userId", "readAt", "createdAt");

-- CreateIndex
CREATE INDEX "Notification_workspaceId_createdAt_idx" ON "Notification"("workspaceId", "createdAt");

-- AddForeignKey
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovalStep" ADD CONSTRAINT "ApprovalStep_approvalId_fkey" FOREIGN KEY ("approvalId") REFERENCES "Approval"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PostComment" ADD CONSTRAINT "PostComment_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PostComment" ADD CONSTRAINT "PostComment_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PostComment" ADD CONSTRAINT "PostComment_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "PostComment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Approval" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Approval" FORCE ROW LEVEL SECURITY;
CREATE POLICY approval_tenant_isolation ON "Approval"
  USING ("workspaceId"::text = current_setting('app.current_workspace', true))
  WITH CHECK ("workspaceId"::text = current_setting('app.current_workspace', true));

ALTER TABLE "ApprovalStep" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ApprovalStep" FORCE ROW LEVEL SECURITY;
CREATE POLICY approvalstep_tenant_isolation ON "ApprovalStep"
  USING ("workspaceId"::text = current_setting('app.current_workspace', true))
  WITH CHECK ("workspaceId"::text = current_setting('app.current_workspace', true));

ALTER TABLE "PostComment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PostComment" FORCE ROW LEVEL SECURITY;
CREATE POLICY postcomment_tenant_isolation ON "PostComment"
  USING ("workspaceId"::text = current_setting('app.current_workspace', true))
  WITH CHECK ("workspaceId"::text = current_setting('app.current_workspace', true));

ALTER TABLE "Notification" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Notification" FORCE ROW LEVEL SECURITY;
CREATE POLICY notification_tenant_isolation ON "Notification"
  USING ("workspaceId"::text = current_setting('app.current_workspace', true))
  WITH CHECK ("workspaceId"::text = current_setting('app.current_workspace', true));

-- A user reads their OWN notifications across every workspace they belong to —
-- the notification bell is not scoped to whichever workspace is on screen.
-- Same per-user actor the membership lookup uses.
CREATE POLICY notification_self_read ON "Notification"
  FOR SELECT USING ("userId"::text = current_setting('app.current_user', true));
CREATE POLICY notification_self_update ON "Notification"
  FOR UPDATE USING ("userId"::text = current_setting('app.current_user', true))
  WITH CHECK ("userId"::text = current_setting('app.current_user', true));
