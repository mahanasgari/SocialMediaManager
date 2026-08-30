# TASKS

Execution plan. Grouped by phase, then by vertical slice.

Every task carries a **stable ID**, a one-line description, **dependencies by ID**, an effort band, and acceptance criteria written so that passing or failing is unambiguous. Each phase ends with a **gate task**.

**Effort bands:** S = under a day · M = one to three days · L = a week or more.

**Re-planning:** Phases 0–2 are detailed enough to start immediately. Phases 3–4 are moderately detailed. **Phases 5–12 are deliberately coarse and are expected to be re-planned** once Phase 4 lands and the anchor connector has produced its divergence report — that report will change assumptions that later phases depend on.

---

## Standing gates

Enforced by static check in CI on **every** phase gate, not by reviewer memory:

| Gate | Check |
|---|---|
| **G1** | No tenant-scoped model without an isolation test (DMMF-driven suite) |
| **G2** | No outbound provider call without a declared rate budget |
| **G3** | No `[V]` marker without a source URL and retrieval date <!-- evidence-gate:ignore --> |
| **G4** | Type-check, lint, unit, integration, and the phase's E2E flow all green |

---

## Phase 0 — Design and scaffold

| ID | Task | Deps | Effort | Acceptance |
|---|---|---|---|---|
| P0-01 | Monorepo scaffold: pnpm workspaces, Turborepo, strict TS base config | — | S | `pnpm typecheck` runs across all packages and exits 0 |
| P0-02 | Seven design documents at repository root | — | L | PRD, ARCHITECTURE, DATABASE, PROVIDERS, API, SECURITY, TASKS all present and internally consistent |
| P0-03 | `docker-compose.yml` with web, api, worker, postgres, redis, minio, migrate one-shot | P0-01 | M | `docker compose config` validates; `migrate` is a `service_completed_successfully` dependency of api/worker |
| P0-04 | Multi-stage `Dockerfile` with api/worker/web/migrate/all-in-one targets; ffmpeg in the runtime layer | P0-03 | M | Each target builds; `ffmpeg -version` succeeds inside the runtime image |
| P0-05 | `.env.example` documenting every variable, grouped required vs optional-per-provider | — | S | Every variable read by `packages/config` appears; no real secrets present |
| P0-06 | `packages/config` zod env schema; boot fails loudly on missing required values | P0-01, P0-05 | M | Booting without `ENCRYPTION_KEY` exits non-zero with a message naming the variable |
| P0-07 | CI workflow: typecheck, lint, test, plus gates G1–G3 | P0-01 | M | Workflow runs on PR; a deliberately uncited `[V]` marker fails the build <!-- evidence-gate:ignore --> |
| P0-08 | Evidence-marker gate script | P0-07 | S | `node scripts/gate-evidence-markers.mjs` exits 0 on the current docs and 1 when a citation is removed |
| P0-09 | ESLint import-boundary rules per `ARCHITECTURE.md` §2 | P0-01 | M | A test fixture importing `@smm/database` from `apps/web` fails lint |
| **P0-G** | **Gate** | all P0 | S | Typecheck, lint and tests green; `docker compose config` validates; G3 enforced in CI. **Not** `docker compose up` — the app images cannot build until Phase 1 gives `apps/*` source, so that criterion belongs to P1-G |

---

## Phase 1 — Foundation

### Slice 1.1 — Database and tenancy

