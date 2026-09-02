# Status

What actually runs, what is documented but not built, and what has not been
started. Kept blunt on purpose.

Last verified: **2026-08-30**, against a live Postgres, Redis and MinIO, with the
API and worker running.

**1333 unit and integration tests, plus 34 end-to-end. 0 failing. Type-check, lint and the evidence-citation gate
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

### Administering the installation from the browser

Two things that worked perfectly and that nobody could reach.

**Connector credentials.** Adding a Meta app meant editing `.env.local` and
restarting three processes. For software that ships as a self-hosted web
application with an admin console, that is the wrong answer — the person who can
administer the installation is by definition sitting in a browser. They are now
set from Settings, and:

- **The environment still wins where it is used.** A deployment injecting
  secrets from a vault or a Kubernetes secret keeps doing exactly that; those
  arrangements are better than a database column, not worse, and this must not
  push anyone into the worse one. The UI is an option for installations with no
  such machinery. Where both exist, the UI value takes precedence — an
  administrator who types a value into a form and sees nothing change has been
  lied to.
- **Which source is in force is on screen.** `Set here` / `From environment` /
  `Not set`. Without that, an empty-looking field that is quietly satisfied by
  an environment variable invites someone to override it without knowing, and
  then to be unable to explain why clearing the field changed nothing.
- **Write-only.** No endpoint returns a stored value. What comes back is a
  hint — the whole value for an app ID, `••••9f3a` for a secret. Enough to
  answer "is the right one in here?", useless to a thief. App IDs are not masked
  deliberately: Meta puts them in the redirect URL, and hiding one costs the
  ability to spot the commonest mistake there is, which is the right value in
  the wrong field.
- **Encrypted with the same KEK as OAuth tokens**, through the same envelope
  scheme, with the same `keyId` rotation story.
- **The redirect URI is shown ready to copy**, per provider. Every provider
  console demands an exact match and rejects a mismatch with an error that does
  not say which side is wrong.

Two decisions worth stating:

- **The keys are an allowlist.** The key is a path parameter, and without a
  fixed list `PUT /connector-settings/DATABASE_URL` would look like a perfectly
  ordinary request.
- **Editing is refused on a multi-organization deployment.** These values are
  installation-wide, so one org's admin changing a Meta app would repoint every
  other org's connector at it. `ALLOW_SHARED_CONNECTOR_SETTINGS=true` permits
  it explicitly — the same shape as the insecure-cookie opt-in. A real
  deployment shape that should be possible, never a silent one.

**Two RLS actors, not one.** Every process reads these at boot; exactly one code
path writes one. Sharing an actor would give the analytics job that polls
Instagram every fifteen minutes UPDATE on the credential authorising it — where
a bug stops being a crash and becomes a way to repoint the installation's OAuth
client at somebody else's app, harvesting every future connection without
breaking anything visible. `app.connector_settings` reads;
`app.connector_settings_write` writes. Both are tested, including that the read
actor is refused a write and that a query with no actor at all returns nothing.

**Creating a workspace.** `POST /workspaces` has existed since Phase 1 with no
control anywhere in the product — the only way to make a second workspace was
curl. The switcher now has a "New workspace" item, and it appears exactly when
it will work: the API answers `canCreateWorkspace` from the same organization
role the POST checks, because creating a workspace is an organization-level act
and the workspace role can disagree with it.

Verified in a browser rather than asserted: signed in, opened the switcher,
created a workspace with the timezone the browser guessed, landed inside it;
then typed a LinkedIn secret into the settings form, watched the connector move
to *Ready to connect*, and confirmed the plaintext appears nowhere in the served
HTML while the stored column holds ciphertext. The credential then built a real
`linkedin.com/oauth/v2/authorization` URL carrying the client ID that had been
typed in a minute earlier — in a process that had been told, at boot, that
LinkedIn was unconfigured.

### Recurring schedules

"Post every weekday at 09:00" — the most-asked-for thing a scheduler does, and
the place scheduling software most often breaks quietly.

