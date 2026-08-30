# PRD — Social Media Management Platform

## 1. What this is

A self-hostable, multi-tenant platform for planning, publishing, and measuring social media content across many networks from one place. Comparable in functional breadth to Buffer, Hootsuite, Sprout Social, Metricool, Publer, Postiz and Mixpost — an original product, not a clone of any of them.

**Two deployment shapes from one codebase:** a single-tenant self-hosted install (the default), and a multi-tenant SaaS. The architecture does not fork between them.

## 2. Explicit non-goals

| Not building | Why |
|---|---|
| **AI features of any kind** | Deliberately excluded. No generation, no copywriting, no agents, no model-derived "best time to post". Do not reintroduce them anywhere. |
| Payment processing | Entitlement and usage-limit abstraction only; no processor coupling. |
| Social listening / brand monitoring | A different product with a different data pipeline. |
| Competitor benchmarking | Largely unavailable through official APIs; needs its own feasibility pass before it is promised. |
| Ad campaign management | Separate API surfaces, separate permissions, separate product. |
| Reproducing any existing tool's UI, copy, or branding | Original product. |

## 3. Personas

| Persona | Needs | Typical role |
|---|---|---|
| **Solo creator** | Fast composing, a calendar, "does this fit on Bluesky?" | Owner of a one-person org |
| **Social manager (in-house)** | Multi-account scheduling, a calendar the team can see, reporting upward | Manager / Editor |
| **Agency operator** | Many clients kept strictly separate, client-facing approval, branded reports | Owner across many workspaces |
| **Client / stakeholder** | Review and approve drafts, see results, touch nothing else | Client / Approver |
| **Analyst** | Read-only access to metrics and exports | Analyst |
| **Self-hoster / operator** | One-command deploy, honest failure messages, no surprise external dependencies | System administrator |

## 4. Tenancy model

```
User >-- Membership --< Organization --< Workspace --< SocialAccount
                                             \--< Post --< PostVariant
```

- A **User** may belong to many organizations.
- An **Organization** is the billing / entitlement boundary.
- A **Workspace** is the content and isolation boundary — an agency's client, or a brand.
- A **SocialAccount** belongs to exactly one workspace. **Two workspaces may connect the same underlying social account**; uniqueness is `(workspaceId, provider, providerAccountId)`. This is the agency case, and it is normal rather than exceptional.

## 5. Roles and permissions

Nine roles. Authorization is evaluated **server-side only**. The frontend never decides what a user may do; it only decides what to render.

| Role | Compose | Publish | Approve | Connect accounts | Members | Billing | Analytics |
|---|---|---|---|---|---|---|---|
| Owner | yes | yes | yes | yes | yes | yes | yes |
| Admin | yes | yes | yes | yes | yes | — | yes |
| Manager | yes | yes | yes | yes | — | — | yes |
| Editor | yes | yes | — | — | — | — | yes |
| Author | yes | — | — | — | — | — | own posts |
| Approver | — | — | yes | — | — | — | yes |
| Analyst | — | — | — | — | — | — | yes |
| Client | — | — | yes | — | — | — | scoped |
| Viewer | — | — | — | — | — | — | yes |

Granular permissions behind these roles: `workspace.manage`, `members.manage`, `billing.manage`, `accounts.connect`, `content.create`, `content.edit`, `content.delete`, `content.publish`, `content.approve`, `analytics.view`, `reports.export`, `integrations.manage`, `apikeys.manage`, `settings.manage`.

## 6. Modules

### 6.1 Authentication and accounts

Email + password (argon2id), email verification, password reset, session management with device listing and revocation, login history, security events, rate limiting. 2FA and external OAuth SSO are architecture-ready, not shipped in v1.

Registration is operator-configurable: `open` (SaaS default), `invite` (self-hosted default), `closed`. The **first account on an empty database becomes organization owner regardless of mode**, after which that path closes permanently — otherwise `invite` makes a fresh install unusable, since nobody exists to send the invite.

### 6.2 Social accounts

Connect flow: select provider, OAuth, select accounts/pages, confirm permissions, connect, store encrypted credentials, sync metadata, show status.

A provider the operator has not configured appears **disabled with the reason stated**, never hidden and never faked. Connection states: `ACTIVE`, `NEEDS_REAUTH`, `DISCONNECTED`, `DISABLED`.

### 6.3 Composer

Write once, target many. Global content plus independent per-channel overrides, stored as one `PostVariant` row per target.

Live per-channel validation while typing — character limits, media counts, aspect ratios, duration bounds, hashtag caps — using the *same* validation code the server runs. Emoji picker, hashtags, mentions, links, alt text, first comment, threads, carousels, thumbnails, labels, campaign assignment, UTM parameters, per-channel preview.

Actions: save draft, submit for approval, schedule, add to queue, publish now, duplicate, save as template.

**Cost disclosure.** Where a provider charges per post, the composer shows an estimated cost before scheduling. X is currently the only such provider, and it prices link-bearing posts more than 13x higher than plain text, so the estimate is itemised per channel rather than aggregated.

### 6.4 Media

Drag-and-drop upload, multi-upload, image/video/GIF preview, MIME and size and dimension and duration validation, thumbnail generation, metadata extraction, folders, tags, search, filter, sort, favourites, archive, delete, restore, reuse, storage quotas.

Transcoding produces **per-provider-per-surface renditions**. Instagram feed images and Instagram Reels have incompatible requirements and are separate targets; a single per-provider profile would be wrong for one of them.

### 6.5 Calendar