| ID | Task | Deps | Effort | Acceptance |
|---|---|---|---|---|
| P1-01 | Prisma schema: Organization, Workspace, User, Membership, Session, Invite, AuditLog | P0-06 | M | `prisma migrate dev` applies cleanly; UUID v7 defaults confirmed |
| P1-02 | Tenancy client extension — requires workspace/org scope or throws | P1-01 | L | An unscoped query on a tenant-scoped model throws `MissingTenantScope` |
| P1-03 | Soft-delete in the same extension (`deletedAt IS NULL` applied automatically) | P1-02 | M | Soft-deleted rows absent from normal reads; explicit `withDeleted()` returns them |
| P1-04 | Postgres RLS on high-risk tables + `SET LOCAL` helper | P1-02 | L | RLS blocks a `$queryRaw` that skips the extension |
| P1-05 | **Transaction boundary guard** (`AsyncLocalStorage` → `TransactionBoundaryViolation`) | P1-02 | M | A provider HTTP call inside an open transaction throws; S3 and enqueue covered |
| P1-06 | **Transactional outbox** + `outbox-dispatch` drain | P1-05 | M | Domain write and outbox row commit atomically; killing the dispatcher mid-drain redelivers |
| P1-07 | **DMMF-driven isolation suite** | P1-02, P1-03 | L | Adding a tenant-scoped model without isolation fails the suite automatically |
| P1-08 | Pooled-connection leak test | P1-04 | M | Two requests for different workspaces forced onto one connection see no cross-data |
| P1-04a | **Unprivileged application role + boot-time RLS assertion** | P1-04 | M | Added after the isolation suite found RLS silently inert: `FORCE ROW LEVEL SECURITY` removes only the table *owner's* exemption, and the postgres image's `POSTGRES_USER` is a superuser, which bypasses RLS entirely. Migrations run as owner via `MIGRATE_DATABASE_URL`; the app connects as `smm_app_user` (`NOSUPERUSER NOBYPASSRLS`). `assertRlsApplies()` refuses to boot on a bypassing role. Test asserts the *difference* between the two roles, not the configuration |
| P1-04b | Organization-scope RLS policies | P1-04a | S | A workspace cannot be created under a workspace scope — the policy keys on the row's own id, which does not exist until insert. `app.current_organization` added; Workspace `WITH CHECK` is narrower than `USING` so a workspace scope cannot move a workspace between organizations |

### Slice 1.2 — Identity

| ID | Task | Deps | Effort | Acceptance |
|---|---|---|---|---|
| P1-09 | argon2id password hashing; login, logout, password reset, email verification | P1-01 | M | Reset tokens single-use, hashed, 30-min TTL |
| P1-10 | Server-side sessions in Postgres, Redis-cached; device list and revocation | P1-09 | M | Revoking a session denies the next request immediately, not after TTL |
| P1-11 | **Cookie/TLS policy** per `SECURITY.md` §3 | P1-10, P0-06 | M | `http://` non-localhost `PUBLIC_URL` refuses to boot without `ALLOW_INSECURE_COOKIES` |
| P1-12 | **Registration modes** `open\|invite\|closed` + first-run bootstrap | P1-09 | M | First account on an empty DB becomes owner in every mode; the path closes afterwards |
| P1-13 | Invites: create, accept, expire, single-use | P1-12 | M | Accepting joins the existing org and never creates one |
| P1-14 | Nine roles, granular permissions, single `authorize()` helper | P1-01 | L | Every route handler authorizes through the helper; no inline role checks (lint-enforced) |

### Slice 1.3 — Surfaces

