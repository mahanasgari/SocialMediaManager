# PROVIDERS

Every social network is an independent adapter behind one interface. This document is the contract, the matrix, and the honesty ledger.

## Evidence markers

`[V]` verified — **must cite a source URL and retrieval date on the same or next line**. `[A]` assumed from precedent. `[U]` unknown; must be checked before code depends on it. <!-- evidence-gate:ignore -->

CI enforces the citation rule (`scripts/gate-evidence-markers.mjs`). A marker that cannot cite is downgraded on sight.

---

## 1. Adapter interface

```ts
interface SocialProvider {
  readonly id: ProviderId
  readonly capabilities: ProviderCapabilities   // capabilities.ts
  readonly limits: ProviderLimits               // limits.ts  (rate budgets)
  readonly media: MediaProfiles                 // media.ts   (keyed by surface)
  readonly text: TextProfiles                   // text.ts    (keyed by surface)

  // Connection lifecycle
  getAuthUrl(ctx: AuthContext): Promise<AuthRedirect>
  handleCallback(ctx: AuthContext, params: CallbackParams): Promise<DiscoveredAccount[]>
  refreshToken(cred: Credential): Promise<TokenSet>
  revoke?(cred: Credential): Promise<void>
  fetchProfile(account: Account): Promise<ProfileInfo>

  // Publishing
  validate(variant: VariantDraft): ValidationIssue[]   // PURE — no I/O
  publish(account: Account, payload: PublishPayload): Promise<PublishResult>
  retrievePosts?(account: Account, since: Date): Promise<RemotePost[]>  // reconciliation
  deletePost?(account: Account, remoteId: string): Promise<void>
  editPost?(account: Account, remoteId: string, payload: PublishPayload): Promise<PublishResult>

  // Engagement
  fetchComments?(account: Account, remoteId: string, cursor?: string): Promise<Paged<Comment>>
  replyToComment?(account: Account, remoteId: string, body: string): Promise<Comment>
  fetchMentions?(account: Account, cursor?: string): Promise<Paged<Mention>>
  fetchConversations?(account: Account, cursor?: string): Promise<Paged<Conversation>>
  sendMessage?(account: Account, conversationId: string, body: string): Promise<Message>
  verifyWebhook?(rawBody: Buffer, headers: Headers): WebhookVerification

  // Analytics
  fetchPostMetrics?(account: Account, remoteId: string): Promise<RawMetrics>
  fetchAccountMetrics?(account: Account): Promise<RawMetrics>
  fetchAudience?(account: Account): Promise<AudienceBreakdown>
}
```

### Three rules the architecture enforces

**1. `handleCallback` returns an array.** One Facebook OAuth grant yields many Pages; one Google grant yields many YouTube channels. Modelling this as 1:1 forces a painful migration later.

**2. `validate()` is pure and shared.** The composer imports it to warn live ("302 graphemes, 2 over Bluesky's limit"); the worker calls it again before publishing. One definition of every platform rule, no client/server drift.

**3. Optional methods mirror capabilities, checked at runtime.** Conditional types bind methods to capabilities for the adapter *author*, but any code iterating the registry holds the widened union where those intersections collapse — and every real call site does exactly that. So the runtime guard is the actual guarantee:

```ts
withCapability(adapter, 'dm')
await adapter.sendMessage(...)   // narrowed, and checked
```

A **bidirectional contract test** asserts declared capabilities and implemented methods agree both ways: `dm: true` requires a working `sendMessage`, and `dm: false` must not expose one. A half-implemented method behind a `false` flag is how a dead button eventually reaches the UI.

---

## 2. Capability taxonomy

`capabilities.ts` uses `as const satisfies Record<CapabilityKey, boolean>` with **no partials permitted**. Adding a key to the taxonomy breaks compilation across all 23 providers until each declares it — which is desired, because a silently-defaulted `false` on a provider that actually supports the feature is a permanently invisible gap.

| Group | Keys |
|---|---|
| Publishing | `textPost`, `imagePost`, `videoPost`, `carousel`, `linkPost`, `thread`, `story`, `reel`, `shortVideo`, `livePost`, `firstComment` |
| Post lifecycle | `draftSupport`, `editPost`, `deletePost`, `retrievePosts` |
| Engagement | `comments`, `replies`, `mentions`, `dm`, `conversations`, `reactions` |
| Analytics | `analytics`, `audienceAnalytics`, `followerMetrics`, `contentMetrics` |
| Infrastructure | `webhooks`, `multiAccount`, `pageDiscovery`, `revokeToken` |

