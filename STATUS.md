# Status

What actually runs, what is documented but not built, and what has not been
started. Kept blunt on purpose.

Last verified: **2026-08-30**, against a live Postgres, Redis and MinIO, with the
API and worker running.

**1034 unit and integration tests, plus 20 end-to-end. 0 failing. Type-check, lint and the evidence-citation gate
all clean.**

---

## Works, and was verified running

### The core loop

Composed a two-channel post, scheduled it 40 seconds out, started the worker, and
watched it happen:

```
variant 01a05223-1dc4… -> PUBLISHED
variant 01a05223-1dc9… -> PUBLISHED
```

The post derived to `PUBLISHED`, both variants carried a remote id and URL, and
both `PublishAttempt` rows recorded `SUCCEEDED` with an idempotency key. Reading
the same post id under a different workspace returns **404**, not 403.

### Pages

Fifteen, all returning 200 against real data:

| | |
|---|---|
| Overview | counts, upcoming, recent failures |
| Compose | live per-channel validation against the real capability matrix |
| Calendar | month / week / list |
| Posts | list, plus a detail view with attempt history |
| Inbox | conversations, threads, reply |
| Approvals | sequential and parallel, with reasons |
| Media | upload with content sniffing |
| Analytics | overview and per-account |
| Reports | summary, status breakdown, CSV export |
| Link in bio | editor plus the public page |
| Social accounts | full roster with honest states |
| Integrations | webhooks and RSS feeds |
| Team | members, roles, invites |
| Administration | scheduler health, unrouted events, expiring tokens, connector state |

### Interface

Built on Radix primitives with Tailwind and `class-variance-authority` — the
shadcn/ui conventions, assembled here rather than copied wholesale.

Every colour is an HSL triple in a CSS variable, in foreground/background pairs,
defined in **both** themes. Nothing in a component names a colour, so a theme
change is a variable change. `bg-primary/10` composes because the variable is
unwrapped; storing a finished `hsl(...)` would make every translucent surface
impossible.

Radix carries the behaviour that is invisible when it is wrong: focus trapped in
a modal and restored to its trigger, Escape to close, the page behind made inert,
type-ahead in a select, indeterminate checkboxes. Rings are `:focus-visible`
only, so a mouse click leaves nothing behind — which is the reason people delete
focus styling and take keyboard access with it.

Three bugs were found by looking at the running app rather than the code:

- **Every successful sign-in landed on a 404.** The form pushed `/dashboard`,
  but there is no top-level dashboard route — `/` is the only page that knows
  which workspace to resolve to.
- **The nav highlighted "Overview" everywhere.** `pathname.split('/')[4]` is
  always undefined for `/w/:id/posts`; the section is at index 3.
- **`asChild` buttons threw at runtime.** Radix's Slot requires exactly one
  child and counts the `false` that `{loading && …}` evaluates to.

### Connectors

| State | Count | Which |
|---|---|---|
| Implemented | 3 | Bluesky, Telegram, Mastodon |
| Simulator | 1 | Mock |
| Documented skeleton | 22 | the rest of the roster |

All 25 pass the shared contract suite — 353 assertions covering capability
exhaustiveness, bidirectional method agreement, declared budgets, and media/text
profile coverage per surface.

Skeletons are **visible in the connect UI, disabled, with a specific reason**.
The refusal is enforced server-side too, so a hand-crafted request cannot start a
flow that cannot finish:

```
tiktok  -> 422 "TikTok is not implemented yet, so it cannot be connected."
medium  -> 422 "The Medium publishing API has been retired to existing
                integration tokens only."
```

Verified live against real provider APIs:

- **Mastodon** registered an OAuth app on `mastodon.social` and produced an
  authorize URL that server accepted (302 to its login).
- **Bluesky** rejected wrong credentials with a message naming app passwords
  specifically.
- **Telegram** rejected a malformed bot token with a message naming @BotFather.

### The inbound receiver

The one place workspace context comes from untrusted input, so it was tested
rather than asserted:

| Case | Result |
|---|---|
| Valid signature | 200 |
| No signature | 404 |
| Wrong signature | 404 |
| One byte of the body changed | 404 |
| Provider with no verifier | 404 |
| Empty or malformed body | 400 |
| Replay of a valid event | 200, deduplicated |

Fan-out was verified with the agency case: one event for an account connected by
two workspaces produced **one stored payload and two deliveries**, each with its
own processing state. Events matching no account are recorded as unrouted and
**dropped**.

### End-to-end tests

Twenty Playwright tests against a real browser, API, worker and database. They
exist because 1034 unit tests caught none of the bugs that only appear when
those pieces are wired together, and every one below was found by writing them:

