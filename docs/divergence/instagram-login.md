# Divergence report — Instagram Login (third anchor)

**Anchor for:** the connector abstraction under a second OAuth flow to the same network
**Date:** 2026-09-06
**Verdict:** one interface gap found and closed, one capability declared false rather
than approximated, one shared helper deliberately not shared, and one bug in the
core that had nothing to do with Instagram.

An empty divergence report means the anchor was not exercised seriously. This one
is not empty.

---

## Why this is the third anchor

The plan named Reddit for Phase 7 and it was dropped. Nothing replaced it, so the
gate had two reports where it asked for three.

Instagram Login is a better third anchor than Reddit would have been, for a
reason that only became visible once it existed: it is **the same network reached
a different way**. Mastodon and Telegram each tested whether the abstraction
survives an unfamiliar provider. This tests something the other two could not —
whether the abstraction can hold *two connectors to one network* whose token
models disagree. That is the case a registry of twenty-three providers will meet
again, and it is the one where "just add a flag to the existing adapter" is most
tempting and most wrong.

---

## 1. `platformOptions` was read by the pipeline and writable by nothing

**Expected:** a per-post provider setting reaches the adapter. `PostVariant`
carried a `platformOptions` JSONB column, the publish pipeline's payload type
declared the field, and every adapter that needed one read it.

**Found:** the column defaulted to `{}` and nothing ever wrote it. The API had no
parameter for it; the composer had no field; and `loadContext` did not select the
column, so the payload handed to adapters omitted it entirely.

For most connectors this was invisible, because they fall back to a default — a
Pinterest board from `platformMeta`, a YouTube privacy level. **For Telegram it
was fatal**: `publish()` requires a chat id and refuses without one, so that
connector could not publish anything at all while reporting `configured: true`
with no disabled reason.

**Changed:** the pipeline now selects and passes the column; the API accepts
`platformOptions` keyed by account; providers declare `postOptionFields` and the
composer renders them. Keyed by *account* rather than provider, because a
workspace can hold two Telegram bots posting to different channels.

**Why the anchor found it:** it was found by reading adapters against the UI
while preparing to connect a real account — not by a test. Every test passed
throughout. A mock provider needs no per-post option, so no simulator would ever
have exercised the path.

---

## 2. `surface: 'feed'` was hard-coded, and eleven connectors have no feed

**Expected:** a post targets a surface the provider declares.

**Found:** both the validate endpoint and the variant writer used the literal
string `'feed'`. Instagram publishes to `feedImage`, `reel` or `story`; YouTube
to `feedVideo` or `short`; Pinterest to `pin`; Medium, WordPress, Blogger and
WeChat to `article`. Eleven of twenty-six connectors have no `feed` at all.

`provider.text['feed']` returned `undefined` for every one of them, so they
displayed **no character limit and were validated against nothing**. A
5,000-character Instagram caption passed the composer and would have been
refused at publish time. Worse on the write path: a variant stored with a
surface its provider does not have stays unvalidatable for its whole life.

**Changed:** the registry derives `defaultSurface` from the order of the media
profiles — the author's statement of what a connector is mainly for. Derived
rather than declared, so adding a connector cannot forget it. Five tests assert
every provider's default resolves to a real media profile, a real text profile,
and a numeric character limit.

**Why the anchor found it:** the mock provider declares `feed`, and so does every
connector anyone had exercised end to end. The bug was invisible until a
connector without a feed was actually used.

---

## 3. `dm` declared false rather than approximated

**Expected:** Instagram supports direct messages, so the connector should too.

**Found:** the Facebook Login connector sends messages to `/{pageId}/messages`.
Instagram Login yields **no Page**, so that endpoint has no address to use. Meta
does publish an Instagram messaging surface; this connector does not implement
it.

**Changed:** nothing — deliberately. `dm: false`, no `sendMessage` method, and a
`notice` on the connector saying DMs are unsupported here and pointing at the
Facebook Pages route. The contract suite enforces the pairing in both
directions, so a half-implemented method behind a false flag cannot reach the UI.

**The finding:** the capability matrix held. The temptation to declare `dm: true`
and throw at runtime was real, and the bidirectional contract test is what makes
that not merely discouraged but impossible to ship.

---

## 4. The shared Meta helper was deliberately not shared

**Expected:** two connectors to Meta properties share `meta/graph.ts`.

**Found:** almost nothing is shareable. Different authorization host
(`instagram.com` vs `facebook.com`), different token-exchange host
(`api.instagram.com` vs `graph.facebook.com`), different API host
(`graph.instagram.com` vs `graph.facebook.com`), different app credentials
(Instagram App ID, **not** the Facebook one), different token type, and a refresh
story that exists on one side and not the other.

**Changed:** a separate `meta/instagram-login.ts`. A single helper would have
branched on which flow it was in inside every function, and Facebook Pages still
needs the old flow.

**The general lesson:** "same vendor" is not "same API". The instinct to
consolidate would have produced a helper that was harder to read than two.

---

## 5. Two connectors to one network, and why it is two providers

**Expected:** a flag on the existing Instagram adapter.

**Found:** the two flows disagree about things the capability matrix is supposed
to state truthfully.

| | Facebook Login | Instagram Login |
|---|---|---|
| Facebook Page | required | not required |
| Token | Page token, no expiry | Instagram User token, 60 days |
| Refresh | impossible — `refreshToken()` throws | renews without the person present |
| DMs | yes | no |
| App Review | already granted | needed again |

One class serving both would branch on which kind of token it held in every
method, and **that branch would be invisible in the capability matrix** — the one
place this product promises the truth. Existing connections would also have to
survive a flow they cannot use.

**Changed:** `instagramLogin` registered as a second provider. Existing Page-token
accounts keep working untouched.

---

## What the mock was corrected on

Nothing. `MockProvider` declares `feed` and needs no per-post option, so it was
not wrong — it was **silent**, which is the failure mode the anchors exist to
expose. The corrections landed in the pipeline and the registry instead.

The honest note: two of the four findings above (`platformOptions`,
`surface: 'feed'`) are bugs in the **core**, not in the Instagram connector. They
had been present since Phase 4 and would have shipped indefinitely, because every
test passed and every connector anyone had exercised happened to have a feed and
need no per-post option.

---

## Capability confidence

Every verified marker in `instagramLogin/` carries a source URL and a retrieval date
of 2026-09-02, verified against Meta's live documentation rather than from
memory — including one, `instagram_business_manage_insights`, that was checked
specifically because a competitor's authorize URL requested it and Meta's own
"Instagram API with Instagram Login" page did not list it. It is real, and
documented on the insights reference page.

**Not yet verified against a live account.** The connector has not published a
real post, because publishing, comments and insights each require Meta App
Review. The flow, scopes, endpoints and token lifecycle are documented facts;
whether Instagram accepts what we send is unverified until an audited app exists. That
distinction is stated here rather than blurred.