**A rule stores a wall-clock time and an IANA zone, never an instant plus an
interval.** That distinction is the whole design. Stored as "this moment, every
24 hours", a schedule works perfectly until a daylight-saving boundary, after
which every post lands an hour out — forever — and nothing reports a problem.
Storing "09:00 Europe/Berlin" and converting at expansion time keeps 09:00 at
09:00, which is what the person meant.

Verified in real data rather than asserted. A daily 09:00 Berlin rule spanning
the October transition:

| UTC instant | Berlin |
|---|---|
| `2026-10-24T07:00Z` | Sat 24 Oct, 09:00 |
| `2026-10-25T08:00Z` | Sun 25 Oct, 09:00 |
| `2026-10-26T08:00Z` | Mon 26 Oct, 09:00 |

The instant moves; the clock does not.

**The two boundary cases have no single right answer, so each picks one and says
so.** The hour that does not exist (02:30 on a spring-forward night) fires at
03:30 rather than vanishing — a skipped post gives the author no signal at all.
The hour that happens twice takes the earlier. Getting both right needed
*sampling* the offset either side of the date rather than iterating one guess:
an ambiguous time has two valid answers and a nonexistent one has none, and no
amount of refining a single guess distinguishes those. The first implementation
returned the later instant on fall-back, and the test caught it.

Thirty-three unit tests cover the arithmetic, including half-hour zones
(Kolkata), three-quarter-hour zones (Kathmandu), the engine quirk that renders
midnight as hour 24, and the far-east window boundary where an instant inside
the range has a local date outside it.

**Expansion is a worker job on a rolling sixty-day horizon**, and it produces
ORDINARY scheduled posts. Nothing publishes a rule — the scanner never learns
one exists — so recurrence adds one job and changes nothing about publishing,
retries, reconciliation or the calendar. The consequence people feel is that a
generated post can be edited: change next Tuesday's wording, drag it an hour
later, and it stays changed, because it is a real row rather than a projection.

Idempotency is enforced by a unique index on `(recurrenceId, occurrenceAt)`
rather than by checking first. This runs on every tick of every worker against
deliberately overlapping windows; a check-then-insert is a race, and a collision
here is the steady state rather than an error. Eleven integration tests cover
that, including a simulated crash between creating the posts and recording how
far expansion got.

Two decisions worth stating, because both could reasonably go the other way:

- **Monthly on the 31st skips short months** instead of clamping to the 30th.
  Clamping posts on a date nobody chose, and in February moves it by three days.
  The form warns before the choice is made.
- **Deleting a schedule keeps its posts** by default, with "delete and clear
  upcoming" as a separate button. Most people mean "stop making new ones", and
  erasing next month's calendar is not a recoverable surprise.

### The transactional outbox, finally connected

The architecture called this load-bearing and it was dead code. The `Outbox`
table existed, `emit`, `claimPending`, `markDispatched` and `markFailed` all
existed — and **nothing called any of them.** The module was not even exported
from `@smm/database`.

The visible consequence was worse than a missing feature. The integrations page
let a workspace subscribe a webhook to `post.published`, showed it enabled, and
it could never fire: nothing emitted a domain event, so no delivery row was ever
created. A configured, enabled, permanently silent subscription is exactly the
kind of thing the honesty policy exists to prevent, and it had been sitting
there since Phase 10.

**Producers.** `post.published` and `post.failed` are emitted by the publishing
pipeline, `post.missed` by the scanner — each inside the transaction that
records the outcome it describes. That placement is the mechanism, not a detail:
emit after the commit and there is a window where the post is live and the event
never happened; emit before, and a rolled-back write leaves a subscriber told
about something that did not occur. A test asserts both directions.

**The dispatcher** drains committed events into two consumers and does nothing
else — no HTTP, because a dispatcher making network calls holds a transaction
open across the internet. Webhook deliveries go to subscribed endpoints only.
Notifications go only to people who can *act*: `post.missed` and `post.failed`
reach OWNER/ADMIN/MANAGER/EDITOR, and `post.published` deliberately notifies
nobody — a notice per publish is a hundred a day on an active workspace, and the
ones that matter drown.

