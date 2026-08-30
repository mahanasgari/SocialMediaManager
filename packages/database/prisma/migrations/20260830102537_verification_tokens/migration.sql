-- CreateTable
CREATE TABLE "VerificationToken" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "userId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VerificationToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "VerificationToken_tokenHash_key" ON "VerificationToken"("tokenHash");

-- CreateIndex
CREATE INDEX "VerificationToken_userId_purpose_idx" ON "VerificationToken"("userId", "purpose");

-- CreateIndex
CREATE INDEX "VerificationToken_expiresAt_idx" ON "VerificationToken"("expiresAt");

-- AddForeignKey
ALTER TABLE "VerificationToken" ADD CONSTRAINT "VerificationToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- VerificationToken is NOT tenant-scoped: it belongs to a user, who exists
-- before any workspace does. Password reset in particular must work for someone
-- who cannot sign in, so there is no session to derive a scope from.
--
-- It is reachable only under app.current_user, and only for that user's own
-- rows. The lookup by token hash therefore happens under the system scope in
-- the auth service, which is the one place that legitimately has no user yet —
-- the same shape as the other pre-tenancy actors.
ALTER TABLE "VerificationToken" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "VerificationToken" FORCE ROW LEVEL SECURITY;

CREATE POLICY verificationtoken_own ON "VerificationToken"
  FOR ALL
  USING ("userId"::text = current_setting('app.current_user', true))
  WITH CHECK ("userId"::text = current_setting('app.current_user', true));

-- The redemption path: someone holding a token but not a session. Narrow on
-- purpose — it can read and spend tokens and nothing else.
CREATE POLICY verificationtoken_redeem ON "VerificationToken"
  FOR ALL
  USING (current_setting('app.token_redeem', true) = 'on')
  WITH CHECK (current_setting('app.token_redeem', true) = 'on');
