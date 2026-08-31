# API

Versioned REST at `/api/v1`, served by `apps/api` (NestJS). OpenAPI is generated from decorators and published at `/api/v1/openapi.json`, with a browsable UI at `/api/v1/docs`.

---

## 1. The single-origin invariant

`apps/web` reverse-proxies `/api/*` to `apps/api`. **The browser only ever talks to one origin.**

This is not a deployment convenience — it is what makes the CSRF posture in `SECURITY.md` sound. Same-origin means no CORS, `SameSite=Lax` is sufficient, and the `__Host-` cookie prefix is available. Moving the API to `api.example.com` invalidates all three and requires re-deriving the security model first.

Server-to-server traffic from `apps/web` goes direct to `INTERNAL_API_URL`, bypassing the proxy hop.

---

## 2. Authentication — two modes, never blended

### Session (the web app)

Opaque random 256-bit session ID in a cookie. **Not a JWT** — sessions are authoritative in Postgres so they are listable in a "your devices" view and revocable immediately, cached in Redis with a short TTL.

Cookie name and flags depend on `PUBLIC_URL`; see `SECURITY.md` §3.

### API key (machines)

```
Authorization: Bearer smm_live_<32 bytes base62>
```

Hashed at rest with the prefix stored separately for display. Scoped to an organization or a workspace, with an explicit scope list. The secret is shown **once at creation and never again**.

### Two hard rules

1. **A request presenting both a session cookie and an API key is rejected** with `401 auth_mode_conflict` — never resolved by precedence.
2. **API-key requests never receive `Set-Cookie`.**

> Blending the two is how public-API-plus-web-app products get owned: a browser-borne request that silently upgrades to API-key authority is a confused deputy. Rejecting the ambiguity outright costs one error path and removes the entire class.

The worker uses neither. It calls `packages/auth` permission functions directly against a system principal with an explicit workspace scope, so authorization logic is shared rather than bypassed.

---

## 3. Conventions

### Request

| Header | Purpose |
|---|---|
| `X-Request-Id` | Propagated through API, worker and job logs. Generated if absent. |
| `Idempotency-Key` | Accepted on every unsafe method. Required on `POST /posts/:id/publish`. |
| `X-SMM-Client` | `web` for browser traffic; part of the CSRF defence in depth. |

### Response envelope

Success returns the resource or a collection directly. Errors are uniform:

```json
{
  "error": {
    "code": "media_invalid_aspect_ratio",
    "message": "Instagram feed posts require an aspect ratio between 4:5 and 1.91:1. This image is 3:1.",
    "field": "media[0]",
    "requestId": "01J8Z9...",
    "details": { "provider": "instagram", "surface": "feedImage", "actual": 3.0 }
  }
}
```

`message` is written for a person, not a log parser. **"API Error 400" is never an acceptable message** — see the error taxonomy in `PROVIDERS.md` §7.

| Status | Meaning |
|---|---|
| 400 | Validation failure — `details` names the field |
| 401 | Unauthenticated, or `auth_mode_conflict` |
| 403 | Authenticated but not permitted |
| 404 | Not found **or not in your workspace** — never distinguished, to avoid leaking existence |
| 409 | Conflict, including idempotency-key replay with a different body |
| 422 | Semantically invalid (e.g. scheduling into the past beyond the catch-up window) |
| 429 | Rate limited — `Retry-After` always present |
| 503 | Dependency unavailable |

### Pagination

**Cursor by default.** Offset is available only where a total count is genuinely needed (admin tables), because offset pagination degrades badly and produces duplicates when rows shift.

```
GET /api/v1/posts?limit=50&cursor=eyJpZCI6...
{ "data": [...], "nextCursor": "eyJpZCI6...", "hasMore": true }
```

### Filtering and sorting

`?status=SCHEDULED,PUBLISHING&platform=mastodon&campaignId=...&from=...&to=...&sort=-scheduledAt`

Every collection endpoint is workspace-scoped by the tenancy guard. A `workspaceId` in the query is validated against membership, never trusted.

### Idempotency

Keys are stored with a hash of the request body and a 24-hour TTL. Replaying a key returns the original response. Replaying with a *different* body returns `409 idempotency_key_reuse`.

---

## 4. Resource map

Base: `/api/v1`

### Identity
| Method | Path | Notes |
|---|---|---|
| POST | `/auth/register` | Honours `AUTH_REGISTRATION`; first account on an empty DB always becomes owner |
| POST | `/auth/login` `/auth/logout` | |
| POST | `/auth/password/forgot` `/auth/password/reset` | |
| POST | `/auth/email/verify` | |
| GET | `/auth/sessions` · DELETE `/auth/sessions/:id` | Device list and revocation |
| GET/PATCH | `/me` | Profile, timezone, locale, notification preferences |

