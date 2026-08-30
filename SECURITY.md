# SECURITY

Threat model, controls, and the tests that must exist. This document records not only *what* the controls are but *which invariants they depend on*, so nobody removes a load-bearing constraint by accident.

---

## 1. What we are protecting

| Asset | Why it matters |
|---|---|
| **OAuth credentials** | Full publish authority over customers' social presence. The highest-value asset in the system by a wide margin. |
| **Draft and scheduled content** | Unreleased marketing, embargoed announcements, client work. |
| **Third-party personal data** | DM contents, commenter names and handles, audience demographics — belonging to people who are not our users and never agreed to anything with us. |
| **Cross-tenant boundaries** | An agency's clients must not see each other. Ever. |
| **The publishing capability itself** | Compromise means posting as the customer to their real audience — unrecoverable reputational damage. |

---

## 2. Threat model

| # | Threat | Control |
|---|---|---|
| T1 | Cross-tenant data access | Query-layer guard + RLS + DMMF-generated isolation suite (§4) |
| T2 | Credential theft from the database | AES-256-GCM envelope encryption, DEK per record (§6) |
| T3 | Credential leakage to the browser | ESLint boundary: `apps/web` cannot import `providers` or `database` |
| T4 | Credential leakage into logs | Redacting serializers; ciphertext and plaintext never logged |
| T5 | Session hijacking | `HttpOnly`, `SameSite=Lax`, `__Host-` where TLS permits, server-side revocation (§3) |
| T6 | CSRF | Single-origin invariant + `SameSite=Lax` + `Origin` check + custom header (§3) |
| T7 | Confused deputy between auth modes | Dual-auth requests rejected outright (§3) |
| T8 | Forged inbound webhooks | Mandatory signature verification over raw bytes; unrouted events dropped (§5) |
| T9 | SSRF via user-supplied URLs | No fetch-by-URL anywhere; allowlisted egress for RSS (§7) |
| T10 | Malicious uploads | MIME sniffing, re-encoding, never executing, never serving from the app origin as HTML (§7) |
| T11 | Privilege escalation via role manipulation | Authorization evaluated server-side only; frontend never decides |
| T12 | Connection-pool starvation as a denial of service | Transaction boundary guard + statement timeouts (§4) |
| T13 | Duplicate publishing | Write-ahead attempts, reconciliation, clock-skew guard (§8) |
| T14 | Data retention beyond lawful basis | Configurable retention, purge job, export (§9) |

---

## 3. Authentication and session security

### Passwords
argon2id, memory-hard parameters tuned at boot, per-user salt. Never MD5, SHA, or bcrypt. Password reset tokens are single-use, hashed at rest, 30-minute TTL. Rate limit: 5 attempts per 15 minutes per account **and** per IP — both, because either alone is trivially bypassed.

### Sessions
Opaque random 256-bit ID, **not a JWT**. Authoritative in Postgres so sessions are listable and revocable; cached in Redis with short TTL. Logout deletes the row and busts the cache, so revocation is immediate everywhere rather than eventual.

Rejected: JWT in `localStorage` — XSS-readable, and unrevocable without a denylist that reintroduces the very server-side session it was meant to avoid.

### Cookie and TLS policy — decided, not silent

`__Host-` requires `Secure`, which requires TLS. **`localhost` is exempt from `Secure`, so a naive implementation passes in development and fails on the first internal LAN deployment** — a homelab on plain HTTP would be unable to log anyone in, with no obvious cause.

| `PUBLIC_URL` | Cookie | Boot behaviour |
|---|---|---|
| `https://…` | `__Host-smm_session`, `Secure`, `SameSite=Lax`, `Path=/`, no `Domain` | Normal |
| `http://localhost…` | `smm_session`, no `Secure` | Normal, development notice |
| `http://` other host | `smm_session`, no `Secure` | **Refuses to boot unless `ALLOW_INSECURE_COOKIES=true`**, then warns on every boot |