`retrievePosts` is special: **it is what makes exactly-once publishing possible.** A provider without it cannot be reconciled after a lost response, so its variants go to `NEEDS_REVIEW` instead of being retried.

---

## 3. Constraints are keyed by surface, not by provider

Instagram feed images and Instagram Reels have *incompatible* rules. A provider-keyed profile would encode feed rules and reject every valid Reel.

```ts
// packages/providers/instagram/media.ts
export const mediaProfiles = {
  feedImage: {
    mime: ['image/jpeg'],                      // JPEG only
    aspect: { min: 0.8, max: 1.91 },           // 4:5 .. 1.91:1
    maxBytes: 8 * MB, maxCount: 10,
  },
  reel: {
    mime: ['video/mp4', 'video/quicktime'],
    videoCodec: ['h264', 'hevc'], audioCodec: ['aac'], audioMaxHz: 48_000,
    fps: { min: 23, max: 60 },
    aspect: { min: 0.01, max: 10 }, recommended: 9 / 16,
    duration: { minSec: 3, maxSec: 900 },
    container: { moovAtomFront: true, closedGop: true, chroma: '4:2:0' },
  },
} as const satisfies MediaProfiles
```

`text.ts` carries character limits, hashtag and mention caps, and link handling per surface. Both live in the browser-importable `capabilities/` subpath, so **the composer and the API validate identically**, and the same profiles are the transcoder's target specifications (`moovAtomFront` maps to ffmpeg `-movflags +faststart`).

---

## 4. Provider states — the honesty ledger

Every provider is in exactly one state. Nothing unsupported is ever faked.

| State | Meaning | In the connect UI |
|---|---|---|
| `implemented` | Real API calls, fixture-tested, contract suite passing | Enabled when configured |
| `skeleton` | Interface, capabilities, documented endpoints, explicit `TODO` boundaries | **Disabled, with the reason shown** |
| `mock` | Simulator only | Demo mode only |

A provider the operator has not configured shows `configured: false` and is disabled with "not configured by your administrator" — never hidden, never silently absent.

### Planned trajectory

| Wave | Providers | Gate |
|---|---|---|
| Anchors (Phases 4/6/7) | Mastodon, Telegram, Reddit | Each ships with a **divergence report** |
| Wave 2 (Phase 11) | Bluesky, Discord, Slack | No approval needed |
| Wave 3 (Phase 11) | LinkedIn Profiles, X, Tumblr | Self-service developer app |
| Wave 4 (Phase 11) | Facebook, Instagram, Threads, TikTok, YouTube, Pinterest, Google Business, LinkedIn Company Pages | Blocked on platform review — **applications filed in Phase 2** |
| Skeleton indefinitely | WhatsApp Business, Snapchat, WeChat, VK, Medium, WordPress, Blogger | Restricted, partner-gated, or low priority |

---

## 5. Capability matrix

Confidence column applies to the row as a whole; per-claim markers appear in the notes below.