**At-least-once is a requirement on consumers, not a caveat.** The dispatcher
can crash after writing a delivery row and before marking the event dispatched,
and the only safe response is to run again. Both consumers carry a `dedupeKey`
derived from the event and the recipient, with a unique index, so a redelivery
collides instead of duplicating. There is a test that simulates exactly that
crash.

#### Two bugs it surfaced immediately

**The webhook sender had never run.** No delivery row had ever existed, so its
failure path was unexecuted code. On the first real delivery it threw
`PrismaClientKnownRequestError: No record was found for an update` — the
dispatcher held `SELECT` on `Webhook` but calls `update()` to track
`consecutiveFailures` and disable a dead endpoint. RLS filtered the row away and
Prisma reported it as missing. That is the **sixth** appearance of the
narrow-actor pattern in this codebase, and the first that failed loudly rather
than returning nothing.

**A test of mine assumed tenancy applied to `Outbox`.** It does not — the table
is deliberately exempt, because the dispatcher must see every workspace. A count
inside `withTenant()` therefore counts the whole deployment. Worth recording,
because the same trap waits for anything that reads this table next.

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
exist because a thousand unit tests caught none of the bugs that only appear when
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

### Connectors

Nine implemented: **Facebook Pages, Instagram, Pinterest, YouTube, TikTok,
LinkedIn profiles**, Mastodon, Bluesky, Telegram. Fifteen remain documented
skeletons, each disabled with a stated reason.

LinkedIn Company Pages stay a skeleton on purpose: they need Marketing Developer
Platform approval, a manual review with no published timeline. Personal profiles
are self-serve, which is why they came first.

Facebook and Instagram share one Meta Graph module rather than each carrying a
copy of the OAuth flow — Instagram Business accounts are reached *through* a
Facebook Page, so it is one API, and two copies of it would drift.

What the real APIs forced, none of which a mock would have taught:

| | |
|---|---|
| **Instagram publish is two calls, and the first is async** | A container is created, Instagram fetches and transcodes, and only a FINISHED container can be published. The adapter polls, bounded at five minutes. `PUBLISHED` is the important state: it means an earlier attempt succeeded and we never saw the response, so returning beats publishing a second time |
| **Instagram fetches media from us** | There is no upload. `MEDIA_PUBLIC_MODE` and the signed relay are load-bearing here, not optional |
| **Carousel children need `is_carousel_item`** | Without it a two-image carousel publishes as two separate posts — undoable only by deleting both |
| **Seeing a Page is not posting to it** | `tasks` is checked at connect and a Page without CREATE_CONTENT is refused there, not on the first scheduled post days later |
| **Page tokens inherit their lifetime** | The user token is exchanged for a long-lived one first. Skipping that works in testing and breaks for every user overnight |
| **YouTube moves the bytes itself** | Resumable upload: metadata opens a session, bytes go to the returned URL. `privacyStatus` is always sent and defaults to *private*, because a missing value is not an error — it uploads something nobody can see |
| **Google returns no refresh token on refresh** | Returning `undefined` would let a caller clear the stored one, and the channel stops publishing a day later |
| **TikTok create_time is in seconds** | Read as milliseconds it puts every post in 1970 and the reconciler matches nothing — which, after an ambiguous publish, means a duplicate |
| **TikTok returns errors inside HTTP 200** | Checking only the status code would report a video that does not exist |

**A corrected fact.** The plan recorded `videos.insert` as 1600 units of a
10,000/day quota — about six uploads a day — and `PROVIDERS.md` had flagged it
`[A]` pending a check. Checked against Google's documentation on 2026-08-31:
uploads now have their own bucket, 1 unit each, 100 per day. Six a day is a
constraint you design a product around; a hundred is not, and encoding the stale
number would have deferred publishing that did not need deferring.

#### LinkedIn, and a path that was theoretical until now

LinkedIn is the first connector that **cannot read its own posts back**. The
self-serve tier grants `w_member_social` and the OIDC scopes and nothing else;
reading a member's own shares needs `r_member_social`, which is not self-serve.