Rejected making TLS a hard requirement: LAN-only self-hosting behind a firewall is a legitimate deployment and refusing it outright is hostile. Rejected silently downgrading: a security property that disappears without saying so is worse than either explicit option.

### CSRF depends on the single-origin invariant

`SameSite=Lax` blocks cross-site POSTs. Defence in depth adds an `Origin` match check and a required `X-SMM-Client: web` header that a cross-site form post cannot set without triggering preflight.

> **This posture is only sound because `apps/web` proxies `/api/*` and the browser sees one origin.** Moving the API to `api.example.com` would require `SameSite=None`, CORS with credentials, and a real CSRF token scheme. Do not break the invariant without re-deriving this section.

### Two auth modes, never blended

A request presenting **both** a session cookie and an API key is **rejected** with `401 auth_mode_conflict` — never resolved by precedence. API-key requests never receive `Set-Cookie`.

This removes an entire class of confused-deputy attack for the cost of one error path.

### API keys
`smm_live_<32 bytes base62>`. Hashed at rest (SHA-256; the entropy is already 256 bits, so no KDF stretch is needed), with the prefix stored separately for display. Shown once at creation. Scoped, per-key rate limited, revocable, with `lastUsedAt` tracked. Creation, rotation and revocation are all audited.

---

## 4. Tenant isolation

### Two layers, deliberately

**Primary — Prisma client extension.** Every query against a tenant-scoped model must carry a workspace or organization scope, or it throws. The same extension applies `deletedAt IS NULL`.

**Secondary — Postgres RLS** on `Post`, `PostVariant`, `SocialAccount`, `OAuthCredential`, `MediaAsset`, `Conversation`, `Message`, driven by `SET LOCAL app.current_workspace`.

- *Rejected — RLS alone:* pooled connections make missed context easy, and violations surface as confusing empty results rather than loud errors.
- *Rejected — query guard alone:* a single `$queryRaw` bypasses it silently. RLS is the backstop for exactly that.

### The superuser trap — found in testing, not in review

RLS was enabled, `FORCE ROW LEVEL SECURITY` was set on every tenant table, and all four policies were present in `pg_policies`. Raw SQL still returned every tenant's rows.

**`FORCE ROW LEVEL SECURITY` removes the table OWNER's exemption. It does nothing about a superuser.** A superuser, or any role with `BYPASSRLS`, ignores row security entirely, and no table-level setting can change that. The official `postgres` image creates `POSTGRES_USER` as a superuser, so the obvious `DATABASE_URL` bypassed every policy while looking perfectly configured from the outside.

"Looks enabled but isn't" is the worst state a security control can occupy, and no amount of reading configuration would have revealed it. Two defences now exist:

| Defence | What it does |
|---|---|
| **Two database roles** | Migrations run as the owner via `MIGRATE_DATABASE_URL`. The application connects as `smm_app_user`, an unprivileged login granted the `smm_app` privilege role — `NOSUPERUSER NOBYPASSRLS`. |
| **Boot-time assertion** | `assertRlsApplies()` queries `pg_roles` for the connected role and **refuses to start** if it is a superuser or has `BYPASSRLS`. Configuration can be inspected and still be wrong; behaviour cannot. |

The regression test asserts the *difference* between the two roles rather than asserting the configuration we hope produces it: the same raw query returns 0 rows as the application role and is unrestricted as the owner.

### The `SET LOCAL` trap

`SET LOCAL` is transaction-scoped, which creates a fork where **both obvious paths fail**:

1. **Wrap the request in a transaction** so the setting persists → a provider HTTP call inside pins a Postgres connection for its whole duration. A 30-second provider timeout holds a connection 30 seconds; under load the pool exhausts and the deployment stalls, *presenting as a database problem that is actually an HTTP problem*. This is threat **T12**.
2. **Use `SET` instead of `SET LOCAL`** so it persists on the connection → it leaks to the next request borrowing that pooled connection. **A silent cross-tenant data leak** — threat **T1**, the worst outcome in this document.

