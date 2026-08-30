#!/usr/bin/env bash
# Brings up a disposable Postgres for integration tests and applies migrations.
#
# Port 55432, not 5432, so this cannot collide with a Postgres the developer
# already runs — an integration suite that silently points at someone's real
# database is a bad afternoon.
#
# TWO ROLES, deliberately:
#
#   smm           owner/superuser — runs migrations only
#   smm_app_user  unprivileged login, member of smm_app — what the app connects as
#
# This split is not tidiness. Superusers bypass row-level security
# unconditionally, and FORCE ROW LEVEL SECURITY does not change that — it only
# removes the table OWNER's exemption. Connecting as the owner makes every
# tenant-isolation policy silently inert while `pg_policies` still shows them
# all present. See packages/database/prisma/migrations/*_app_role.
set -euo pipefail

CONTAINER="${SMM_TEST_PG_CONTAINER:-smm-test-pg}"
REDIS_CONTAINER="${SMM_TEST_REDIS_CONTAINER:-smm-test-redis}"
REDIS_PORT="${SMM_TEST_REDIS_PORT:-56379}"
PORT="${SMM_TEST_PG_PORT:-55432}"
OWNER_URL="postgresql://smm:smm@localhost:${PORT}/smm_test"
APP_URL="postgresql://smm_app_user:smm@localhost:${PORT}/smm_test"
REDIS_URL="redis://localhost:${REDIS_PORT}"

case "${1:-up}" in
  up)
    if ! docker info >/dev/null 2>&1; then
      echo "Docker daemon is not running. Start Docker Desktop and retry." >&2
      exit 1
    fi

    if docker ps -a --format '{{.Names}}' | grep -qx "$CONTAINER"; then
      docker start "$CONTAINER" >/dev/null
    else
      docker run -d --name "$CONTAINER" \
        -e POSTGRES_USER=smm -e POSTGRES_PASSWORD=smm -e POSTGRES_DB=smm_test \
        -p "${PORT}:5432" postgres:17-alpine >/dev/null
    fi

    printf 'waiting for postgres'
    for _ in $(seq 1 60); do
      if docker exec "$CONTAINER" pg_isready -U smm -d smm_test >/dev/null 2>&1; then
        echo ' ready'
        break
      fi
      printf '.'
      sleep 1
    done

    # Migrations run as the owner. They also create the smm_app privilege role.
    DATABASE_URL="$OWNER_URL" npx --yes prisma@6 migrate deploy \
      --schema packages/database/prisma/schema.prisma

    docker exec -i "$CONTAINER" psql -U smm -d smm_test -v ON_ERROR_STOP=1 -q \
      -f /dev/stdin <<'SQL'
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'smm_app_user') THEN
    CREATE ROLE smm_app_user LOGIN PASSWORD 'smm' NOSUPERUSER NOBYPASSRLS;
  END IF;
END
$$;
GRANT smm_app TO smm_app_user;
SQL

    # Redis, for the rate-limiter suite. Those tests run against a real Redis
    # because the properties under test — atomicity across keys, no over-issue
    # under concurrency — are properties of Redis script execution. A mock would
    # only assert that our code calls eval.
    if docker ps -a --format '{{.Names}}' | grep -qx "$REDIS_CONTAINER"; then
      docker start "$REDIS_CONTAINER" >/dev/null
    else
      docker run -d --name "$REDIS_CONTAINER" -p "${REDIS_PORT}:6379" redis:7-alpine >/dev/null
    fi

    echo
    echo "TEST_DATABASE_URL=$APP_URL"
    echo "TEST_REDIS_URL=$REDIS_URL"
    ;;

  down)
    docker rm -f "$CONTAINER" "$REDIS_CONTAINER" >/dev/null 2>&1 || true
    echo "removed $CONTAINER and $REDIS_CONTAINER"
    ;;

  url)
    echo "$APP_URL"
    ;;

  owner-url)
    echo "$OWNER_URL"
    ;;

  *)
    echo "usage: $0 [up|down|url|owner-url]" >&2
    exit 1
    ;;
esac
