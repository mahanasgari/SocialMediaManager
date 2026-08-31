#!/bin/sh
# Migration entrypoint.
#
# Runs as the database OWNER, then provisions the unprivileged role the
# application actually connects as.
#
# The split is not tidiness. Superusers bypass row-level security
# unconditionally, and FORCE ROW LEVEL SECURITY does NOT change that — it only
# removes the table owner's exemption. The official postgres image creates
# POSTGRES_USER as a superuser, so an application connecting with those
# credentials would silently ignore every tenant-isolation policy while
# pg_policies still showed them all correctly configured.
#
# Ordering matters here: the `smm_app` privilege role is created by a migration,
# so the login role can only be granted membership AFTER migrations have run.
# That is why this is a script rather than a postgres init file.
set -eu

SCHEMA=packages/database/prisma/schema.prisma

# The CLI is invoked DIRECTLY rather than through `pnpm exec`, for two reasons.
#
# It did not work. `prisma` is a devDependency of packages/database, so pnpm's
# non-hoisted layout puts the binary in packages/database/node_modules/.bin —
# and `pnpm exec` from the workspace root looks in the root .bin, finds nothing,
# and exits with "Command prisma not found". The migrate container died there,
# and because every service waits on migrate completing, the whole stack
# refused to start.
#
# And it should not need to. Going through pnpm made corepack fetch pnpm from
# registry.npmjs.org on every migration run, so applying a schema change
# required outbound internet access — on a self-hosted box that may not have
# any, and on any box it is a network round trip standing between the database
# and the thing that migrates it.
PRISMA=packages/database/node_modules/.bin/prisma

echo "==> applying migrations as owner"
DATABASE_URL="$MIGRATE_DATABASE_URL" "$PRISMA" migrate deploy --schema "$SCHEMA"

APP_USER="${APP_DB_USER:-smm_app_user}"
APP_PASSWORD="${APP_DB_PASSWORD:?APP_DB_PASSWORD must be set}"

echo "==> ensuring unprivileged application role '$APP_USER'"
# prisma db execute is used rather than psql so the image needs no postgres
# client package.
cat <<SQL | DATABASE_URL="$MIGRATE_DATABASE_URL" "$PRISMA" db execute --stdin --schema "$SCHEMA"
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '$APP_USER') THEN
    CREATE ROLE "$APP_USER" LOGIN PASSWORD '$APP_PASSWORD' NOSUPERUSER NOBYPASSRLS;
  ELSE
    ALTER ROLE "$APP_USER" PASSWORD '$APP_PASSWORD' NOSUPERUSER NOBYPASSRLS;
  END IF;
END
\$\$;
GRANT smm_app TO "$APP_USER";
SQL

echo "==> migrations complete; application role ready"