### Tenancy
| Method | Path |
|---|---|
| GET/POST | `/organizations` · GET/PATCH `/organizations/:id` |
| GET/POST | `/workspaces` · GET/PATCH/DELETE `/workspaces/:id` |
| GET | `/workspaces/:id/members` · PATCH/DELETE `/workspaces/:id/members/:userId` |
| POST | `/invites` · POST `/invites/:token/accept` · DELETE `/invites/:id` |

`DELETE /workspaces/:id` soft-deletes and returns `purgeAt` — the actual date, which the UI shows rather than "soon".

### Providers and accounts
| Method | Path | Notes |
|---|---|---|
| GET | `/social-providers` | Capability matrix + `configured` + `status: implemented\|skeleton\|mock`. **The UI renders controls from this response only.** |
| POST | `/social-accounts/connect/:provider` | Returns the auth redirect |
| GET | `/social-accounts/callback/:provider` | May yield several accounts (Pages, channels) |
| GET | `/social-accounts` · GET/PATCH/DELETE `/social-accounts/:id` | |
| POST | `/social-accounts/:id/reconnect` | Matches on `(workspaceId, provider, providerAccountId)`; never duplicates |

### Content
| Method | Path |
|---|---|
| GET/POST | `/posts` · GET/PATCH/DELETE `/posts/:id` |
| POST | `/posts/:id/duplicate` · `/posts/:id/schedule` · `/posts/:id/publish` · `/posts/:id/cancel` |
| POST | `/posts/:id/submit-for-approval` |
| GET/PATCH | `/posts/:id/variants` · `/post-variants/:id` |
| POST | `/post-variants/:id/retry` | Retries one variant without touching siblings |
| POST | `/post-variants/:id/resolve-review` | Exits `NEEDS_REVIEW`: `published` or `retry` |
| POST | `/posts/bulk` | CSV import with row-level errors |
| GET | `/calendar?from&to&view` | Range-optimised projection |

### Media
| Method | Path |
|---|---|
| POST | `/media/upload-url` — presigned PUT |
| POST | `/media` — register after upload; triggers probe |
| GET | `/media` · GET/PATCH/DELETE `/media/:id` |
| GET | `/media/:id/renditions` |
| GET | `/media/relay/:token` — **unauthenticated**, short-TTL HMAC capability for platforms that pull media |

### Engagement
`/inbox/conversations`, `/inbox/conversations/:id/messages`, `POST .../reply`, `POST .../assign`, `POST .../note`, `PATCH .../read`, `/saved-responses`.

Endpoints for a capability the provider lacks return `422 capability_unsupported` with the provider named. The UI should never call them, because it renders from the capability matrix — but the API refuses regardless.

### Analytics and reports
### Operations

| Route | Notes |
|---|---|
| `GET /health` | Per-dependency status, plus whether RLS is actually enforced for the connected role |
| `GET /metrics` | Prometheus text. Public by design — a scraper has no session and never will. `METRICS_TOKEN`, if set, requires `Authorization: Bearer`; unset on an `https://` origin the API warns on every boot |

The worker exposes its own registry on `WORKER_METRICS_PORT` (default 9464),
path `/metrics`, with the same optional token. Separate because the two
processes measure themselves: a worker that has died should disappear from the
scrape, not be reported as zero by the API.

### Export

| Route | Notes |
|---|---|
| `GET /exports` | Jobs in a workspace, newest first |
| `POST /exports` | `{ kind: WORKSPACE \| SUBJECT, subjectHandle? }`. One in flight per workspace; a second returns 409 `export_in_progress` |
| `GET /exports/:id/download` | Streams the gzipped JSON through the API, never a presigned storage URL. Distinct 409s for not-ready, failed and expired — one "not available" sends three different people to ask the same question |

All three require `reports.export` (OWNER, ADMIN, ANALYST). A subject export is
a bundle of one person's private messages; the roles that cannot open the inbox
must not be able to download it in a file instead.

### Organisation

