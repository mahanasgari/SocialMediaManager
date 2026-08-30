-- CreateEnum
CREATE TYPE "SocialAccountStatus" AS ENUM ('ACTIVE', 'NEEDS_REAUTH', 'DISCONNECTED', 'DISABLED');

-- CreateTable
CREATE TABLE "SocialAccount" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "workspaceId" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "providerAccountId" TEXT NOT NULL,
    "handle" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "avatarUrl" TEXT,
    "surfaces" TEXT[],
    "platformMeta" JSONB NOT NULL DEFAULT '{}',
    "status" "SocialAccountStatus" NOT NULL DEFAULT 'ACTIVE',
    "statusReason" TEXT,
    "lastSyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "SocialAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OAuthCredential" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "socialAccountId" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "accessToken" TEXT NOT NULL,
    "refreshToken" TEXT,
    "expiresAt" TIMESTAMP(3),
    "scopes" TEXT[],
    "keyId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OAuthCredential_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SocialAccount_provider_providerAccountId_idx" ON "SocialAccount"("provider", "providerAccountId");

-- CreateIndex
CREATE INDEX "SocialAccount_workspaceId_status_deletedAt_idx" ON "SocialAccount"("workspaceId", "status", "deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "SocialAccount_workspaceId_provider_providerAccountId_key" ON "SocialAccount"("workspaceId", "provider", "providerAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "OAuthCredential_socialAccountId_key" ON "OAuthCredential"("socialAccountId");

-- CreateIndex
CREATE INDEX "OAuthCredential_workspaceId_idx" ON "OAuthCredential"("workspaceId");

-- CreateIndex
CREATE INDEX "OAuthCredential_expiresAt_idx" ON "OAuthCredential"("expiresAt");

-- CreateIndex
CREATE INDEX "OAuthCredential_keyId_idx" ON "OAuthCredential"("keyId");

-- AddForeignKey
ALTER TABLE "SocialAccount" ADD CONSTRAINT "SocialAccount_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OAuthCredential" ADD CONSTRAINT "OAuthCredential_socialAccountId_fkey" FOREIGN KEY ("socialAccountId") REFERENCES "SocialAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-level security for the new tables.
--
-- OAuthCredential is the highest-value asset in the system: it carries publish
-- authority over a customer's real audience. It gets the same treatment as every
-- other tenant table, and FORCE matters here for the reason recorded in the
-- _app_role migration — the application must never connect as a superuser, or
-- none of this applies at all.

ALTER TABLE "SocialAccount" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SocialAccount" FORCE ROW LEVEL SECURITY;
CREATE POLICY socialaccount_tenant_isolation ON "SocialAccount"
  USING (
    "workspaceId"::text = current_setting('app.current_workspace', true)
    OR "organizationId"::text = current_setting('app.current_organization', true)
  )
  WITH CHECK (
    "workspaceId"::text = current_setting('app.current_workspace', true)
    OR "organizationId"::text = current_setting('app.current_organization', true)
  );

ALTER TABLE "OAuthCredential" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OAuthCredential" FORCE ROW LEVEL SECURITY;
CREATE POLICY oauthcredential_tenant_isolation ON "OAuthCredential"
  USING ("workspaceId"::text = current_setting('app.current_workspace', true))
  WITH CHECK ("workspaceId"::text = current_setting('app.current_workspace', true));

-- Note the asymmetry: SocialAccount is readable under an organization scope
-- (listing a client's connected channels is an org-level view), but a credential
-- is reachable ONLY under the workspace that owns it. There is no legitimate
-- organization-wide reason to read a token, and the blast radius of getting that
-- wrong is every connected account in the organization.
