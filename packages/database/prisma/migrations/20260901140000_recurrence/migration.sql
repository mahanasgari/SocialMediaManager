-- Recurring schedules.
--
-- The rule stores a WALL-CLOCK TIME and an IANA ZONE, never an instant and an
-- interval. "09:00 Europe/Berlin" survives a daylight-saving change; "this
-- instant, every 24 hours" starts landing an hour out at the first transition
-- and never recovers. The conversion happens at expansion time — see
-- packages/content/src/recurrence.ts.

CREATE TYPE "RecurrenceFreq" AS ENUM ('DAILY', 'WEEKLY', 'MONTHLY');

CREATE TABLE "Recurrence" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "workspaceId" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "freq" "RecurrenceFreq" NOT NULL,
    "interval" INTEGER NOT NULL DEFAULT 1,
    "byWeekday" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "byMonthDay" INTEGER,
    "hour" INTEGER NOT NULL,
    "minute" INTEGER NOT NULL,
    "timezone" TEXT NOT NULL,
    "startsOn" TEXT NOT NULL,
    "endsOn" TEXT,
    "content" TEXT NOT NULL,
    "accountIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "active" BOOLEAN NOT NULL DEFAULT true,
    "expandedUntil" TIMESTAMP(3),
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Recurrence_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Recurrence_workspaceId_active_deletedAt_idx"
  ON "Recurrence"("workspaceId", "active", "deletedAt");
CREATE INDEX "Recurrence_active_expandedUntil_idx"
  ON "Recurrence"("active", "expandedUntil");

ALTER TABLE "Recurrence" ADD CONSTRAINT "Recurrence_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Recurrence" ADD CONSTRAINT "Recurrence_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Posts remember which rule produced them, and which occurrence.
--
-- SetNull rather than Cascade: deleting a schedule must not delete the posts it
-- already produced. Those are on the calendar, and some of them have published.
ALTER TABLE "Post" ADD COLUMN "recurrenceId" UUID;
ALTER TABLE "Post" ADD COLUMN "occurrenceAt" TIMESTAMP(3);

ALTER TABLE "Post" ADD CONSTRAINT "Post_recurrenceId_fkey"
  FOREIGN KEY ("recurrenceId") REFERENCES "Recurrence"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The expansion job's idempotency, enforced by the database rather than by
-- remembering to check. The job runs on every worker tick and asks for a
-- rolling window that deliberately overlaps what it already did; without this,
-- every tick would produce another copy of every upcoming post.
CREATE UNIQUE INDEX "Post_recurrenceId_occurrenceAt_key"
  ON "Post"("recurrenceId", "occurrenceAt");

-- Tenant isolation, plus the organization clause. Same shape as every other
-- tenant-scoped table here.
ALTER TABLE "Recurrence" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Recurrence" FORCE ROW LEVEL SECURITY;
CREATE POLICY recurrence_tenant_isolation ON "Recurrence"
  USING (
    "workspaceId"::text = current_setting('app.current_workspace', true)
    OR "organizationId"::text = current_setting('app.current_organization', true)
  )
  WITH CHECK (
    "workspaceId"::text = current_setting('app.current_workspace', true)
    OR "organizationId"::text = current_setting('app.current_organization', true)
  );

-- "Which schedules are due for expansion?" spans every workspace by definition,
-- exactly like the publish sweep — one worker serves the whole deployment and
-- there is no single value for app.current_workspace. Discovery only: the
-- expansion itself runs under withTenant(), so this actor can find a rule that
-- needs work and record that it did it, and nothing else.
CREATE POLICY recurrence_scheduler_read ON "Recurrence"
  FOR SELECT
  USING (current_setting('app.scheduler', true) = 'on');

CREATE POLICY recurrence_scheduler_update ON "Recurrence"
  FOR UPDATE
  USING (current_setting('app.scheduler', true) = 'on')
  WITH CHECK (current_setting('app.scheduler', true) = 'on');