<!-- evidence-gate:ignore-block-start Summary table; citations are in section 6 -->
| Provider | Text | Image | Video | Carousel | Thread | Story | Reel | 1st cmt | Retrieve | Comments | DM | Analytics | Audience | Webhooks | Confidence |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Mastodon | ✔ | ✔ | ✔ | — | ✔ | — | — | ✔ | ✔ | ✔ | ✔ | — | — | — | **[V]** |
| Telegram | ✔ | ✔ | ✔ | ✔ | — | — | — | — | — | ✔ | ✔ | ✔ | — | ✔ | [A] |
| Bluesky | ✔ | ✔ | ✔ | — | ✔ | — | — | ✔ | ✔ | ✔ | — | — | — | — | **[V]** |
| Reddit | ✔ | ✔ | ✔ | — | — | — | — | ✔ | ✔ | ✔ | ✔ | ✔ | — | — | [A] |
| Discord | ✔ | ✔ | ✔ | — | ✔ | — | — | — | ✔ | ✔ | ✔ | — | — | ✔ | [A] |
| Slack | ✔ | ✔ | ✔ | — | ✔ | — | — | — | ✔ | ✔ | ✔ | — | — | ✔ | [A] |
| X | ✔ | ✔ | ✔ | — | ✔ | — | — | ✔ | ✔ | ✔ | ✔ | ✔ | — | — | **[V]** |
| LinkedIn (profile) | ✔ | ✔ | ✔ | ✔ | — | — | — | ✔ | ✔ | ✔ | — | ✔ | — | — | **[V]** |
| LinkedIn (org page) | ✔ | ✔ | ✔ | ✔ | — | — | — | ✔ | ✔ | ✔ | — | ✔ | ✔ | — | **[V]** |
| Facebook Pages | ✔ | ✔ | ✔ | ✔ | — | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | [A] |
| Instagram | — | ✔ | ✔ | ✔ | — | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | **[V]** |
| Threads | ✔ | ✔ | ✔ | ✔ | ✔ | — | — | — | ✔ | ✔ | — | ✔ | — | [U] | [A] |
| TikTok | — | ✔ | ✔ | ✔ | — | — | — | — | ✔ | ✔ | — | ✔ | ✔ | [U] | **[V]** |
| YouTube | — | — | ✔ | — | — | — | — | — | ✔ | ✔ | — | ✔ | ✔ | ✔ | [A] |
| Pinterest | — | ✔ | ✔ | ✔ | — | — | — | — | ✔ | ✔ | — | ✔ | — | — | **[V]** |
| Google Business | ✔ | ✔ | — | — | — | — | — | — | ✔ | ✔ | — | ✔ | — | — | [A] |
| Tumblr | ✔ | ✔ | ✔ | ✔ | — | — | — | — | ✔ | ✔ | ✔ | — | — | — | [A] |
| Medium | ✔ | ✔ | — | — | — | — | — | — | [U] | — | — | — | — | — | [A] |
| WordPress | ✔ | ✔ | ✔ | — | — | — | — | — | ✔ | ✔ | — | — | — | ✔ | [A] |
| Blogger | ✔ | ✔ | — | — | — | — | — | — | ✔ | ✔ | — | — | — | — | [A] |
| WhatsApp Business | ✔ | ✔ | ✔ | — | — | ✔ | — | — | [U] | — | ✔ | [U] | — | ✔ | [U] |
| Snapchat | — | ✔ | ✔ | — | — | ✔ | — | — | [U] | [U] | [U] | [U] | [U] | [U] | [U] |
| VK | ✔ | ✔ | ✔ | ✔ | — | ✔ | — | — | [U] | ✔ | ✔ | [U] | — | [U] | [U] |
| WeChat | ✔ | ✔ | ✔ | — | — | — | — | — | [U] | [U] | [U] | [U] | — | [U] | [U] |

<!-- evidence-gate:ignore-block-end -->
**A `[U]` row must not ship as `implemented`.** It ships as `skeleton` until someone verifies it against primary documentation.

---

## 6. Per-provider notes

### Mastodon — Phase 4 anchor
Client registration is **dynamic per instance** (`POST /api/v1/apps`), so credentials live in `SocialAccount.platformMeta`, not in env. Character limit is **instance-configurable** and must be read from `/api/v1/instance` rather than hard-coded at 500. Tokens do not expire. Supports an `Idempotency-Key` header on status creation `[A]` — one of the things the anchor must confirm.
Source: https://docs.joinmastodon.org/methods/statuses/ retrieved 2026-08-29 **[V]** (endpoints and media flow)

### Telegram — Phase 6 anchor
Bot API, not OAuth. The bot must be an administrator of the target channel. No app review, no cost. Offers both webhook and long-poll delivery, which is exactly why it anchors the inbox phase — it exercises both inbound paths.

### Bluesky
AT Protocol `com.atproto.repo.createRecord` with `app.bsky.feed.post`; blobs via `uploadBlob`. OAuth is now recommended over app passwords for end-user apps. Rate limit is points-based, roughly 1,666 record creations per hour per account.
Source: https://docs.bsky.app/docs/api/com-atproto-repo-create-record retrieved 2026-08-29 **[V]**

### Reddit — Phase 7 anchor `[A]`
Chosen to anchor analytics because scores drift after publish, 429s are real, and there is no insights API — forcing honest degradation. **Verify current free-tier commercial terms before Phase 7 commits.** Fallback anchor: Bluesky, which exposes like/repost/reply counts on the post record.

### X
Pay-per-use is the default for new developers since February 2026; the free tier is closed to new signups. Posting is **$0.015 per post, and $0.20 per post containing a URL** (summoned replies remain $0.01). This is backwards from every other platform for a scheduling tool — marketing posts carry links — so the composer itemises estimated cost per channel and workspaces can set a spend cap.
Sources: https://docs.x.com/x-api/getting-started/pricing and https://x.com/XDevelopers/status/2044919377544261979 retrieved 2026-08-29 **[V]**

