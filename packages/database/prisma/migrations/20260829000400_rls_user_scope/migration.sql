-- Per-user access under RLS.
--
-- The previous policies keyed on workspace and organization. That covers every
-- query made INSIDE a tenant, but it cannot express the query that comes first:
-- "which workspaces does this person belong to?" There is no workspace to scope
-- by, because discovering the answer is how you learn what to scope by.
--
-- With only tenant-keyed policies, membership discovery returned zero rows and a
-- freshly registered user saw an empty workspace list — correct behaviour from
-- RLS, and a broken product.
--
-- The right rule is not "let the system bypass this". It is that a user may
-- always read their OWN memberships, and the workspaces those memberships grant.
-- Expressed as policy, that rule is enforced by the database rather than by
-- remembering to filter on userId in application code.
--
-- Postgres policies are PERMISSIVE and OR'd together, so these ADD a path
-- without weakening tenant isolation: neither policy exposes a row belonging to
-- a workspace the user is not a member of.

-- A user may always read their own membership rows.
CREATE POLICY membership_self_read ON "Membership"
  FOR SELECT
  USING ("userId"::text = current_setting('app.current_user', true));

-- A user may read workspaces they are a member of.
--
-- The subquery reads "Membership", which is itself under RLS — but the policy
-- above already permits exactly the rows this needs (the user's own), so there
-- is no recursion problem and no need for a SECURITY DEFINER function.
CREATE POLICY workspace_member_read ON "Workspace"
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM "Membership" m
      WHERE m."workspaceId" = "Workspace"."id"
        AND m."userId"::text = current_setting('app.current_user', true)
        AND m."deletedAt" IS NULL
    )
  );

-- Note both are FOR SELECT only. Writing a membership or a workspace still
-- requires an organization scope, so a user cannot grant themselves access to
-- anything by virtue of being able to see it.