So `retrievePosts` is `false` — not unimplemented, *unavailable* — and the
consequence reaches the publishing pipeline rather than only the UI. With no
read-back there is no way to answer "did that post go out?" after an interrupted
publish, so exactly-once is genuinely unachievable and an ambiguous publish goes
to `NEEDS_REVIEW` instead of being retried.

That path was designed at the start of this project for exactly this case and
had never had a real provider behind it. LinkedIn makes it real.

Three other LinkedIn specifics, each of which would otherwise have been a bug:

- **The post id arrives in the `X-RestLi-Id` header**, with an empty 201 body. A
  connector that parses the body concludes the publish failed while the post is
  live — precisely the shape that produces a duplicate.
- **Scopes are space-separated.** A comma-joined list is silently accepted and
  the token comes back with no permissions at all, failing later at publish and
  looking like a problem with the account.
- **The member id is pairwise**, so it is specific to the app that asked.
  Changing the client id orphans every connected account, and nothing says so.

#### `notice`: the honesty case that had no home

Two of these connectors work perfectly and can still reach nobody:

- **Pinterest on Trial access** creates sandbox pins visible only to their
  creator.
- **TikTok without a passed audit** posts at private visibility.

In both, the API returns success, an id comes back, and nothing anywhere
reports a problem. That is the worst failure mode in this system — a publish
indistinguishable from a real one that reaches no one — and `disabledReason`
could not express it, because neither connector is disabled.

So the descriptor gained `notice`: a caveat about something that *works*,
rendered in warning colour on the connect screen. It stays meaningful because
only these two carry one, and a test asserts that a connector without a caveat
has none.

TikTok goes further, because it can. `creator_info` returns
`privacy_level_options` — what the app is actually permitted to use — and an
unaudited app is offered only `SELF_ONLY`. So the adapter queries before every
publish and **refuses** when the requested visibility is not on offer, naming
the audit. A refusal someone can act on beats a success they cannot see. TikTok
requires that call before posting anyway, so the check is free.

**The contract suite earned its place again**, catching three capabilities
declared true that the APIs do not offer: Pinterest comment reads, TikTok
comment reads and replies, and TikTok post deletion. Each was harmless while the
provider was a skeleton and would have become a dead control the moment it went
live.

### The compose stack, actually run

`docker compose up -d` on an empty machine: **six services healthy in about
fifteen seconds**, twenty-four migrations applied, first-run bootstrap creating
the owner account. Verified from a genuine cold start — `down -v` first, so
Postgres came up with no database at all.

It had never been run end to end before, and running it found three things no
test could have:

- **The migrate container could not migrate.** `pnpm prune --prod` ran inside
  the `build` stage, so every stage copying from it got a tree with dev
  dependencies gone — including migrate, whose whole job is `prisma migrate
  deploy`. The Prisma CLI is a devDependency. Migrate printed "applying
  migrations as owner", died with "Command prisma not found", and because every
  service waits on it completing, **the entire stack refused to start**. The
  prune is now its own stage: `build` keeps the full tree for the one container
  that needs a build tool at runtime, and the long-running services copy a
  pruned one.

- **Migrating required internet access.** Going through `pnpm exec` made
  corepack fetch pnpm from registry.npmjs.org on every migration run. On a
  self-hosted box that may have no outbound access at all, and on any box it is
  a network round trip standing between the database and the thing that migrates
  it. The script now calls the Prisma binary directly and the migrate image
  carries no package manager.

- **Every worker shutdown took twenty seconds and logged a lie.** Nothing closed
  the Publisher's Redis connection, so the event loop stayed alive after the
  tick loop ended and the process sat until the forced-exit deadline fired —
  printing "did not finish in time" about work that had finished. On a rolling
  deploy that is twenty wasted seconds per worker, every time. Now **0.56s**,
  exit 0, and the deadline is cancelled on a clean stop. A warning that fires
  when nothing is wrong is a warning people stop reading.

Verified in the running stack, not inferred:

| | |
|---|---|
| Single origin | `:3000` is the only published port. The API answers through the web proxy and **3001 is unreachable from the host** |
| RLS | `/health` reports `rowLevelSecurity: "enforced"` — the migrate script's owner/app-role split works in the real deployment shape, which is the one place it has been wrong before |
| Publishing | A due post was claimed by the **worker container** on its own tick and published — `{"msg":"variant settled","status":"PUBLISHED"}` |
| Metrics | API metrics through the proxy; the worker's on `:9464`, reachable only inside the network |
| Restart | Whole stack back in 1.8s with data intact |