### LinkedIn
Personal profiles need only the "Share on LinkedIn" product and `w_member_social` — no partner approval, available same-day. **Company pages** need `w_organization_social`, an admin role, and Community Management API access through the Marketing Developer Platform partner programme.
Sources: https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/share-on-linkedin and https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api retrieved 2026-08-29 **[V]**
Approval timeline of 3–4 months is `[A]` — no primary document states a target. Plan for uncertainty; do not promise a date.

### Instagram
Requires a Business or Creator account linked to a Facebook Page. Publishing is two-step: create a container at `/{ig-user-id}/media`, then `/{ig-user-id}/media_publish`. **Media is pulled by Instagram from a public HTTPS URL**, which drives `MEDIA_PUBLIC_MODE` (see `ARCHITECTURE.md` §7).

Feed images: JPEG only, aspect between 4:5 and 1.91:1.
Source: https://developers.facebook.com/documentation/instagram-platform/content-publishing retrieved 2026-08-29 **[V]**

Reels are a different surface entirely: MOV or MP4, H264 or HEVC video, AAC audio at or below 48 kHz, 23–60 fps, aspect 0.01:1 to 10:1 (9:16 recommended), closed GOP, 4:2:0 chroma, moov atom at the front of the file.
Source: https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media/ retrieved 2026-08-29 **[V]**

### TikTok
Unaudited apps can call the Content Posting API, but **all content is forced to private/self-only visibility** — real people cannot see it. Public posting requires passing TikTok's Content Posting audit, which demands a demo video of a compliant, working integration. Ships as `skeleton` until audited, and the UI must never imply public reach.
Source: https://developers.tiktok.com/docs/en/content-posting-api-reference-direct-post retrieved 2026-08-29 **[V]**

### Pinterest
Trial access creates **sandbox pins visible only to their creator**, capped around 1,000 requests/day. Standard access is free but requires a video review of the OAuth flow. A pin needs a `board_id`.
Source: https://developers.pinterest.com/docs/key-concepts/access-tiers/ retrieved 2026-08-29 **[V]**

### YouTube
`videos.insert` is expensive against the default daily quota, and increases require a compliance audit. Resumable upload protocol. Commonly cited as 1600 units against 10,000/day, with recent documentation also describing a separate per-day upload bucket — **marked `[A]` because I have not confirmed this against Google's own quota documentation.** Verify at https://developers.google.com/youtube/v3/determine_quota_cost before the budget declaration in `limits.ts` is trusted.

### WhatsApp Business, Snapchat, WeChat, VK
Restricted, partner-gated, or regionally constrained access `[A]`. These ship as `skeleton` with documented endpoints and explicit TODOs. Do not represent them as working.

---

## 7. Error taxonomy

Every adapter maps provider errors into one shared taxonomy. **The retry policy reads the taxonomy, never the provider.**

| Code | Retryable | Effect |
|---|---|---|
| `RateLimited` | yes | Honour `Retry-After`; multiplicative decrease of the account's refill rate |
| `ProviderDown` | yes | Exponential backoff |
| `TokenExpired` | no | Account to `NEEDS_REAUTH`, notify, stop burning retries |
| `PermissionRevoked` | no | Account to `NEEDS_REAUTH`, notify |
| `InvalidMedia` | no | Variant to `FAILED` with the specific reason |
| `ContentRejected` | no | Variant to `FAILED` with the provider's stated reason |
| `PermanentFailure` | no | Variant to `FAILED` |

Every mapped error carries a **human-readable message**: *"LinkedIn rejected this media because the video format is unsupported"*, never *"API Error 400"*. Provider error bodies are frequently unstructured prose, so the mapper extracts what it can and falls back to a written explanation of the code — never to the raw body, which may contain tokens.

---

## 8. Rate budgets

`limits.ts` ships in the provider directory. A connector arrives with its limits or it does not arrive — CI gate #2 fails otherwise.

```ts
export const limits = {
  publish:   { cost: 1600, window: '24h', budget: 10_000, unit: 'quota' },
  analytics: { cost: 1,    window: '24h', budget: 10_000, unit: 'quota' },
  scope: 'app',                    // 'app' | 'account' | 'both'
  concurrency: { perAccount: 1, perProvider: 4 },
  onProviderLimit: { honorRetryAfter: true, backoffFactor: 0.5, recoverAfter: '15m' },
} as const satisfies ProviderLimits
```

`scope` is explicit because **both errors are real**: per-app budgets applied per-account exhaust the app quota, and the reverse throttles everyone needlessly. With `scope: 'both'`, a single Lua script checks and decrements both buckets atomically — never two sequential acquisitions, which can partially succeed and leak tokens.

