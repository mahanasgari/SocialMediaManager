# Deployment

Self-hosting this on a machine you control. Read the [Before you start](#before-you-start)
section — two of the four items there are the difference between a working
install and one that silently loses a security property.

---

## Quick start

```bash
cp .env.example .env
# fill in every value marked REQUIRED

pnpm preflight          # refuses to proceed on anything genuinely wrong
docker compose up -d
```

The `migrate` service runs to completion before `api`, `worker` and `web` start,
so a first boot is one command and a schema change cannot race the processes
that depend on it.

The app is then on `http://localhost:3000`. The first account created becomes
the organization owner, regardless of `AUTH_REGISTRATION` — without that, an
`invite`-mode install would have nobody able to send the first invite.

---

## Before you start

### 1. Generate real secrets

```bash
openssl rand -base64 32   # ENCRYPTION_KEY, SESSION_SECRET
openssl rand -base64 24   # POSTGRES_PASSWORD, APP_DB_PASSWORD, REDIS_PASSWORD, S3_SECRET_ACCESS_KEY
```

`ENCRYPTION_KEY` must decode to **exactly 32 bytes** — it is the KEK that wraps
every stored OAuth credential. The application refuses to boot if it is missing,
the wrong length, or left as the documented example.

Nothing in `docker-compose.yml` has a default password. That is deliberate: a
compose file that boots with `POSTGRES_PASSWORD=smm` is one somebody deploys to
a VPS unchanged.

### 2. Put TLS in front of it

`PUBLIC_URL` decides the cookie policy, and the decision is not cosmetic:

| `PUBLIC_URL` | Session cookie | Boot |
|---|---|---|
| `https://…` | `__Host-smm_session`, `Secure` | normal |
| `http://localhost…` | `smm_session`, no `Secure` | normal — browsers exempt localhost |
| `http://` any other host | `smm_session`, no `Secure` | **refuses** unless `ALLOW_INSECURE_COOKIES=true` |

Over plain http on a real hostname, anyone on the network path can read a
session cookie and become that user. On a firewalled LAN that may be an
acceptable trade; on the internet it is not. The refusal exists so the trade is
made deliberately rather than discovered later.

Any TLS-terminating proxy works. Caddy is two lines:

```
social.example.com {
    reverse_proxy localhost:3000
}
```

**Do not put the API on a second hostname.** `apps/web` reverse-proxies `/api/*`
so the browser only ever sees one origin. That single-origin invariant is what
makes `SameSite=Lax` sufficient for CSRF and the `__Host-` prefix available.
Splitting the origins requires re-deriving the whole CSRF posture — CORS with
credentials, `SameSite=None`, and a real token scheme. See `SECURITY.md` §3.

### 3. Decide how platforms reach your media

Instagram **pulls** media from a public HTTPS URL rather than accepting an
upload. `MEDIA_PUBLIC_MODE` decides how:

| Mode | When | Effect |
|---|---|---|
| `relay` (default) | only the app is public | The API streams objects from storage. Storage stays private. |
| `presigned-s3` | storage is itself internet-reachable | Fewest hops. Publish the minio port or use a hosted bucket. |
| `disabled` | nothing is public | Instagram is marked **unavailable at boot**, with a stated reason, rather than failing at publish time. |

The relay has no SSRF surface: it never accepts a URL, only an opaque HMAC token
naming an object already in storage.

### 4. Decide about email

`SMTP_URL` is optional, and its absence is a supported configuration — plenty of
self-hosted deployments have no mail server.

Without it, password-reset and email-confirmation links are written to the
**server log** in full, the API reports `delivered: false`, and the sign-in page
says so *before* the form rather than after somebody submits into a void.

The alternative — pretending to send — turns "reset your password" into a
feature that silently does nothing while someone waits for an email that was
never coming.

---

## What runs

| Service | Purpose | Published |
|---|---|---|
| `web` | Next.js, and the `/api/*` proxy | **yes**, `WEB_PORT` |
| `api` | REST API, OAuth callbacks, inbound webhooks | no |
| `worker` | Scheduler, publishing, inbox dispatch, metrics, retention | no |
| `postgres` | System of record | no |
| `redis` | Rate-limit buckets, session cache, queues | no |
| `minio` | Media storage | no |

Only the web port is published. Everything else talks over the compose network.

### Single container

`docker/Dockerfile` has an `all-in-one` target that supervises all three
processes. It costs roughly 150–250 MB extra RSS and loses the ability to scale
the worker independently. If any child exits, the container exits, so the
orchestrator restarts the whole unit rather than leaving it running silently
degraded.

---

## Upgrading

```bash
git pull
docker compose build
docker compose up -d
```

`migrate` runs first and the others wait for it. Migrations are forward-only.

**Back up before upgrading.** There is no automated rollback, and a migration
that has run cannot be un-run:

```bash
docker compose exec postgres pg_dump -U "$POSTGRES_USER" smm | gzip > backup.sql.gz
```

---

## Operating it

### Is it working?

The **Administration** page answers exactly that, and it is the page to open
first when something feels wrong. It reports scheduler backlog, inbound events
that matched no connected account, credentials about to expire, auto-disabled
webhooks, and stalled feeds — the failures that are otherwise silent.

A self-hosted deployment has no support team watching dashboards, so the things
that fail quietly need somewhere to be visible.

### Health checks

`GET /api/v1/health` reports dependency status and confirms row-level security
is actually enforced for the connection. Both `api` and `web` have Compose
healthchecks; `worker` has none by design, because a worker with nothing to do
is indistinguishable from a healthy one over HTTP.

### Deploys drop no requests

The API drains in-flight requests on `SIGTERM` for up to `SHUTDOWN_GRACE_MS`
(default 15s). Keep that **below** the orchestrator's `stop_grace_period`, or
the drain is cut short by a `SIGKILL` and the graceful shutdown is decorative.

The worker finishes its current tick. A publish interrupted mid-flight is
recovered on the next start by the write-ahead attempt row and reconciliation —
that path exists precisely because processes die at inconvenient moments.

### Retention

Runs hourly inside the worker. Workspace deletion is a two-step: soft-delete,
then a grace period of `WORKSPACE_PURGE_GRACE_DAYS` (default 30), and the UI
shows the **actual purge date**. Until then an owner or admin can restore it.

At purge, S3 objects go before the rows — if the rows went first and the process
died, the storage keys would be unrecoverable and the objects orphaned forever.
Audit entries survive, minimised to actor, action and timestamp: a deletion
record that deletes itself is not a record.

---

## Without Docker

```bash
pnpm install
pnpm --filter @smm/database exec prisma generate
pnpm build

# migrations as the database OWNER, then provision the app role
bash docker/migrate.sh

node apps/api/dist/main.js
node apps/worker/dist/main.js
node apps/web/.next/standalone/apps/web/server.js
```

`ffmpeg` and `ffprobe` must be on `PATH` for video transcoding. Without them the
worker still runs and publishes conforming media untouched; non-conforming video
fails with a message saying exactly that.

Node 22 or later.

---

## Two things to know about the database

**The application connects as an unprivileged role.** A superuser bypasses
row-level security unconditionally, and `FORCE ROW LEVEL SECURITY` does not
change that — it only removes the table owner's exemption. Connected as the
owner, every tenant-isolation policy is silently inert while `pg_policies` still
lists them all correctly. The API checks this at boot by *behaviour*, not by
configuration, and refuses to serve if it can bypass RLS.

That is why there are two connection strings, and why `docker/migrate.sh` is a
script rather than a Postgres init file: the privilege role is created by a
migration, so the login role can only be granted membership afterwards.

**pgBouncer in transaction mode works.** Tenant context is set per unit of work
with `set_config(..., true)` rather than per connection, so no state leaks
between borrowed connections. Do not "fix" this to session pooling — see
`ARCHITECTURE.md` §2.3.