### Observability

The admin console answers "is this workspace healthy?" for a person looking at a
screen. This answers "wake me at 3am" for a machine that is not looking at
anything, and the two are not substitutes — a dashboard nobody is watching
during an incident is a dashboard that did not exist.

**Metrics** at `GET /api/v1/metrics` (API) and `:9464/metrics` (worker),
in Prometheus text format. Two endpoints rather than one, deliberately: they
measure different processes, and when the worker dies its numbers should
*vanish* from the scrape rather than be reported as zero by somebody else. A
gauge reading zero and a gauge that stopped answering mean completely different
things, and only one of them is an outage.

What is measured comes from what has actually gone wrong here, not from what is
easy to count:

| | Why |
|---|---|
| `variants_overdue`, `oldest_overdue_seconds` | The single most important number. A healthy install sits at zero except between a tick and its publish, so any sustained value is a scheduler that has stopped — which otherwise looks exactly like a quiet week |
| `publishes_interrupted`, `recovery_outcomes_total` | Every `reconciled` increment is a post that was already live and would have been sent twice by a blind retry |
| `budget_denials_total` vs `provider_rate_limits_total` | Kept apart on purpose. One is our budget working, the other is our documented limit being wrong; one counter for both makes the distinction the rate-limit design rests on unmeasurable |
| `publish_lateness_seconds` | Observed for every publish, not only late ones — a histogram fed its outliers cannot say what normal looks like |
| `inbound_events_total{disposition}` | A rise in `unrouted` means a subscription points at us for an account nobody connected, and every one is being dropped correctly and invisibly |
| `nodejs_eventloop_lag_seconds` | The characteristic worker failure is a transcode pinning the loop while every other job silently stops — invisible in every application counter, because publishes simply stop arriving |

HTTP timing is labelled by **route** (`/api/v1/exports/:id/download`), never by
URL. An unbounded label value gives every request its own time series and takes
the monitoring system down — an observability change causing the outage it was
added to catch.

**Access.** `METRICS_TOKEN` is optional. What leaks without it is operational,
not personal — no message bodies, no handles — but it is commercially telling,
so an `https://` deployment with no token warns on every boot. Same shape as
`ALLOW_INSECURE_COOKIES`, and for the same reason: a private network with an
unauthenticated scrape is legitimate and refusing it would be hostile, but a
property that disappears without saying so is worse than either explicit choice.

**Structured logs.** JSON lines under `NODE_ENV=production`, human-readable
otherwise — chosen by environment rather than by the caller, because a logger
whose shape depends on who is calling it drifts within a week. Field names are
redacted by key, case-insensitively, at any depth: a field wrongly hidden costs
one debugging session, a field wrongly shown costs a credential rotation. Errors
are serialised explicitly, because `message` and `stack` are non-enumerable and
a caught error otherwise logs as `{}`.

It earned its place on first run. The new deployment-wide gauge query was
written without a tenant scope — the **sixth** instance of a cross-cutting query
that precedes tenancy — and the guard threw immediately instead of the gauge
reporting zero overdue posts forever while the scheduler was on fire.

### Export

This product stores third-party personal data — private messages, commenter
names, follower counts — belonging to people who never signed up for it, on
behalf of a controller who is our customer. "Send me everything you hold about
this person" is a request with legal weight and a clock attached, and the worst
time to discover the capability does not exist is when someone's counsel asks.

Two kinds, at `/w/:id/exports`:

| | Covers |
|---|---|
| **Workspace** | Posts, per-channel variants, a media *manifest*, metrics, connected accounts |
| **Subject** | Every conversation and message involving one handle, in this workspace |

**Asynchronous, because it has to be.** A workspace with a year of history is
not a request handler's problem, and both synchronous alternatives fail on
exactly the workspaces most likely to need one: an endpoint that times out, or a
stream that cannot be retried when it breaks halfway. The API returns a job; the
worker builds it on its tick, last in the sequence, one at a time.