| ID | Task | Deps | Effort | Acceptance |
|---|---|---|---|---|
| P1-15 | NestJS `apps/api` bootstrap: `/api/v1`, `rawBody: true`, error envelope, request IDs, OpenAPI | P0-06 | M | `/api/v1/openapi.json` generates; errors match the `API.md` envelope |
| P1-16 | **Dual-auth rejection** + API-key guard skeleton | P1-15, P1-10 | S | Cookie + Bearer together returns `401 auth_mode_conflict` |
| P1-17 | Next.js `apps/web` shell, Tailwind, shadcn/ui, light and dark | P0-01 | M | Theme switch persists; no unstyled flash |
| P1-18 | **Single-origin proxy** `/api/*` → api | P1-17, P1-15 | S | Browser network tab shows one origin; no CORS preflights |
| P1-19 | **`serverFetch`** cookie/request-ID forwarding + ESLint ban on bare `fetch` | P1-18 | M | A bare `fetch` to the API from `apps/web/app/**` fails lint |
| P1-20 | `/api/v1/health` checking DB, Redis, S3 | P1-15 | S | Returns per-dependency status; compose healthcheck consumes it |
| P1-21 | Orgs, workspaces, members, invites UI | P1-13, P1-14, P1-17 | L | Full CRUD, permission-gated server-side |
| P1-22 | Dashboard shell with configurable widget slots | P1-21 | M | Widgets render from a registry; empty states present |
| P1-04c | Per-user RLS policies for membership discovery | P1-04b | S | Found when a registered user saw an empty workspace list. "Which workspaces do I belong to?" has no workspace to scope by — discovering the answer is how you learn what to scope by. Added `app.current_user` with SELECT-only policies on `Membership` (own rows) and `Workspace` (rows a membership grants), plus `withUser()`. Tested that a different user sees none, and that visibility does not imply write |
| P1-23 | **Build workspace packages to `dist` before production** | — | M | Packages export `.ts` from `main`, which vitest, Next and the SWC loader all handle but plain `node` cannot. `apps/api` therefore runs from source via `@swc-node/register` (esbuild/tsx cannot — they do not emit the decorator metadata NestJS DI needs). Works, but ships TS to production and compiles at boot. Proper per-package builds with an `exports` map are the real fix |
| **P1-G** | **Gate** | all P1 | S | G1–G4 green; isolation, leak, boundary and `$queryRaw` tests all pass; **`docker compose up` reaches healthy from a clean clone** with only the required env vars set |

---

## Phase 2 — Provider architecture

| ID | Task | Deps | Effort | Acceptance |
|---|---|---|---|---|
| P2-01 | `SocialProvider` interface, capability taxonomy, `ProviderLimits`, `MediaProfiles`, `TextProfiles` types | P1-15 | L | `capabilities.ts` compiles only with every key declared |
| P2-02 | **Runtime capability narrowing** (`withCapability`) + `UnsupportedCapability` | P2-01 | M | Calling an uncapable method throws before any network call |
| P2-03 | **Bidirectional contract test suite** | P2-02 | L | `dm: true` without `sendMessage` fails; `dm: false` with `sendMessage` also fails |
| P2-04 | Provider registry + `GET /api/v1/social-providers` with `configured` and `status` | P2-01 | M | An unconfigured provider returns `configured: false`; the app does not crash |
| P2-05 | **`packages/ratelimit`**: Redis token buckets, Lua scripts, `scope: app\|account\|both` | P1-15 | L | DONE. `both` acquires from two buckets in one atomic script; 50 concurrent acquisitions against a capacity of 20 grant exactly 20; a denial never debits. Also: per-account publish mutex with fencing token, verified that an expired holder cannot write or release |
| P2-06 | Adaptive correction: 429 backoff, header reconciliation, `ProviderRateState` writes | P2-05 | M | A 429 halves the refill rate and restores linearly; the table is never read on the hot path |
| P2-07 | Budget refund path | P2-05 | S | Acquiring then aborting returns tokens; verified under concurrency |
| P2-08 | **`MockProvider`** with all nine scenarios incl. `accept_then_hang` | P2-01 | L | Each scenario is deterministically selectable per mock account |
| P2-09 | `ProviderSkeleton` base + disabled-with-reason connect UI | P2-04 | M | A skeleton provider is visible, disabled, and states why |
| P2-10 | OAuth abstraction: state signing, PKCE, redirect allowlist off `PUBLIC_URL` | P2-01 | L | State is single-use, short-TTL, bound to workspace and user |
| P2-11 | **Envelope encryption** + `KeyProvider` + Prisma extension | P1-01 | L | Round-trip and rotation tested; boot fails on a missing or example key |
| P2-12 | Connect / reconnect / disconnect cascades | P2-10, P2-11 | L | Reconnect matches `(workspaceId, provider, providerAccountId)` and never duplicates; disconnect hard-deletes credentials and notifies |
| P2-13 | Demo-mode seed v1 (org, workspaces, members, mock accounts) | P2-08 | M | Seeds without a single external call |
| P2-14 | **File Meta, TikTok, Pinterest and YouTube platform applications** | — | S | Submitted, with dates recorded in `PROVIDERS.md`. Not code — but it belongs here, because the waiting is the long pole |
| **P2-G** | **Gate — reduced proving slice** | all P2 | M | Auth → org+workspace → connect one mock account → single-variant post, no media → publish now → `PUBLISHED` → `PostMetric` row. Exercises tenancy, capability narrowing, budget ordering and the write-ahead path **months before** the full slice, while they are still cheap to change |