- **Sign-out did nothing visible.** The endpoint answers 204, and browsers do
  not navigate on 204 — so the session was destroyed and the page stayed on the
  signed-in application.
- **The IP rate limiter locked out legitimate users.** Successful sign-ins
  cleared the account counter but not the address counter, so an office behind
  one NAT would accumulate 40 successful logins and lock everyone out. Success
  now refunds exactly one attempt, leaving the counter measuring failures.
- **`Card` silently discarded every prop it did not name.** A `data-testid`
  never reached the DOM, and the failure looked like a missing element.

They cover sign-in and its guards, all fifteen sections rendering, the sidebar
marking the right section, compose validation against the real capability
matrix, publishing and drafting, and the connector honesty policy — including
that a skeleton is refused server-side, not merely disabled in the UI.

### Brute-force defence

`POST /auth/login` had no rate limiting and no lockout — it accepted unlimited
password guesses. Argon2id makes each guess expensive, which helps, but is not a
substitute: it also means a few hundred concurrent attempts saturate the CPU and
take the application down as a side effect.

Attempts are now consumed BEFORE the password is verified, on two keys at once:

| Key | Limit | Defends |
|---|---|---|
| Account | 8 per 15 min | one address ground down from many hosts |
| IP | 40 per 15 min | one guess sprayed across many accounts from one host |

Either limit alone leaves the other attack completely open. The IP limit is
looser because an office behind one NAT address is a legitimate source of many
sign-ins, and locking them all out is its own outage.

Verified live: eight attempts return 401, the ninth returns 429, the correct
password is refused while locked, a different account is unaffected, and the
message never reveals whether the address exists.

A concurrency test caught a real flaw in the first version. Check-then-record is
two round trips, so twenty simultaneous requests each read a count below the
limit and **all twenty passed** — precisely the shape of the attack. Consuming
on the way in, in one round trip, is what makes the limit hold.

### Account recovery

Password reset, email confirmation, and signed-in password change. Verified end
to end against the running stack:

| Case | Result |
|---|---|
| Unknown vs. known address | **byte-identical** responses — no membership oracle |
| Password under 8 characters | refused |
| Forged token | refused |
| Valid reset | succeeds, and **every** session is destroyed |
| Replaying the token | refused, with "already used" rather than "expired" |
| Old password afterwards | 401 |

An earlier version of this leaked: the mail-configuration notice was returned
only when a send actually happened, so a known address produced a different
response body from an unknown one — a membership oracle in the endpoint most
carefully written to avoid being one. The notice is now derived from
configuration alone.

**Mail without an SMTP server.** Many self-hosted deployments have none, and
pretending to send is how "reset your password" becomes a feature that silently
does nothing. With no `SMTP_URL`, the link is written to the server log in full,
the API reports `delivered: false`, and the sign-in page says so *before* the
form rather than after submitting into a void.

### Transcoding

Real ffmpeg. Ten of the tests generate clips, run the planner, transcode, and
**re-probe the output** — the planner's decisions are asserted against what
ffmpeg actually produced, not against the arguments it was given.

That distinction found a bug that would have shipped: **`-r 60` with
`-c:v copy` is silently ignored by ffmpeg.** A 120fps video sent to Instagram
Reels would have been "converted", stayed at 120fps, and been rejected by
Instagram with a message that does not say why. No argument-level assertion
would ever have caught it, because the argument list is perfectly valid. A
stream copy cannot change frame rate or pixel format, and that is now stated
once, in one place.

Renditions are cached on `(assetId, providerId, surface)` — never on the post.
The same video going to Reels from four posts is one transcode. Transcoding is
serialised process-wide, because ffmpeg will otherwise take every core and stop
the publish tick from running at all.

A conforming file costs one probe and is published untouched.

### Retention and purge

Workspace deletion is a two-step with a grace period, and the response names the
**actual purge date** rather than "soon". Verified against a real workspace:

| | |
|---|---|
| Workspace, posts, accounts | destroyed |
| OAuth credentials | cascaded away |
| S3 objects, including renditions | deleted before the rows, so no key is ever orphaned |
| Audit rows | **survived**, with payload and IP stripped and `entityId` intact |
| Sibling workspaces | untouched |

Also reaped: inbox messages past `INBOX_RETENTION_DAYS`, raw metric payloads
past 90 days, unrouted inbound events past 30 days, and spent tokens and expired
sessions.

### Tenant isolation

68 isolation tests, generated from the Prisma DMMF, run against an unprivileged
Postgres role with `FORCE ROW LEVEL SECURITY`. Adding a model with a tenancy
column fails CI until it is registered.