`unit: 'requests'` with `cost: 1` covers providers that meter requests rather than weighted quota.

---

## 9. Mock provider contract

`MockProvider` is what makes the entire product developable and CI-testable with zero credentials. Scenario is selectable per mock account:

| Scenario | Behaviour |
|---|---|
| `success` | Publishes, returns a remote ID and URL |
| `publish_failure` | `ContentRejected` with a realistic message |
| `token_expired` | `TokenExpired` on first call |
| `permission_revoked` | `PermissionRevoked` |
| `rate_limited` | 429 with a `Retry-After` header |
| `invalid_media` | `InvalidMedia` naming the specific constraint |
| `network_timeout` | Hangs past the client timeout |
| `accept_then_hang` | **Accepts, then hangs** — the fault-injection scenario for reconciliation |
| `partial_multi` | Succeeds on some variants, fails others |

It also serves comments, replies, messages and analytics series so the inbox and analytics phases have data.

**`MockProvider` must be corrected by every divergence report.** Its purpose is to be an artifact of evidence, not of imagination.

---

## 10. Divergence report — required gate artifact

Each anchor connector produces one before its phase closes. **An empty divergence report means the anchor was not exercised seriously.**

```markdown
# Divergence Report — <provider> (Phase <n>)
Verified against: <base URL>   Date: YYYY-MM-DD

## Assumption divergences
| # | MockProvider assumed | Real provider does | Resolution |
|---|---|---|---|
| 1 |  |  | changed mock / changed interface / changed pipeline |

## Capability marker changes
| Capability | Before | After | Source URL |
|---|---|---|---|

## Interface changes required
## Pipeline changes required
## Still unknown ([U] items remaining)
```

---

## 11. Adding a provider

1. `packages/providers/<name>/` with `capabilities.ts`, `limits.ts`, `media.ts`, `text.ts`, `adapter.ts`, `errors.ts`, `fixtures/`.
2. One line in the registry.
3. Pass the shared contract suite, including bidirectional capability agreement.
4. Declare a state: `implemented`, `skeleton`, or `mock`.

Nothing else in the system changes. If adding a provider requires touching the composer, the calendar, the publisher or the inbox, the abstraction has leaked and that is the bug to fix.


## `comments` vs `replies` — a distinction the mock hid

These were conflated until the Telegram anchor. They are now separate:

- **`comments`** — the inbox can **retrieve** comments on demand, given a post.
- **`replies`** — we can **respond** to something that has already been delivered.

A push-only provider has the second without the first. A Telegram bot cannot
enumerate replies to a message; they arrive as updates in the linked discussion
group or they are not observed at all. Under the old reading, every such provider
would have had to either claim a `fetchComments` it cannot implement or disclaim
comment support it genuinely has.

## `maxLengthWithMedia`

`TextProfile` carries an optional lower limit that applies when the post has
media attached. This is not exotic: Telegram allows 4096 characters in a message
and 1024 in a media caption, and a post with an image is the common case.

The validation error names **both** numbers when the caption limit is the binding
one, because a composer that says "1024" to someone who knows the platform's
headline figure looks broken rather than correct.

## Anchor connectors and their divergence reports

| Phase | Anchor | Report |
|---|---|---|
| 4 — publishing | Mastodon | `docs/divergence/mastodon.md` |
| 6 — inbox | Telegram | `docs/divergence/telegram.md` |
| 7 — analytics | Reddit `[A]` | pending |

Bluesky also shipped as a connector and passes the contract suite, but it is not
an anchor and has no divergence report. Recorded here rather than quietly
skipped.

### What the anchors changed

Between them, the two completed anchors changed the design in five places. Worth
listing, because each one was invisible against `MockProvider`:

- **Media upload can return before the media is usable** (Mastodon). The
  pipeline now polls for readiness. `PREPARING_MEDIA` had assumed only *our*
  transcoding was slow.
- **`comments` and `replies` are different capabilities** (Telegram). A push-only
  provider can respond to what it receives without being able to enumerate
  anything.
- **A text limit is not always a property of the provider** (both). Telegram's
  depends on whether media is attached; Mastodon's depends on which server you
  are talking to. Hence `maxLengthWithMedia` and `validateFor`.
- **An OAuth provider can be unable to build its own authorize URL** (Mastodon).
  Hence `connectFields`, which is not exclusive to credential-based providers.
- **A mock claiming a capability with no method behind it** (`MockProvider`
  declared `webhooks: true` and had no `verifyWebhook`). Caught by the
  bidirectional contract test the moment `webhooks` entered the method map.
