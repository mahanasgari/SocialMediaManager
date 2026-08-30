-- The inbound router actor.
--
-- Routing an inbound event is a CROSS-CUTTING QUERY THAT PRECEDES TENANCY: the
-- receiver must find every SocialAccount matching a providerAccountId, across
-- all workspaces, before it knows whose event this is. Deciding that is the
-- whole problem the receiver exists to solve.
--
-- Without this the lookup runs with no app.current_workspace set, matches zero
-- rows, and EVERY event is classified as unrouted and dropped. That failure is
-- completely silent — the inbox simply stays empty and nothing logs an error —
-- which is exactly why it gets its own named actor rather than a quiet widening
-- of app.scheduler.
--
-- The grant is deliberately minimal: SELECT only, on the one table routing
-- needs. It cannot read message bodies, credentials, or posts.

CREATE POLICY socialaccount_inbound_router ON "SocialAccount"
  FOR SELECT
  USING (current_setting('app.inbound_router', true) = 'on');

-- The receiver writes the event and its deliveries under the same actor.
CREATE POLICY inboundevent_router ON "InboundEvent"
  FOR ALL
  USING (current_setting('app.inbound_router', true) = 'on')
  WITH CHECK (current_setting('app.inbound_router', true) = 'on');

CREATE POLICY inboundeventdelivery_router ON "InboundEventDelivery"
  FOR ALL
  USING (current_setting('app.inbound_router', true) = 'on')
  WITH CHECK (current_setting('app.inbound_router', true) = 'on');

CREATE POLICY unroutedinboundevent_router ON "UnroutedInboundEvent"
  FOR ALL
  USING (current_setting('app.inbound_router', true) = 'on')
  WITH CHECK (current_setting('app.inbound_router', true) = 'on');