**Resolution: transactions are database-only, short, and contain no I/O.** Tenant context is set per unit of DB work, not per request. Enforced mechanically by an `AsyncLocalStorage` guard that throws `TransactionBoundaryViolation` if a provider HTTP call, S3 call, or non-transactional enqueue happens inside an open transaction.

Consequences to preserve:
- **Never `SET`, always `SET LOCAL`** — a `$queryRaw` guard rejects session-level `SET` on tenant variables.
- **pgBouncer transaction pooling is safe** *because of* this rule. Do not switch to session mode "to fix" anything.
- **No `BYPASSRLS` on application roles.** Migrations and the admin console use a separate role.
- **Backstops:** `statement_timeout = 15s`, `idle_in_transaction_session_timeout = 10s`.

### Isolation tests that must exist

The suite **enumerates tenant-scoped models from the Prisma DMMF at test time**, so adding a model without isolation fails CI automatically. Nobody has to remember to write the test.

| Test | Asserts |
|---|---|
| Cross-tenant read | Every tenant-scoped model returns empty for a foreign workspace |
| Cross-tenant write | Every tenant-scoped model rejects a foreign-workspace mutation |
| Soft-delete invisibility | Deleted rows are absent from normal reads |
| **Pooled-connection leak** | Two requests for different workspaces forced onto one connection do not see each other's data |
| **Transaction boundary** | A provider call inside a transaction throws `TransactionBoundaryViolation` |
| **`$queryRaw` backstop** | RLS blocks what the query guard did not see |
| **Forged inbound routing** | An event carrying another workspace's `providerAccountId` is not routable without a valid signature |
| Unscoped query | Throws rather than returning all tenants' rows |

---

## 5. The inbound webhook trust boundary

> **This is the one place in the system where workspace context is derived from untrusted input.** Everywhere else, tenancy comes from an authenticated session or API key. Here it comes from an unauthenticated public HTTP request sent by a third party.

`POST /api/v1/hooks/:provider` is exempt from session auth and the tenancy guard, because there is no user and no workspace yet. It is **never** exempt from signature verification.

### Raw body preservation

HMAC is computed over the **exact bytes received**. NestJS runs with `rawBody: true` and the verifier reads the raw buffer, never the parsed object.

Re-serialising parsed JSON and hashing that is the single most common way this check silently passes on well-formed payloads and fails on everything else — key ordering, unicode escapes, and number formatting all differ after a parse/stringify round trip. A contract test asserts verification **fails** when a byte changes in a way JSON parsing would normalise away.

### Routing

```
providerAccountId → all SocialAccount rows with that (provider, providerAccountId)
                  → one InboundEventDelivery per workspace, each under its own tenancy context
```

Because `SocialAccount` uniqueness is `(workspaceId, provider, providerAccountId)`, one event can legitimately reach several workspaces — the agency case.

**Zero matches means the event is dropped**, after being written to `UnroutedInboundEvent` with 30-day retention. Never guessed at, never broadcast, never attached to the nearest plausible workspace. Unrouted volume is an admin metric; a sustained rise means a stale subscription needs cleaning up.

### Other controls
- 64 KB body cap; per-source rate limit; IP allowlist where the provider publishes ranges.
- Acknowledge within 200 ms (hard budget 5 s) — verify, persist, enqueue, return 200. No provider call or business logic in the request path.
- Deduplicated on `(provider, providerEventId)`, falling back to `(provider, contentHash)`.
- `INBOUND_MODE=poll` for deployments with no public ingress — polling and webhooks converge on one write path, so nothing is lost.

---

## 6. Credential encryption and key management

**AES-256-GCM envelope encryption behind a pluggable `KeyProvider`.**

A per-record DEK encrypts the token; the DEK is wrapped by a KEK. Stored ciphertext is `{ v, keyId, iv, tag, ciphertext }` — `v` versions the scheme itself, so the algorithm can change without a flag day.

| Deployment | KEK custody |
|---|---|
| Self-hosted | `ENCRYPTION_KEY`, 32 random bytes base64. **The app refuses to boot** if absent, shorter than 32 bytes, or equal to the documented example value. |
| SaaS | The same `KeyProvider` interface backed by AWS KMS or Vault. No business-logic change. |

