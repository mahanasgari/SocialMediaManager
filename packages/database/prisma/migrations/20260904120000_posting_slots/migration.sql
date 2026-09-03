-- The posting queue.
--
-- A workspace declares WHEN it posts — Tuesdays at 09:00, weekdays at 17:30 —
-- and new posts drop into the next free one. For anyone posting on a rhythm,
-- this is the difference between choosing a time forty times a week and
-- choosing it once.
--
-- A wall-clock time plus the workspace's zone, never an instant, for the same
-- reason Recurrence stores one: "09:00 on Tuesdays" has to survive a
-- daylight-saving change.

CREATE TABLE "PostingSlot" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "workspaceId" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    -- 0 is Sunday, matching Date.getDay() so nothing has to convert.
    "dayOfWeek" INTEGER NOT NULL,
    "hour" INTEGER NOT NULL,
    "minute" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PostingSlot_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "PostingSlot" ADD CONSTRAINT "PostingSlot_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- One slot per moment. Two slots at the same time would hand the same instant
-- to two posts and publish them together, which is the opposite of a queue.
CREATE UNIQUE INDEX "PostingSlot_workspaceId_dayOfWeek_hour_minute_key"
  ON "PostingSlot"("workspaceId", "dayOfWeek", "hour", "minute");
CREATE INDEX "PostingSlot_workspaceId_idx" ON "PostingSlot"("workspaceId");

-- Values are checked in the API too, but a queue that hands out hour 25 would
-- produce an Invalid Date and a post that never publishes, so the database
-- refuses it as well.
ALTER TABLE "PostingSlot" ADD CONSTRAINT "PostingSlot_dayOfWeek_range"
  CHECK ("dayOfWeek" >= 0 AND "dayOfWeek" <= 6);
ALTER TABLE "PostingSlot" ADD CONSTRAINT "PostingSlot_hour_range"
  CHECK ("hour" >= 0 AND "hour" <= 23);
ALTER TABLE "PostingSlot" ADD CONSTRAINT "PostingSlot_minute_range"
  CHECK ("minute" >= 0 AND "minute" <= 59);

-- Tenant isolation, the same shape as every other tenant-scoped table here.
ALTER TABLE "PostingSlot" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PostingSlot" FORCE ROW LEVEL SECURITY;
CREATE POLICY posting_slot_tenant_isolation ON "PostingSlot"
  USING (
    "workspaceId"::text = current_setting('app.current_workspace', true)
    OR "organizationId"::text = current_setting('app.current_organization', true)
  )
  WITH CHECK (
    "workspaceId"::text = current_setting('app.current_workspace', true)
    OR "organizationId"::text = current_setting('app.current_organization', true)
  );