---

## Phase 3 — Content and media

| ID | Task | Deps | Effort | Acceptance |
|---|---|---|---|---|
| P3-01 | `packages/storage`: S3 abstraction, presigned upload, upload validation | P0-06 | M | MIME determined by sniffing, never by client header |
| P3-02 | `MediaAsset` + probe (sharp / ffprobe) | P3-01 | M | Dimensions, duration, codec extracted and persisted |
| P3-03 | **Transcoding subsystem**: ffmpeg profiles per provider surface, dedicated concurrency | P3-02, P2-01 | L | Instagram Reel rendition satisfies H264/AAC/faststart; `-movflags +faststart` verified with a byte check on the output |
| P3-04 | `MediaRendition` cache keyed `(assetId, providerProfile)` | P3-03 | M | A second request for the same profile does not re-transcode |
| P3-05 | **Media relay** + `MEDIA_PUBLIC_MODE`, boot-time Instagram availability check | P3-01 | M | `disabled` marks Instagram unavailable at boot with a reason; relay accepts only a token, never a URL |
| P3-06 | Media library UI: folders, tags, search, filter, favourites, archive, restore | P3-02 | L | Bulk operations work; quotas enforced |
| P3-07 | Composer: editor, per-surface live validation, emoji, hashtags, mentions, alt text | P2-01, P1-17 | L | Validation uses the same pure `validate()` the server runs |
| P3-08 | `Post` + `PostVariant` schema, per-channel overrides, `platformOptions` zod validation | P1-01 | L | Unique on `(postId, socialAccountId, surface)` |
| P3-09 | **Cost estimator** in the composer (X per-post pricing, itemised) | P3-07 | M | A link-bearing X variant shows the higher rate distinctly from plain text |
| P3-10 | Content library: search, filters, bulk select/delete/reschedule/duplicate/label | P3-08 | L | Cursor-paginated; no N+1 |
| **P3-G** | **Gate** | all P3 | S | G1–G4; a transcoded Reel rendition passes provider-profile validation |

---

## Phase 4 — Scheduling and publishing