Month, week, day and list views. Drag-and-drop rescheduling, filters (platform, account, campaign, label, status, author, assignee), search, preview, duplicate, cancel, bulk operations, timezone-aware display.

### 6.6 Scheduling and queues

Publish now, schedule once, add to queue, recurring rules (daily / weekly / monthly / custom / selected weekdays), evergreen content, per-account posting schedules, queue slots, pause and resume, reorder, shuffle, next available slot, skip, bulk scheduling.

**Missed posts are never silently dumped.** A post overdue beyond the catch-up window becomes `MISSED` and waits for a human decision — publish now, or reschedule. Publishing four hours of backdated content in one burst is worse than publishing none of it.

### 6.7 Approvals and collaboration

`DRAFT -> PENDING_APPROVAL -> APPROVED -> SCHEDULED`. Sequential and parallel approvers, required approval per workspace or per role, rejection with reason, internal comments with mentions, assignees, approval history, full audit trail.

### 6.8 Unified inbox

Comments, replies, mentions, direct messages and conversations, where the provider supports them. Filters: all, unread, assigned to me, assigned to a teammate, archived. Conversation view, reply, internal note, assign, reassign, mark read/unread, archive, labels, priority, saved responses.

**Capability-aware.** A provider without DMs shows no DM affordance, because the UI is generated from the capability matrix rather than from a hand-maintained list. Unsupported features cannot become dead buttons.

### 6.9 Analytics

Post-level, account-level and audience metrics, ingested by background jobs — never fetched live on page load. Normalized common metrics across providers, plus raw provider payloads retained 90 days.

**A metric a provider does not report renders as "—", never as zero.** This distinction is a product requirement, not an implementation detail: "0 impressions" on a platform that never reports impressions is actively misleading.

### 6.10 Campaigns, labels, templates, links

Campaigns with date ranges and rollup analytics. Labels on any entity. Reusable templates with `{{date}}`, `{{month}}`, `{{year}}`, `{{brand}}`, `{{campaign}}` variables. UTM builder with presets applied automatically at publish time.

### 6.11 Link-in-bio

Public customizable pages at `/l/:slug` — avatar, bio, links, buttons, themes, background, typography, ordering, publish/unpublish. Analytics: views, clicks, CTR, top links.

### 6.12 Reports

Workspace overview, account, platform, campaign, content, team activity, and custom reports. Date ranges and comparison periods, metric selection, charts and tables, branding and logo, PDF and CSV export, saved and duplicated reports, scheduled-report architecture.

### 6.13 Notifications and audit

In-app notifications for approval requests and decisions, publish success and failure, account disconnection, token expiry, invitations, webhook failures, report readiness, system alerts. Notification centre with unread counts, filtering, deep links.

Audit log covering every consequential action, with actor, organization, workspace, action, entity type and ID, timestamp, IP where appropriate, and metadata. **Admin actions are audited too** — admin does not bypass the log.

### 6.14 Public API, webhooks, integrations

Versioned REST at `/api/v1` with generated OpenAPI, scoped API keys, outbound webhooks with HMAC signatures and retries and delivery logs and replay, RSS-driven automation, and adapter architecture for n8n / Zapier-style / Make-style / Drive / Dropbox / S3 / Slack integrations.

### 6.15 Administration

Operator console: organizations, users, workspaces, connected providers, queue depth, failed jobs, **rate-budget headroom**, **unrouted inbound events**, provider health, storage usage, system health, feature flags.

### 6.16 Demo mode

A fully functional instance backed by mock providers: 1 organization, 3 workspaces, 8 members, 20 accounts, 100 posts, 30 scheduled, 20 campaigns, 100 media assets, 50 conversations, a year of analytics, plus templates, labels, notifications and audit entries. Mock providers reproduce success, failure, rate limiting, expired tokens, invalid media and partial failure. **No external calls, ever.**

## 7. Provider coverage

23 providers behind one adapter interface. Every provider is in exactly one honestly-declared state — `implemented`, `skeleton` (interface and documented endpoints present, disabled in the UI), or `mock`.

Facebook Pages, Instagram, Threads, X, LinkedIn Profiles, LinkedIn Company Pages, TikTok, YouTube, Pinterest, Reddit, Telegram, WhatsApp Business, Google Business Profile, Snapchat, Mastodon, Bluesky, Discord, Slack, Tumblr, Medium, WordPress, Blogger, VK, WeChat.

**Nothing unsupported is ever faked.** See `PROVIDERS.md` for the capability matrix and per-provider confidence markers.

## 8. Quality bar

- No fake buttons; no pages whose functionality does not work.
- No unfinished functionality hidden behind polished UI.
- No hard-coded data outside demo mode.
- Errors are legible: *"LinkedIn rejected this media because the video format is unsupported"*, never *"API Error 400"*.
- Multi-platform publishing states exactly which channels succeeded and which failed.
- Every important feature has real backend logic, persistence, validation, error handling and tests.

## 9. v1 versus later

| v1 | Later |
|---|---|
| Auth, orgs, workspaces, roles | 2FA, SSO |
| Composer, variants, media, transcoding | Advanced media editing |
| Calendar, queues, recurrence, bulk import | — |
| Publishing engine with partial success | — |
| Approvals, comments, audit log | — |
| Inbox for providers that support it | Listening, sentiment |
| Analytics, reports, exports | Benchmarking |
| Campaigns, labels, templates, UTM | — |
| Link-in-bio | — |
| Public API, API keys, webhooks, RSS | Full integration catalogue |
| Admin console, entitlements | Billing processor |
| 3 real connectors, 20 mock/skeleton | Remaining connectors as approvals land |
