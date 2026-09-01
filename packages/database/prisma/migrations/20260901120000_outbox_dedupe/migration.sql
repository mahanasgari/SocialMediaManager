-- Idempotency keys for outbox consumers.
--
-- The transactional outbox delivers AT LEAST ONCE, by design and unavoidably:
-- the dispatcher can crash after writing a side-effect row and before marking
-- the event dispatched, and the only safe response to "I do not know whether
-- that landed" is to do it again.
--
-- That places a requirement on every consumer rather than on the dispatcher.
-- These two columns are how the requirement is met for the two consumers that
-- exist: a redelivery computes the same key, collides with the row already
-- written, and does nothing. Without them, one crash sends every subscriber a
-- duplicate webhook and every editor a duplicate notification.
--
-- NULLABLE with a plain unique index, deliberately. Postgres treats NULLs as
-- distinct, so rows created by anything other than the dispatcher — an approval
-- notification, say — are unconstrained and need not invent a key.

ALTER TABLE "WebhookDelivery" ADD COLUMN "dedupeKey" TEXT;
ALTER TABLE "Notification" ADD COLUMN "dedupeKey" TEXT;

CREATE UNIQUE INDEX "WebhookDelivery_dedupeKey_key" ON "WebhookDelivery"("dedupeKey");
CREATE UNIQUE INDEX "Notification_dedupeKey_key" ON "Notification"("dedupeKey");