| ID | Task | Deps | Effort | Acceptance |
|---|---|---|---|---|
| P4-01 | **`VariantStatus` / `PostStatus` split + pure reducer** | P3-08 | M | Reducer unit-tested across the **full cross-product** of variant states; `PENDING_APPROVAL`/`APPROVED` present but unused until Phase 5 |
| P4-02 | Scanner: 30s tick, `FOR UPDATE SKIP LOCKED`, re-read inside the claim transaction | P1-06 | L | Two workers never double-claim; an edit within the window aborts the claim |
| P4-03 | **Clock-skew guard** | P4-02 | S | A backwards jump refuses to claim and logs loudly |
| P4-04 | Queue slots, recurrence expansion (zone-aware, rolling 60-day horizon) | P4-02 | L | 09:00 Europe/Berlin stays 09:00 local across a DST boundary |
| P4-05 | Calendar: month/week/day/list, drag-to-reschedule, filters | P4-04, P1-17 | L | Optimistic where safe, persisted transactionally |
| P4-06 | Publishing pipeline with **per-operation budget acquisition** | P2-05, P3-03 | L | `mediaUpload` and `publish` acquired separately; **no `IN_FLIGHT` row for a locally denied job** |
| P4-07 | **Write-ahead `PublishAttempt`** in its own committed transaction | P4-06 | M | Committed before the provider call, never inside an open transaction |
| P4-08 | **Mutation-tolerant fingerprint** + reconciliation | P4-07 | L | Matches after link shortening, NFKC normalisation, whitespace trimming and truncation; never equality on full text |
| P4-09 | `NEEDS_REVIEW` for providers without `retrievePosts` | P4-08 | M | No blind retry where read-back is impossible |
| P4-10 | **Per-account concurrency mutex** with lease TTL > max provider timeout + fencing token | P4-06 | M | An expired lease holder cannot write; verified by test |
| P4-11 | Retry policy driven by the error taxonomy | P4-06 | M | `TokenExpired` sets `NEEDS_REAUTH` and stops retrying |
| P4-12 | **`MISSED` state**, catch-up window, oldest-first budget-paced drain, `system.backlog` | P4-02 | L | 400 overdue posts drain paced, do not burst; beyond the window they become `MISSED` and wait for a human |
| P4-13 | CSV bulk import with row-level errors and re-import | P3-10 | L | Invalid rows reported individually; valid rows unaffected |
| P4-14 | **Fault-injection harness for duplicate publishing** | P4-08, P2-08 | L | Worker as a child process; `accept_then_hang`; killed after the `IN_FLIGHT` commit and before the response; on restart the reconciler marks `PUBLISHED` with the discovered remote ID rather than republishing. Repeated with `retrievePosts: false` asserting `NEEDS_REVIEW`, and with the clock jumped backwards between claim and publish |
| P4-15 | **Mastodon adapter** — real | P2-01 | L | Dynamic per-instance client registration; character limit read from `/api/v1/instance`, not hard-coded |
| **P4-G** | **Gate — full proving slice + anchor** | all P4 | M | Two variants, real media, scheduled; simulator succeeds one and fails one → `PARTIALLY_PUBLISHED` with legible per-variant errors → retry the failed one → `PUBLISHED` → metrics land. **Then the same flow against real Mastodon, producing a divergence report.** An empty divergence report fails the gate |

---

## Phase 5 — Collaboration *(coarse; re-plan after P4-G)*

| ID | Task | Effort |
|---|---|---|
| P5-01 | Approval workflows: sequential and parallel, required counts, rejection reasons | L |
| P5-02 | Activate `PENDING_APPROVAL` / `APPROVED` in the post lifecycle | M |
| P5-03 | Threaded comments with mentions and resolve; `PostVersion` snapshots | L |
| P5-04 | Assignments and ownership | M |
| P5-05 | Notification centre + delivery | L |
| P5-06 | Audit log write-through on every consequential action | M |
| **P5-G** | Gate: E2E draft → review → approve → schedule → publish | S |

---

## Phase 6 — Unified inbox *(coarse)*

| ID | Task | Effort |
|---|---|---|
| P6-01 | **Inbound receiver**: raw-body HMAC, `hub.challenge`, 64 KB cap, per-source rate limit | L |
| P6-02 | `InboundEvent` + **fan-out to `InboundEventDelivery`** per workspace | L |
| P6-03 | `UnroutedInboundEvent` with 30-day retention; forged-routing isolation test | M |
| P6-04 | Deduplication and per-conversation ordering by provider timestamp | M |
| P6-05 | **`SyncCursor` reconciliation** + polling fallback + `INBOUND_MODE` | L |
| P6-06 | Conversations, messages, assignment, filters, saved responses, capability degradation | L |
| P6-07 | **Telegram adapter** — real | L |
| **P6-G** | Gate: inbound comment → routed → replied, plus a **Telegram divergence report** | M |

---

## Phase 7 — Analytics *(coarse)*