**Rotation.** Each record carries `keyId`. A rotation job re-wraps DEKs with the new KEK while `ENCRYPTION_KEY_PREVIOUS` stays readable during the window. No downtime and no bulk plaintext re-encryption, because only the small DEKs are re-wrapped.

**Application.** Encryption is applied in a Prisma client extension, so no call site can forget it. Error serializers redact token fields. Ciphertext and plaintext are never logged, and provider error bodies are never echoed raw into logs because they sometimes contain tokens.

**Disconnect hard-deletes `OAuthCredential`.** Credentials are never soft-deleted — a soft-deleted secret is still a secret sitting in the database.

---

## 7. Input, upload, and egress

### Uploads
- MIME determined by **content sniffing**, never by the client-supplied header or file extension.
- Size, dimension and duration validated against the target provider's surface profile at **compose time**, not publish time. Telling someone at 09:00 that their scheduled post failed on an aspect ratio is a bad product.
- Images re-encoded during rendition generation, which strips embedded payloads as a side effect. EXIF stripped by default (it carries GPS).
- Uploaded files are **never executed** and never served from the app origin with an HTML content type.
- Storage keys are server-generated UUIDs; client-supplied filenames are metadata only and never touch a path.

### SSRF
**There is no fetch-by-URL primitive in the product.** The media relay takes an opaque HMAC token that resolves to a rendition ID we already own — it never accepts a URL, so there is no attacker-controlled destination anywhere in the path.

RSS ingestion is the one place a user supplies a URL. It runs through an egress allowlist policy: HTTP(S) only, DNS resolved and checked against private and link-local ranges **before** connecting and again after redirects, redirect depth capped, response size and timeout bounded.

### The media relay
`GET /api/v1/media/relay/:token` is unauthenticated, because the fetchers that need it (Instagram) are anonymous. Security rests on:
- token unguessability (HMAC over rendition ID with a 30-minute TTL),
- single-asset scope — a token grants one rendition and nothing else,
- per-IP rate limiting,
- no directory listing and no enumeration path.

Where nothing is publicly reachable, `MEDIA_PUBLIC_MODE=disabled` marks Instagram unavailable **at boot with the reason**, rather than failing at publish time.

---

## 8. Publishing integrity

Duplicate publishing is a security-adjacent concern: it damages the customer's reputation and cannot be undone.

- **Write-ahead `PublishAttempt`** committed before the provider call, in its own transaction.
- **Reconciliation, not blind retry**, using a fingerprint that survives provider mutation (link shortening, unicode normalisation, whitespace trimming, truncation). Exact-text matching would fail to find a post that *did* publish and then republish it.
- **`NEEDS_REVIEW`** where a provider offers no read-back — at-most-once plus human review, deliberately chosen over at-least-once plus duplicates.
- **Clock-skew guard.** The scanner refuses to claim if system time moved backwards. NTP corrections are common on self-hosted boxes, and a backwards jump would re-claim already-published rows — a duplicate-publish path that sits entirely outside the idempotency design, which reasons about retries rather than about time travel.
- **Per-account concurrency mutex** with a lease TTL exceeding the maximum provider timeout, plus a fencing token so a resumed holder whose lease expired cannot write.

---

## 9. Data lifecycle

| Event | Behaviour |
|---|---|
| **Account disconnect** | Revoke at the provider where supported; **hard-delete** `OAuthCredential`; keep `SocialAccount` as `DISCONNECTED` for history; cancel scheduled variants **and notify** — silently dropping a content calendar is worse than the disconnect |
| **Account reconnect** | Match on `(workspaceId, provider, providerAccountId)` and restore; never duplicate |
| **Workspace delete** | Soft-delete, configurable grace (default 30 days), then purge S3 objects and renditions, conversations, messages, metrics, drafts, credentials, link pages. Audit rows retained **minimised** — actor, action, timestamp, no payload |
| **User delete** | **Anonymise, do not cascade.** Content belongs to the workspace; authorship becomes a tombstone. Sessions and API keys hard-deleted immediately. A sole organization owner cannot be deleted until ownership transfers |
| **Inbox retention** | `INBOX_RETENTION_DAYS`, default unlimited, per-workspace configurable — this is third-party personal data held on a customer's behalf, and a customer with a retention policy needs somewhere to express it |
| **Raw metrics** | `raw` JSONB nulled after 90 days; normalized columns retained |

