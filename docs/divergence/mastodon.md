# Divergence report — Mastodon (Phase 4 publishing anchor)

**Anchor for:** Phase 4, the publishing engine
**Date:** 2026-08-30
**Verdict:** one pipeline assumption broken outright, two interfaces extended,
one design decision confirmed rather than changed.

An empty divergence report means the anchor was not exercised seriously.

---

## Why Mastodon

Not because it is typical — it is unusually *pleasant*. It was chosen because it
is the only self-service provider that exercises **every** part of the publishing
design at once: real OAuth2, media that processes asynchronously, a native
idempotency header, real rate-limit headers, and genuine read-back.

It also needs no app review, no partner programme and no payment, so the anchor
is reproducible by anyone with the repository.

---

## 1. Media upload returns BEFORE processing finishes — pipeline changed

**Expected:** `upload(file) -> mediaId`, then attach the id to the post.
`MockProvider` returned a ready id synchronously, because in a simulator there is
nothing to wait for.

**Found:** `POST /api/v2/media` answers **202** with the attachment's `url` set to
`null` while the instance transcodes. The id is real, but attaching it to a status
immediately **fails**. Readiness is a second call: `GET /api/v1/media/:id` returns
**206** while still processing and **200** once done.

**Changed:** the adapter now polls to completion, bounded at two minutes, before
the status is created. Past the bound it raises `InvalidMedia` with a message
naming the likely cause — a small instance struggling to transcode a large video —
rather than holding a publish job open indefinitely.

**This is the single most valuable thing the anchor exposed.** The whole
`PREPARING_MEDIA` variant state existed on the assumption that provider media
upload is synchronous and only *our* transcoding is slow. It is not. The plan
already anticipated "published can be a container ID that later fails
processing"; what it had not anticipated is that the *upload itself* completes
before the media is usable, which is a different failure at a different moment.

## 2. Idempotency is native — and it is the first time that has been true

**Expected:** reconstruct exactly-once ourselves from a write-ahead attempt row
plus a mutation-tolerant fingerprint, because almost no provider offers a native
key.

**Found:** Mastodon honours an `Idempotency-Key` header on status creation and
genuinely suppresses the duplicate.

**Changed:** nothing structural — the header is now sent, and the fingerprint
machinery remains as the fallback. What changed is our confidence: this is the
first connector where exactly-once is the *provider's* guarantee rather than our
reconstruction, and it is the reference implementation for what the fingerprint
path is approximating.

The plan assumed this without confirmation; it is now verified against the
documentation cited in the table below.

## 3. The character limit is per instance — TextProfile extended

**Expected:** one `maxLength` per provider surface. 500, in Mastodon's case.

**Found:** 500 is a **default**, not a rule. Instances routinely raise it; some
run at 5,000 or more. A composer enforcing 500 against an instance allowing 5,000
is wrong in the direction users notice most — it refuses posts the server would
have accepted.

**Changed:** the real limit is read from `/api/v2/instance` at connect time and
stored on the account's `platformMeta`. Because `validate()` is pure and takes
only the draft, it cannot see per-account state, so the adapter gained
`validateFor(draft, account)` — the account-aware variant the composer uses when
it has one, falling back to the provider default when it does not.

This is the second time a text constraint has turned out not to be a property of
the provider alone. Telegram's caption limit depends on whether media is
attached; Mastodon's depends on which server you are talking to. The profile
model handles both now, but the general lesson is that "keyed by surface" was
necessary and not sufficient.

## 4. There is no global Mastodon — connectFields generalised

**Expected:** OAuth means a redirect, and a redirect means a URL we can build
from configuration.

**Found:** the app must be registered on **each instance** via `POST
/api/v1/apps`, which returns a client id and secret specific to that server. Until
someone names an instance, there is literally nothing to redirect to.

**Changed:** what began as `credentialFields` — a form for providers with no
redirect at all, like Bluesky and Telegram — became `connectFields`: values
collected *before* connecting, whatever happens next. For a credentials provider
they are the credential; for Mastodon they are what makes the authorize URL
constructible.

Without this, Mastodon would have sat behind a Connect button that could not
work — the same dead control the honesty policy rules out, arrived at from a
completely different direction.

The per-instance client secret also has to survive the OAuth round trip, since the
token exchange happens against the same instance with the same app. It is carried
inside the `state` parameter rather than stored server-side, which keeps the
callback stateless.

## 5. Scheduling stays ours — decision confirmed, not changed

Mastodon supports `scheduled_at`. We do not use it, and the anchor is the reason
that choice is now written down rather than assumed.

Handing a status to the instance to publish later would put half the content
calendar somewhere we cannot edit, cancel, reschedule, or report on — and the
approval gate, the catch-up window and the `MISSED` state would all silently stop
applying to it. `draftSupport: false` is a deliberate refusal of a feature the
provider offers, which is a distinction the capability matrix can now express.

## 6. Statuses come back as HTML

Minor, but it would have broken reconciliation silently. `retrievePosts` returns
`content` as HTML; the fingerprint compares against what we **sent**, which was
plain text. Without stripping, similarity matching never matches, reconciliation
reports "not found", and the pipeline creates the duplicate the whole mechanism
exists to prevent.

`stripHtml` is deliberately minimal — it feeds similarity matching, not display,
so it needs to be *stable*, not correct in every edge case.

---

## Capability confidence after this pass

| Capability | Before | After | Source |
|---|---|---|---|
| `Idempotency-Key` on statuses | `[A]` | `[V]` | [statuses](https://docs.joinmastodon.org/methods/statuses/), retrieved 2026-08-30 |
| `editPost` preserves the id | `[A]` | `[V]` | [edit](https://docs.joinmastodon.org/methods/statuses/#edit), retrieved 2026-08-30 |
| Rate limit 300 / 5 min | `[A]` | `[V]` | [rate limits](https://docs.joinmastodon.org/api/rate-limits/), retrieved 2026-08-30 |
| URLs count as 23 characters | `[U]` | `[V]` | [posting](https://docs.joinmastodon.org/user/posting/#links), retrieved 2026-08-30 |
| Four attachments per status | `[A]` | `[V]` | [statuses](https://docs.joinmastodon.org/methods/statuses/), retrieved 2026-08-30 |

Still `[A]`: the per-instance media size ceiling. The documented defaults are
8 MB for images and 40 MB for video, but every instance may change both, and the
adapter deliberately budgets to the lower figure rather than claiming a number it
cannot know before upload.

---

## What was verified live

App registration and authorize-URL construction were exercised against the real
`mastodon.social`: the connector registered an OAuth app and produced an
authorize URL that the server accepted. Instance normalisation was checked
against a plain-`http` address and refused — an instance reached over http would
carry the access token in clear text.

The publish, media-processing and reconciliation paths are implemented and unit
tested but have **not** been run against a live instance with a real account,
because that needs credentials this environment does not have. That limitation is
stated rather than papered over: the asynchronous-media finding above comes from
the documented API contract and the shape of the responses, and the polling loop
it produced deserves a live run before anyone relies on it in production.