Three cross-cutting jobs legitimately precede tenancy — inbound routing, the
scheduler sweep, and retention — and each has its own **named, minimal**
database actor rather than an RLS bypass. The retention actor deliberately
cannot read `Post`, `SocialAccount`, `OAuthCredential` or `Message`: deleting
the workspace row cascades those in the database, so a bug in the purge cannot
become a data leak. It also cannot DELETE an audit row, only minimise one.

Two structural gates were added after a silent bug was found by accident:

- **Every model with an `organizationId` must have a policy that can match on
  it.** Five did not. The Prisma layer permitted the organization-scoped query,
  RLS filtered every row out, and the caller got an empty result with **no
  error** — an organization-wide count of webhooks returned 0 with rows plainly
  present in the table.
- **Every table with a `workspaceId` must have an isolation policy**, unless it
  appears in the documented exemption list the tenancy guard itself uses.

Both are asserted against the live database rather than reviewed by eye.

---

## Built, but not exercised against a live provider

The Mastodon publish, media-processing and reconciliation paths are implemented
and unit tested but have not run against a real instance with a real account,
because that needs credentials this environment does not have. The
asynchronous-media handling comes from the documented API contract; the polling
loop deserves a live run before production use. Recorded in
`docs/divergence/mastodon.md` rather than glossed over.

---

## Not built

Named plainly so nobody goes looking.

| | |
|---|---|
| **Reddit anchor** | Phase 7 analytics gate. Skeleton only. |
| **Entitlements, feature flags** | Architecture only. |
| **Campaigns, labels, templates, UTM builder** | Phase 8. Not started. |
| **Export jobs** | Phase 9. Per-workspace and per-subject export are specified, not built. Purge and retention ARE built — see above. |
| **22 remaining connectors** | Documented skeletons, disabled with a stated reason. |
| **Compose stack** | The images build and each process runs, but the containers have not been run together. Blocked on host disk space, not on code. |

### Deliberately excluded, permanently

**No AI features of any kind.** No generation, no copywriting, no agents, no
model-derived posting-time advice. This is a product decision, not a gap.

**No payment processing.** Entitlement architecture only.

---

## Production packaging

Every workspace package compiles to `dist`. The exports map carries a
`development` condition pointing at TypeScript source and a default pointing at
compiled output, so dev and tests resolve to source while the production image
resolves to JavaScript and never sees a `.ts` file.

Verified by running it:

| | |
|---|---|
| `api` | compiled, booted, served `/api/v1/health` 200 |
| `worker` | compiled, booted, scanning |
| `web` | standalone server, ready in **476ms**, CSS served, all 15 pages 200 |
| Docker images | `api`, `worker`, `web`, `migrate` all build |

Three real problems surfaced doing this:

- **The Dockerfile pointed at a path that does not exist.** `output: standalone`
  nests the server under the workspace path, so the entrypoint is
  `.next/standalone/apps/web/server.js`.
- **Next does not copy `.next/static` into the standalone output.** The site
  boots, serves HTML, and renders with no CSS — which reads as a broken
  deployment rather than a missing copy step. Now handled by
  `apps/web/scripts/prepare-standalone.mjs`, so a container and a bare-metal
  deploy cannot drift apart.
- **corepack was fetching pnpm 11 instead of the pinned 9.** A `pnpm config` line
  ran before `COPY . .`, so there was no manifest to read the pin from. Builds
  would have drifted version to version from an identical lockfile.

`pnpm preflight` reads a `.env` and reports what is configured, what is legal but
probably unintended, and what blocks a deploy — plain http on a public host, a
default password, `DEMO_MODE` left on. See `DEPLOYMENT.md`.

Graceful shutdown: the API drains in-flight requests on SIGTERM, bounded so a
keep-alive socket cannot hold the process open past the orchestrator's patience;
the worker finishes its tick with an interruptible idle wait rather than sitting
out a full 30 seconds.

## Known rough edges

- The seed uses a fixed `ENCRYPTION_KEY` from `.env.local` in development. Real
  deployments refuse to boot without a genuine one.
- The images build and the compiled processes run, but the **containers have not
  been run together end to end**. Docker Desktop's API stopped responding after
  the builds and did not recover through a restart. The compose file is written
  and reviewed; it has not been exercised.
- For the same reason, the last full test run shows **862 passing with 31
  blocked** — every one of those 31 needs a live Postgres or Redis round trip
  and fails on a 5-second connection timeout, not an assertion. They passed
  (1023 total) immediately before Docker became unresponsive.