Four decisions worth stating:

- **A subject export never spans workspaces.** "Everything you hold about this
  person" across tenants would answer a legitimate question by committing a
  cross-tenant leak. Each controller answers for its own data, and the file says
  so in its own `scope` field so the recipient knows the boundary.
- **The handle is matched exactly, ignoring case — never as a prefix.** `@ada`
  must not sweep up `@adamson`. Over-collecting on a subject-access request
  discloses a third party's private messages to whoever asked, turning one
  lawful answer into a second breach. There is a test for precisely this.
- **Credentials are never in the file.** The test greps the whole serialised
  output rather than checking a `select`, so it still holds when someone widens
  the query later.
- **The file is streamed through the API, not handed out as a presigned URL.** A
  presigned URL is a bearer token in a query string: it outlives the session,
  survives being pasted into a chat, and cannot be revoked. For a bundle of one
  person's message history the extra hop is worth it.

Files expire after seven days and are deleted; the **row survives as EXPIRED**,
because "an export was produced and downloaded" is a fact worth being able to
answer later, and deleting the record with the file destroys the only evidence
the request was honoured. Row counts are stored per section, so an empty export
is distinguishable from a broken one — the single most common question about any
export, and one a byte count cannot answer.

### Organising content

Campaigns, labels, templates and UTM presets — Phase 8, at `/w/:id/organise`.

**Campaigns and labels answer different questions**, so they are different
things rather than one tag system. A post belongs to at most one campaign (which
initiative was this part of) and any number of labels (what kind of thing is
it). Collapsing them is why tag lists are unusable after a year. Campaign dates
are descriptive, not enforcing: a campaign that ran 1–14 August still accepts a
post from the 15th, because that is what a follow-up is, and a tool that refuses
it teaches people to keep the real dates in a spreadsheet.

Deleting a campaign keeps its posts — the foreign key is `SetNull`, and the
confirmation says so before you click rather than after.

**Templates report what is missing rather than guessing.** Two obvious
behaviours are both wrong. Leaving `{{first_name}}` in the output publishes it
to a public timeline, which is the mail-merge failure everyone has seen. Blanking
it publishes "Hi , thanks for following", which is the same failure with a
disguise on — quieter, and therefore likelier to survive review. So rendering
returns the missing names and the caller decides: the composer shows them, the
API refuses the write, neither guesses. An empty-string value counts as
supplied, because "leave this blank" is a legitimate choice.

**UTM presets are templates, resolved per variant.** `utm_source` differs by
network — that is what the parameter is for — so `{{network}}` is filled per
channel. One hard-coded `utm_source=social` produces a report saying traffic
came from "social", which is a fact nobody needed. Two rules follow from not
being able to clean up someone else's analytics afterwards:

- **An existing `utm_*` is never overwritten.** Someone who typed
  `?utm_source=newsletter` meant it. A workspace default silently replacing a
  deliberate choice corrupts a quarter of the attribution data before anyone
  notices. What was left alone is reported, so the override is visible rather
  than merely tolerated.
- **An unresolvable variable drops the parameter** rather than emitting literal
  `{{network}}`. An absent dimension is recoverable; a polluted one has to be
  fixed in the destination.

Link detection stops before trailing punctuation, because swallowing the full
stop at the end of a sentence produces a link that 404s — worse than not tagging
at all — while keeping a balanced closing bracket, since Wikipedia URLs really
do end in ")".

All of it lives in `packages/content`: pure, zero-dependency, browser-importable,
and imported by both the composer and the API. A preview computed by different
code from the thing it previews is not a preview. Thirty-four unit tests plus
six end-to-end.

### Crash recovery, and the fault injection that proves it

Ranked risk #1 is a duplicate public post, because it is the only failure in
this system that cannot be undone. You cannot un-send it, on most networks you
cannot tell which copy people saw, and on a client account it is the kind of
mistake that ends the relationship.