**Export.** Per-workspace (content, media manifest, metrics) and per-subject (everything associated with one end-user identity across conversations). Job classes exist from Phase 1 so the capability is architectural rather than a retrofit under a deadline from someone's counsel.

> A deletion record that deletes itself is not a record. That is why audit entries survive purge in minimised form.

---

## 10. Audit

Every consequential action is logged with actor, organization, workspace, action, entity type and ID, timestamp, IP where appropriate, and metadata.

**Admin actions are audited exactly like user actions.** Operator tooling does not bypass the log — an audit trail with a hole in it where the most powerful actor stands is not an audit trail.

Audited: login, logout, failed login, password change, session revocation, account connect/disconnect, post create/edit/delete/schedule/publish/cancel/approve/reject, member invite and role change, workspace create/delete, campaign and report actions, API key create/rotate/revoke, webhook configure, integration configure, feature-flag change, admin impersonation (if ever added — currently not).

---

## 11. Secrets policy

- Never in logs, never in error responses, never in audit metadata, never in a URL query string.
- `.env` is git-ignored; `.env.example` is the documented template and carries no real values.
- The app refuses to boot with a missing or example-valued `ENCRYPTION_KEY` or `SESSION_SECRET`.
- Provider credentials load only in `packages/providers`, imported exclusively by `apps/api` and `apps/worker` — enforced by an ESLint boundary rule so the constraint is structural rather than cultural.
- Dependency and container scanning run in CI.

---

## 12. Reporting a vulnerability

Security issues should be reported privately rather than filed as public issues. `SECURITY.md` at the repository root will carry the contact address before the first public release.


## Inbound routing: the `app.inbound_router` actor

Recorded here because it is the one place in the system where workspace context
derives from untrusted input, and because getting it wrong is silent.

Routing an inbound event requires finding every `SocialAccount` matching a
`providerAccountId` **across all workspaces**, before any workspace is known —
deciding which workspaces the event belongs to is the entire job. No tenant scope
can be set beforehand.

`app.inbound_router` grants exactly:

| Table | Grant | Why |
|---|---|---|
| `SocialAccount` | `SELECT` only | the routing lookup, and nothing else |
| `InboundEvent` | `ALL` | store the verified payload once |
| `InboundEventDelivery` | `ALL` | one row per matched workspace |
| `UnroutedInboundEvent` | `ALL` | record what matched nothing |

It cannot read message bodies, credentials, posts, or metrics. It is a separate
actor from `app.scheduler` rather than a widening of it, because the failure mode
is uniquely quiet: **without the grant the lookup matches zero rows, every event
is classified as unrouted and dropped, and nothing logs an error.** The inbox
simply stays empty forever. This was observed, not theorised — see
`docs/divergence/telegram.md`.

Signature verification happens **before** any of this runs. An event that fails
verification never reaches the router, and the response is `404` rather than
`401` so a probe learns nothing about whether the path exists or the signature
was merely wrong.

### Why an unconfigured secret refuses rather than accepts

Every provider verifier returns `false` when its secret is unset. The tempting
alternative — skip verification until configured, so it "works out of the box" —
turns a public endpoint into an open write into somebody's inbox. A provider we
cannot verify is refused, not trusted.

### Why raw bytes

HMAC is computed over exactly what arrived. `verifyWebhook` takes a `Buffer`, and
that signature is the enforcement: anything that has been through `JSON.parse`
has already lost the information needed to check it. Key order, unicode escapes
and number formatting all survive a round trip visually while changing the bytes.
A contract test asserts that a re-spaced body whose JSON parses identically is
**rejected**.
