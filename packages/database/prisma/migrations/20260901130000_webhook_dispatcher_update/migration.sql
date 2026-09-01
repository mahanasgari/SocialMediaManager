-- The webhook dispatcher needs to WRITE to Webhook, not only read it.
--
-- It was granted SELECT alone, which was correct for the code as written when
-- the policy was added and wrong the moment the dispatcher grew a failure
-- counter. `recordAttempt` updates consecutiveFailures on every attempt and
-- clears it on success, and disables an endpoint that has failed too many times
-- in a row. Under a SELECT-only policy RLS filters the row out, Prisma reports
-- "No record was found for an update", and every delivery attempt ends in an
-- exception AFTER the HTTP request has already been made.
--
-- This went unnoticed for a simple reason: nothing ever created a delivery row,
-- so this code had never run. Wiring up the transactional outbox produced the
-- first delivery in the project's history and the bug surfaced on the first
-- attempt.
--
-- The grant is broader than the need — the dispatcher only ever touches
-- consecutiveFailures, enabled and disabledAt — because RLS is row-level and
-- cannot express a column restriction. Column-level GRANTs could, at the cost
-- of a second permission system to keep in step with this one. The narrowing
-- that matters is already here: this is a distinct GUC, set only by
-- withScheduler(), so every use is greppable.
--
-- Note what it still cannot do: there is no INSERT or DELETE policy. The
-- dispatcher can record how an endpoint is behaving; it cannot create one or
-- remove one.

CREATE POLICY webhook_dispatcher_update ON "Webhook"
  FOR UPDATE
  USING (current_setting('app.scheduler', true) = 'on')
  WITH CHECK (current_setting('app.scheduler', true) = 'on');
