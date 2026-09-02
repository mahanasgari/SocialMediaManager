-- Connector credentials an operator can set from the browser.
--
-- Until now, adding a Meta app meant editing .env.local and restarting three
-- processes. That is a reasonable answer for a deployment with a config
-- management system and the wrong one for the deployment this software is
-- actually aimed at, where the person who can administer the installation is
-- sitting in front of an admin console.
--
-- Deployment-global, not tenant-scoped: see the model comment in schema.prisma.

CREATE TABLE "ProviderSetting" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "hint" TEXT NOT NULL,
    "updatedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProviderSetting_pkey" PRIMARY KEY ("key")
);

ALTER TABLE "ProviderSetting" ADD CONSTRAINT "ProviderSetting_updatedById_fkey"
  FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "ProviderSetting_keyId_idx" ON "ProviderSetting"("keyId");

-- Two actors, not one, and the split is the point.
--
-- Every process needs to READ these at boot — the API to build an OAuth
-- redirect, the worker to refresh a token at 3am. Exactly one code path needs
-- to WRITE one: the admin controller, acting for a signed-in organization
-- owner.
--
-- Collapsing them would mean the analytics job that polls Instagram every
-- fifteen minutes holds UPDATE on the credential that authorises it. A bug
-- there stops being a crash and starts being a path to repointing the
-- installation's OAuth client at somebody else's app — which would harvest
-- every future connection without breaking anything visible. Read is common and
-- write is rare, so they get different grants.
ALTER TABLE "ProviderSetting" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ProviderSetting" FORCE ROW LEVEL SECURITY;

CREATE POLICY provider_setting_read ON "ProviderSetting"
  FOR SELECT
  USING (current_setting('app.connector_settings', true) = 'on');

CREATE POLICY provider_setting_write ON "ProviderSetting"
  FOR ALL
  USING (current_setting('app.connector_settings_write', true) = 'on')
  WITH CHECK (current_setting('app.connector_settings_write', true) = 'on');
