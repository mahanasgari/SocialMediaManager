# Divergence report — Telegram (Phase 6 inbox anchor)

**Anchor for:** Phase 6, the unified inbox
**Date:** 2026-08-30
**Verdict:** design changed in three places, mock corrected in one, one capability
split into two.

An empty divergence report means the anchor was not exercised seriously. This one
is not empty.

---

## Why Telegram was chosen

Not because it is representative — it is not. It was chosen precisely because its
model does **not** match ours, which is the only way to find out whether the
abstraction survives contact with something it was not designed around.

It is also self-service: a bot token from `@BotFather` needs no app review, no
partner programme, and no payment, so the connector is reachable by anyone
reading this repository.

---

## 1. `comments` conflated two different things — capability split

**Expected:** a provider that supports comments can both receive and fetch them.
`MockProvider` implemented `comments: true` with a working `fetchComments`, and
in a simulator that pairing is so natural nobody questions it.

**Found:** a Telegram bot cannot enumerate comments. There is no "list replies to
this message" method. Comments on a channel post arrive as updates in the linked
discussion group, or they are not observed at all. The *concept* exists; the
*retrieval* does not.

**Changed:** the pipeline, not the mock. `comments` now means "the inbox can
RETRIEVE on demand" and `replies` means "we can respond to something already
delivered". Telegram is the second without the first.

This matters beyond Telegram: every push-only provider is the same shape, and
under the old reading each one would have had to either claim a `fetchComments`
it could not implement or disclaim comment support it genuinely has. The
bidirectional contract test caught it immediately — declaring `comments: true`
with no `fetchComments` failed on the first run.

## 2. `retrievePosts: false` is load-bearing, and the mock never exercised it

**Expected:** reconciliation after a lost response queries recent posts and
matches on a mutation-tolerant fingerprint.

**Found:** a bot cannot read back its own sent messages. There is no method for
it. So for Telegram, **exactly-once publishing is not achievable** — the
reconciliation path the idempotency design leans on simply does not exist.

**Changed:** nothing in the code, which is the point — the design had already
specified `NEEDS_REVIEW` over blind retry for exactly this case. What changed is
that the branch is now covered by a real provider rather than a hypothetical.
`MockProvider` has `retrievePosts: true`, so before Telegram the degradation path
had never run against anything real.

The choice this encodes, stated plainly: **at-most-once plus human review, over
at-least-once plus duplicates.** A duplicate public post is unrecoverable. A
review prompt is annoying.

## 3. The text limit depends on whether media is attached

**Expected:** one `maxLength` per surface.

**Found:** Telegram allows 4096 characters in a message but **1024 in a media
caption** — and a post with an image is the common case, so the lower limit is
the one that actually binds.

**Changed:** `TextProfile` gained `maxLengthWithMedia`, and `validateText` picks
the applicable limit from whether the draft has media. The error message names
both numbers, because a composer that says "1024" to someone who knows Telegram's
headline figure looks broken rather than correct.

Without this the composer would have shown 4096, accepted the draft, and failed
at publish time — telling the writer a comfortable lie they discover only after
the work is done.

## 4. Verification is a shared secret, not a signature — and that is weaker

**Expected:** HMAC over the raw body, as Meta and Slack do.

**Found:** Telegram does not sign the body at all. It echoes a `secret_token`,
chosen by us at `setWebhook` time, in a header.

**Changed:** nothing structural — `verifyWebhook` already took raw bytes and
returned a verdict, so a constant-time secret comparison fits the same shape. But
the security property is genuinely different and is now written down in the
adapter: because the body is unsigned, **a leaked secret allows forging arbitrary
content**, whereas a leaked HMAC key would at least still bind the payload to
what was sent.

This is why the endpoint refuses to receive at all when
`TELEGRAM_WEBHOOK_SECRET` is unset, rather than accepting unsigned events "until
it is configured".

## 5. Webhook and long-poll are mutually exclusive, not alternatives

**Expected:** polling as a fallback when webhook delivery is unavailable.

**Found:** calling `getUpdates` while a webhook is registered is an **error**, not
a degraded mode. A deployment must choose one.

**Changed:** nothing yet, but it sharpens `INBOUND_MODE=poll|webhook|auto`: `auto`
cannot mean "try both". It must probe `PUBLIC_URL` reachability at boot and
commit. `parseWebhook` is shared by both paths precisely so the inbox never
learns which one delivered a message.

## 6. Mock corrected: `webhooks: true` with nothing behind it

Not a Telegram finding, but surfaced by the work. `MockProvider` declared
`webhooks: true` and had no `verifyWebhook` — a capability claim with no
implementation, which is exactly the dead-button failure the bidirectional
contract test exists to catch. It failed the moment `webhooks` was added to the
method map.

`MockProvider` now does **real HMAC over real raw bytes** with
`MOCK_WEBHOOK_SECRET`, not a stub returning `true`. A mock that waves events
through would have validated the receiver against a fiction — and the receiver is
the one place in the system where workspace context comes from untrusted input.

---

## Capability confidence after this pass

| Capability | Before | After | Source |
|---|---|---|---|
| `editPost` (48h window) | `[A]` | `[V]` | [Bot API `editMessageText`](https://core.telegram.org/bots/api#editmessagetext), retrieved 2026-08-30 |
| `retrievePosts` | `[A]` | `[V]` false — no such method exists | [Bot API method index](https://core.telegram.org/bots/api), retrieved 2026-08-30 |
| Rate limits (~30/s, 20/min per group) | `[A]` | `[V]` | [Bot FAQ](https://core.telegram.org/bots/faq#my-bot-is-hitting-limits-how-do-i-avoid-this), retrieved 2026-08-30 |
| Caption limit 1024 vs 4096 | `[U]` | `[V]` | [Bot API `sendMessage`](https://core.telegram.org/bots/api#sendmessage), retrieved 2026-08-30 |
| `secret_token` header | `[A]` | `[V]` | [Bot API `setWebhook`](https://core.telegram.org/bots/api#setwebhook), retrieved 2026-08-30 |
| Media 10 MB photo / 50 MB file | `[A]` | `[V]` | [Sending files](https://core.telegram.org/bots/api#sending-files), retrieved 2026-08-30 |

Still `[A]`: per-message view counts for administered channels. The method exists
but has not been exercised against a real channel, so the analytics shape is
declared and returns nulls rather than claiming numbers it has not seen.

---

## The bug this anchor found in the receiver

Worth recording separately, because it was not a provider divergence — it was
ours, and it was silent.

Routing an inbound event requires finding **every** `SocialAccount` matching a
`providerAccountId`, across all workspaces, before any workspace is known.
`SocialAccount` carried only a tenant-isolation RLS policy, so that lookup ran
with no `app.current_workspace` set, matched zero rows, and classified **every
event** as unrouted.

The inbox would have stayed permanently empty in production with nothing logging
an error. It was found only by sending a real event to a real account and
checking the table.

Fixed with a named narrow actor, `app.inbound_router` — SELECT on
`SocialAccount` only, plus write access to the three inbound tables. It cannot
read message bodies, credentials, or posts. This is the fourth instance of the
same pattern (membership discovery, the scheduler sweep, public link pages, and
now inbound routing): **a cross-cutting query that legitimately precedes tenancy
gets a named, minimal, greppable actor — never an RLS bypass.**