| Route | Notes |
|---|---|
| `GET/POST /campaigns`, `PATCH/DELETE /campaigns/:id` | Deleting keeps the posts — the response reports how many were ungrouped |
| `GET/POST /labels`, `DELETE /labels/:id` | |
| `POST /posts/:id/labels` | Replaces the set, so removal is expressible. Label ids are checked against the workspace first: a join row carrying our `workspaceId` but pointing at another tenant's label would pass RLS while dangling |
| `GET/POST/PATCH/DELETE /templates` | `variables` is derived from the body on write |
| `POST /templates/:id/render` | Returns `{ text, missing, unused }`. `commit: true` counts a use, and only when nothing is missing — counting previews would make the ordering measure typing |
| `GET/POST/DELETE /utm-presets` | One default per workspace, cleared and set in one transaction |
| `POST /utm-presets/:id/apply` | Returns the tagged text, the count, and every link it skipped with the reason |

`/analytics/overview`, `/analytics/posts`, `/analytics/accounts`, `/analytics/audience`, `/analytics/campaigns` — all served from `AnalyticsSnapshot`, never live provider calls.

`/reports`, `/reports/:id/run`, `/reports/:id/export?format=pdf|csv`.

### Organization
`/campaigns`, `/labels`, `/templates`, `/utm-templates`, `/queues`, `/queue-slots`, `/recurring-rules`, `/link-pages`, `/link-pages/:id/links`.

### Platform
`/api-keys`, `/webhooks`, `/webhooks/:id/deliveries`, `/webhooks/:id/deliveries/:deliveryId/replay`, `/integrations`, `/rss-feeds`, `/notifications`, `/audit-logs`.

### Inbound hooks — a different surface entirely
| Method | Path |
|---|---|
| POST | `/hooks/:provider` |
| GET | `/hooks/:provider` — Meta's `hub.challenge` handshake |

Exempt from session auth and the tenancy guard, because there is no user and no workspace yet. **Never exempt from signature verification.** 64 KB body cap, per-source rate limit, IP allowlist where the provider publishes ranges. See `SECURITY.md` §5 — this is the one place workspace context derives from untrusted input.

### Operations
`/health` (DB, Redis, S3), `/health/ready`, `/admin/*` (operator console; **admin actions are audited like any other**).

---

## 5. Rate limits

Two independent layers, often confused:

| Layer | Protects | Mechanism |
|---|---|---|
| **Inbound API rate limit** | Our API from our callers | Per session, per API key, per IP. `429` + `Retry-After`. |
| **Outbound provider budget** | Provider quota from us | `packages/ratelimit` token buckets, consulted before every provider call. Never surfaced as a client 429. |

A client is never told "rate limited" because *we* are out of provider quota — that job is deferred and the post stays `SCHEDULED`. Conflating the two would make a scheduling delay look like a client error.

Defaults: 1000 req/15 min per session; per-key limits configurable; 20 req/min on auth endpoints; 60 req/min per source on inbound hooks.

---

## 6. Webhook event catalogue

Outbound deliveries are signed HMAC-SHA256 over the raw body:

```
X-SMM-Signature: t=1735689600,v1=<hex>
X-SMM-Event: post.published
X-SMM-Delivery: <uuid>
```

Verify by recomputing over the **raw bytes** and comparing in constant time. Reject timestamps older than five minutes.

| Event | Fires when |
|---|---|
| `post.created` `post.updated` `post.scheduled` `post.cancelled` | Lifecycle |
| `post.publishing` `post.published` `post.partially_published` `post.failed` | Publish outcomes |
| `post.missed` | Overdue beyond the catch-up window; needs a human decision |
| `post.needs_review` | Reconciliation could not determine whether it published |
| `variant.published` `variant.failed` | Per-channel granularity |
| `account.connected` `account.disconnected` | |
| `account.token_expired` `account.permission_revoked` | Actionable — the account needs reconnecting |
| `approval.requested` `approval.approved` `approval.rejected` | |
| `comment.created` `message.received` | Inbox, where supported |
| `analytics.updated` | A metric refresh completed |
| `workspace.purge_scheduled` | Soft-deleted; carries the purge date |
| `system.backlog` | The scanner found more due posts than one tick can claim |

**Delivery semantics:** at-least-once. Retries at 1m, 5m, 15m, 1h, 6h. Twenty consecutive failures disables the endpoint and emits a notification. Every attempt is recorded in `WebhookDelivery` with the response status and body, and any delivery can be replayed manually.

Consumers must be idempotent and should key on `X-SMM-Delivery`.

---

## 7. Versioning

`/api/v1` is stable. Additive changes — new fields, new optional parameters, new endpoints — ship without a version bump. Breaking changes get `/api/v2` with both served during a deprecation window announced through `Deprecation` and `Sunset` headers.

Enum values are additive: clients must tolerate unknown values rather than exhaustively switching on them. This matters because `VariantStatus` and the provider list both grow.
