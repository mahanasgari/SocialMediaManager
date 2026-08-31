-- The crash reconciler's cross-workspace read.
--
-- "Which publishes were in flight when a worker died?" spans every workspace by
-- definition, exactly like the scheduler sweep and the retention sweep before
-- it. This is the fifth time this shape has appeared, and twice it shipped as a
-- bug, so it is worth naming plainly: a query that legitimately runs BEFORE any
-- tenant is known matches zero rows under tenant-keyed RLS. Nothing errors. The
-- sweep reports success having found nothing, forever.
--
-- Here that silence would be the worst one yet. A stale IN_FLIGHT attempt is a
-- post that may or may not have reached the public internet, and a reconciler
-- that finds none leaves the variant stuck in PUBLISHING until a human notices.
--
-- A SEPARATE actor rather than widening app.scheduler, because the grant is
-- genuinely different: this is the only actor that reads PublishAttempt, and
-- PublishAttempt is the record of what we sent to a third party and when.
-- That does not belong on the actor that runs every thirty seconds to ask which
-- posts are due.
--
-- SELECT only. The reconciler's sweep discovers candidate ids and workspace
-- ids; every decision and every write after that happens under withTenant(),
-- fully scoped, using the same code the live publisher uses. So the grant
-- covers the discovery alone and nothing else — it cannot close an attempt,
-- cannot touch a variant, cannot read a credential.

CREATE POLICY publishattempt_reconciler_read ON "PublishAttempt"
  FOR SELECT
  USING (current_setting('app.reconciler', true) = 'on');
