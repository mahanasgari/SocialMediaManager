-- CreateEnum
CREATE TYPE "ConversationKind" AS ENUM ('COMMENT_THREAD', 'DM', 'MENTION');

-- CreateEnum
CREATE TYPE "ConversationStatus" AS ENUM ('OPEN', 'SNOOZED', 'ARCHIVED');

-- CreateTable
CREATE TABLE "Conversation" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "workspaceId" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "socialAccountId" UUID NOT NULL,
    "providerConversationId" TEXT NOT NULL,
    "kind" "ConversationKind" NOT NULL,
    "subjectHandle" TEXT NOT NULL,
    "status" "ConversationStatus" NOT NULL DEFAULT 'OPEN',
    "assigneeId" UUID,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "lastMessageAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "unreadCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "workspaceId" UUID NOT NULL,
    "conversationId" UUID NOT NULL,
    "providerMessageId" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "authorHandle" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "mediaUrls" TEXT[],
    "providerCreatedAt" TIMESTAMP(3) NOT NULL,
    "parentId" UUID,
    "raw" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyncCursor" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "workspaceId" UUID NOT NULL,
    "socialAccountId" UUID NOT NULL,
    "resource" TEXT NOT NULL,
    "cursor" TEXT,
    "lastSyncedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SyncCursor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InboundEvent" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "provider" TEXT NOT NULL,
    "providerEventId" TEXT,
    "contentHash" TEXT NOT NULL,
    "signatureValid" BOOLEAN NOT NULL DEFAULT false,
    "payload" JSONB NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "InboundEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InboundEventDelivery" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "inboundEventId" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "socialAccountId" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "error" TEXT,
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InboundEventDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UnroutedInboundEvent" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "provider" TEXT NOT NULL,
    "providerAccountId" TEXT,
    "payload" JSONB NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UnroutedInboundEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Conversation_workspaceId_status_lastMessageAt_idx" ON "Conversation"("workspaceId", "status", "lastMessageAt");

-- CreateIndex
CREATE INDEX "Conversation_assigneeId_status_idx" ON "Conversation"("assigneeId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Conversation_socialAccountId_providerConversationId_key" ON "Conversation"("socialAccountId", "providerConversationId");

-- CreateIndex
CREATE INDEX "Message_conversationId_providerCreatedAt_idx" ON "Message"("conversationId", "providerCreatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Message_conversationId_providerMessageId_key" ON "Message"("conversationId", "providerMessageId");

-- CreateIndex
CREATE INDEX "SyncCursor_workspaceId_idx" ON "SyncCursor"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "SyncCursor_socialAccountId_resource_key" ON "SyncCursor"("socialAccountId", "resource");

-- CreateIndex
CREATE INDEX "InboundEvent_receivedAt_idx" ON "InboundEvent"("receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "InboundEvent_provider_providerEventId_key" ON "InboundEvent"("provider", "providerEventId");

-- CreateIndex
CREATE UNIQUE INDEX "InboundEvent_provider_contentHash_key" ON "InboundEvent"("provider", "contentHash");

-- CreateIndex
CREATE INDEX "InboundEventDelivery_workspaceId_status_idx" ON "InboundEventDelivery"("workspaceId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "InboundEventDelivery_inboundEventId_workspaceId_key" ON "InboundEventDelivery"("inboundEventId", "workspaceId");

-- CreateIndex
CREATE INDEX "UnroutedInboundEvent_receivedAt_idx" ON "UnroutedInboundEvent"("receivedAt");

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_socialAccountId_fkey" FOREIGN KEY ("socialAccountId") REFERENCES "SocialAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InboundEventDelivery" ADD CONSTRAINT "InboundEventDelivery_inboundEventId_fkey" FOREIGN KEY ("inboundEventId") REFERENCES "InboundEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Conversation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Conversation" FORCE ROW LEVEL SECURITY;
CREATE POLICY conversation_tenant_isolation ON "Conversation"
  USING ("workspaceId"::text = current_setting('app.current_workspace', true))
  WITH CHECK ("workspaceId"::text = current_setting('app.current_workspace', true));
CREATE POLICY conversation_scheduler ON "Conversation"
  FOR ALL
  USING (current_setting('app.scheduler', true) = 'on')
  WITH CHECK (current_setting('app.scheduler', true) = 'on');

ALTER TABLE "Message" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Message" FORCE ROW LEVEL SECURITY;
CREATE POLICY message_tenant_isolation ON "Message"
  USING ("workspaceId"::text = current_setting('app.current_workspace', true))
  WITH CHECK ("workspaceId"::text = current_setting('app.current_workspace', true));
CREATE POLICY message_scheduler ON "Message"
  FOR ALL
  USING (current_setting('app.scheduler', true) = 'on')
  WITH CHECK (current_setting('app.scheduler', true) = 'on');

ALTER TABLE "SyncCursor" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SyncCursor" FORCE ROW LEVEL SECURITY;
CREATE POLICY synccursor_tenant_isolation ON "SyncCursor"
  USING ("workspaceId"::text = current_setting('app.current_workspace', true))
  WITH CHECK ("workspaceId"::text = current_setting('app.current_workspace', true));
CREATE POLICY synccursor_scheduler ON "SyncCursor"
  FOR ALL
  USING (current_setting('app.scheduler', true) = 'on')
  WITH CHECK (current_setting('app.scheduler', true) = 'on');

ALTER TABLE "InboundEventDelivery" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "InboundEventDelivery" FORCE ROW LEVEL SECURITY;
CREATE POLICY inboundeventdelivery_tenant_isolation ON "InboundEventDelivery"
  USING ("workspaceId"::text = current_setting('app.current_workspace', true))
  WITH CHECK ("workspaceId"::text = current_setting('app.current_workspace', true));
CREATE POLICY inboundeventdelivery_scheduler ON "InboundEventDelivery"
  FOR ALL
  USING (current_setting('app.scheduler', true) = 'on')
  WITH CHECK (current_setting('app.scheduler', true) = 'on');

-- InboundEvent and UnroutedInboundEvent carry NO workspaceId: an event arrives
-- before we know which workspace it belongs to, and routing it is the whole
-- problem. They are reachable only by the receiver and the dispatcher.
ALTER TABLE "InboundEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "InboundEvent" FORCE ROW LEVEL SECURITY;
CREATE POLICY inboundevent_system ON "InboundEvent"
  FOR ALL
  USING (current_setting('app.scheduler', true) = 'on')
  WITH CHECK (current_setting('app.scheduler', true) = 'on');

ALTER TABLE "UnroutedInboundEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "UnroutedInboundEvent" FORCE ROW LEVEL SECURITY;
CREATE POLICY unroutedinboundevent_system ON "UnroutedInboundEvent"
  FOR ALL
  USING (current_setting('app.scheduler', true) = 'on')
  WITH CHECK (current_setting('app.scheduler', true) = 'on');