The pipeline already reconciled when a provider call RETURNED an error. It did
nothing at all when the process DIED mid-call — and those are not the same
event. A killed worker returns nothing and decides nothing; it leaves a
committed IN_FLIGHT attempt, a variant sitting in PUBLISHING, and a post that
may already be public. Nothing errored, nothing retried, nothing alerted. The
variant stayed there forever, and the first person to notice would retry it by
hand, which is precisely how the duplicate happens.

A pod being OOM-killed, a node drained, a deploy rolling: that is Tuesday, not
an edge case.

**The sweep.** `recoverInterrupted()` runs at the top of every worker tick,
before anything new is claimed. It finds attempts left IN_FLIGHT past a
threshold and resolves each through the same code the live publisher uses —
`resolveAmbiguous()` is now shared, because two implementations of "did this
publish?" is two chances to be wrong in the one place where being wrong is
permanent.

The **account lease**, not the clock, is what makes it safe. A slow publish and
a dead one are indistinguishable by age; the sweep skips any account whose lease
is still held, so a live worker is never reconciled underneath. And read-back
failing during reconciliation leaves the attempt IN_FLIGHT rather than closing
it — "do not know" must not decay into "assume not published" just because the
second call failed too.

**The harness.** Five tests that spawn a real worker process and SIGKILL it. Not
a mock, not a thrown error, not `process.exit` — all three unwind cleanly, and
clean is the one thing an OOM kill is not. The kill is triggered by polling the
database for the IN_FLIGHT row, so the moment of death is defined by the same
state the reconciler will later read.

| Situation | Outcome asserted |
|---|---|
| Killed mid-publish | Attempt IN_FLIGHT, variant stuck in PUBLISHING, post already live |
| Read-back, post landed | PUBLISHED with the **discovered** remote id; ledger still holds exactly one post |
| Read-back, post absent | Requeued — confirmed absent is the only case where retry is safe |
| No read-back | NEEDS_REVIEW; at-most-once plus a human beats at-least-once plus a duplicate |
| Lease still held | Left alone for its owner |

Two things had to change before any of it could be tested honestly:

- **The mock's ledger was an in-memory `Map`.** A provider whose memory of what
  you published vanishes when *you* crash is not a provider, it is a mirror. It
  would have reported the post absent, the reconciler would have requeued, and
  the harness would have proved the opposite of what it claimed. It is now
  file-backed and written synchronously, because the process is about to be
  killed on purpose and a buffered write would be lost.
- **Providers with no read-back had no reachable branch.** Every real one is a
  skeleton here, so the NEEDS_REVIEW path — the hard case, where exactly-once is
  genuinely unachievable — could never have run in a test.

### The fifth cross-cutting query

`withReconciler` joins scheduler, retention, inbound routing and token
redemption. The sweep asks "which publishes were in flight when a worker died?",
which spans every workspace by definition, and under tenant-keyed RLS that
matches zero rows while erroring on nothing.

SELECT on `PublishAttempt` and nothing else — a separate actor rather than a
widening of `app.scheduler`, because `PublishAttempt` is the record of what we
sent to a third party and when, and that grant does not belong on the actor that
runs every thirty seconds asking which posts are due. Five tests assert both
halves against the live database: that it finds the row, and that it cannot read
a credential, a post, an account, or close the attempt it found.

### A footgun in the tenancy wrappers

Found by writing those tests. `withTenant(id, (tx) => tx.post.findMany())` — a
non-async callback returning a bare Prisma promise — threw MissingTenantScope on
a call that is perfectly correct. A Prisma promise is lazy: it does not run until
something subscribes, and a plain arrow returns it unsubscribed, so `run()`
exits and the query fires with no scope in force. All ten wrappers now await
inside the AsyncLocalStorage context. It failed loudly rather than silently,
which is the only reason it was a footgun and not a leak.

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
| **Fault-injection harness** | ~~Ranked risk #1, never written.~~ Built — see above. |
| **Entitlements, feature flags** | Architecture only. |
| **15 remaining connectors** | Documented skeletons, disabled with a stated reason. |
| **~~Empty packages~~** | `social`, `analytics` and `notifications` were scaffolded and never filled. Deleted — the code has one consumer each and lives there. See ARCHITECTURE.md. |

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