| ID | Task | Effort |
|---|---|---|
| P7-01 | Decaying ingestion schedule (1h/6h/24h/3d/7d/30d), budget-gated | L |
| P7-02 | Normalization to typed nullable columns + `raw` retention | L |
| P7-03 | `AnalyticsSnapshot` aggregation; dashboards read snapshots only | L |
| P7-04 | Post, account and audience analytics UI with comparison periods | L |
| P7-05 | "—" versus zero rendering for unreported metrics | S |
| P7-06 | **Reddit adapter** — real (verify free-tier terms first; fallback Bluesky) | L |
| **P7-G** | Gate: ingestion → snapshot → dashboard, plus a **Reddit divergence report** | M |

---

## Phases 8–12 *(coarse; expect re-planning)*

| Phase | Scope |
|---|---|
| **8 — Organization** | Campaigns with rollup analytics, labels, templates with variables, UTM builder and presets |
| **9 — Reporting, Link-in-Bio, lifecycle** | Report builder, charts, PDF/CSV export, saved reports, `/l/:slug` pages, **purge job, retention config, workspace and subject export jobs** |
| **10 — Platform surface** | `/api/v1` complete, OpenAPI published, API keys, outbound webhooks (HMAC, retries, delivery logs, replay), integration adapters, RSS with SSRF-guarded egress |
| **11 — Remaining connectors** | Bluesky, Discord, Slack → LinkedIn profiles, X, Tumblr → Meta, TikTok, YouTube, Pinterest, Google Business → remainder as skeletons |
| **12 — Production readiness** | Admin console (queue depth, **budget headroom**, **unrouted events**, backoff state), observability, feature flags, entitlements, hardening, cursor pagination everywhere, caching |

---

## Review-pass items, mapped

Items raised in architecture review, and where each landed:

| Ref | Item | Task |
|---|---|---|
| BF-01 | Registration modes + bootstrap | P1-12 |
| BF-02 | Transaction guard + outbox + pooling tests | P1-05, P1-06, P1-08 |
| BF-03 | Single origin, session cookie, `serverFetch`, dual-auth rejection | P1-11, P1-16, P1-18, P1-19 |
| BF-04 | `packages/ratelimit` + provider limit declarations | P2-05 |
| BF-05 | Runtime capability guards + exhaustiveness + bidirectional test | P2-02, P2-03 |
| BF-06 | Disconnect / reconnect cascade | P2-12 |
| BF-07 | Budget before write-ahead | P4-06, P4-07 |
| BF-08 | `MISSED`, catch-up, backlog signal, clock-skew guard | P4-03, P4-12 |
| BF-09 | Mastodon anchor + divergence report | P4-15, P4-G |
| BF-10 | Inbound receiver | P6-01, P6-02, P6-03 |
| BF-11 | `SyncCursor` + polling fallback + `INBOUND_MODE` | P6-05 |
| BF-12 | Telegram anchor + divergence report | P6-07, P6-G |
| BF-13 | Budget in analytics ingestion | P7-01 |
| BF-14 | Reddit anchor + divergence report | P7-06, P7-G |
| BF-15 | Deletion cascades, purge, retention | Phase 9 |
| BF-16 | Export jobs | Phase 9 |
| BF-17 | Admin budget and unrouted panels | Phase 12 |
| BF-18 | Media relay + `MEDIA_PUBLIC_MODE` | P3-05 |
| v2.1-1 | Per-workspace account uniqueness + fan-out | P2-12, P6-02 |
| v2.1-2 | Two status enums + reducer | P4-01 |
| v2.1-3 | Soft-delete in Phase 1 | P1-03 |
| v2.1-4 | Per-operation budget + fencing token | P4-06, P4-10 |
| v2.1-5 | Fault-injection test for duplicate publishing | P4-14 |
| v2.1-6 | `media.ts` / `text.ts` by surface + transcoding subsystem | P2-01, P3-03 |
| v2.1-7 | Cookie/TLS decision | P1-11 |
| v2.1-8 | Evidence citation rule as a CI gate | P0-08, G3 |

---

## Per-phase reporting

At the end of every phase, report: files created and modified, database changes, API changes, features completed, tests added, known limitations, and the recommended next phase.
