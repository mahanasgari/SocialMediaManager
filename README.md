# SMM

A self-hostable, multi-tenant social media management platform — plan, publish and measure content across many networks from one dashboard.

**Status: Phases 0–6 built, plus parts of 9 and 10.** See
[`STATUS.md`](./STATUS.md) for exactly what works, what is a documented skeleton,
and what has not been started. That file is kept honest deliberately: a README
that overstates what runs is worse than no README, because it costs someone an
afternoon to find out.

---

## Documents

| Document | What it covers |
|---|---|
| [`PRD.md`](./PRD.md) | Scope, personas, modules, non-goals |
| [`ARCHITECTURE.md`](./ARCHITECTURE.md) | Topology, packages, invariants, publishing pipeline |
| [`DATABASE.md`](./DATABASE.md) | Entities, tenancy and indexing rules, status enums |
| [`PROVIDERS.md`](./PROVIDERS.md) | Adapter interface, capability matrix, per-provider confidence |
| [`API.md`](./API.md) | `/api/v1` resources, auth modes, webhook catalogue |
| [`SECURITY.md`](./SECURITY.md) | Threat model, controls, required isolation tests |
| [`TASKS.md`](./TASKS.md) | Phase-by-phase execution plan with acceptance criteria |
| [`DEPLOYMENT.md`](./DEPLOYMENT.md) | Self-hosting: secrets, TLS, media reachability, upgrades, operating it |
| [`STATUS.md`](./STATUS.md) | What actually works, what is a documented skeleton, what is not started |

---

## Quick start

```bash
cp .env.example .env

# Required. The app refuses to boot without these.
openssl rand -base64 32   # -> ENCRYPTION_KEY
openssl rand -base64 32   # -> SESSION_SECRET
openssl rand -base64 24   # -> APP_DB_PASSWORD, and the password inside DATABASE_URL
# also set S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY to anything for local MinIO

docker compose up
```

**Note the two database URLs.** `MIGRATE_DATABASE_URL` uses the owner and is read only by the one-shot migrate service; `DATABASE_URL` uses an unprivileged role that the app connects as. This is not tidiness — superusers bypass row-level security unconditionally, so connecting as the owner would make every tenant-isolation policy silently inert. The API refuses to boot if it detects it can bypass RLS.

Then open `http://localhost:3000`. **The first account you create becomes the organization owner**, regardless of `AUTH_REGISTRATION` — after which that path closes permanently.

No provider credentials are needed to start. Providers you have not configured appear disabled with the reason shown.

---

## Things worth knowing before you deploy

These are properties of the platforms, not of this software. None of them can be coded around.

**Connecting a network means getting that company to approve your app.** You register your own developer app per platform and put the credentials in `.env`. Mastodon, Telegram, Bluesky, Discord and Slack need no approval. LinkedIn personal profiles and Reddit are self-service. Meta (Facebook/Instagram/Threads), TikTok, YouTube, Pinterest and LinkedIn company pages all require platform review, which takes weeks to months.

**X charges per post.** Since February 2026 the free tier is closed to new developers. Posting costs roughly $0.015 per post — and **$0.20 per post containing a URL**. The composer shows an estimate before you schedule, and workspaces can set a spend cap. ([docs.x.com](https://docs.x.com/x-api/getting-started/pricing), retrieved 2026-08-29)

**TikTok posts are private until your app is audited.** Unaudited apps can call the Content Posting API, but everything they publish is forced to self-only visibility. Real people cannot see it.

**Pinterest Trial access creates sandbox pins** visible only to their creator. Standard access is free but requires a review.

**Instagram fetches your media rather than accepting an upload**, so it needs a publicly reachable HTTPS URL. Set `MEDIA_PUBLIC_MODE`:

| Mode | Use when |
|---|---|
| `presigned-s3` | Your object storage is itself internet-reachable |
| `relay` | Only the app is public — files stream through `/api/v1/media/relay/:token` |
| `disabled` | Nothing is public. Instagram is marked unavailable at boot, with the reason |

**Inbound webhooks need public ingress.** If you have none, set `INBOUND_MODE=poll` — polling and webhooks converge on the same write path, so nothing is lost, only delayed.

**Running over plain HTTP on a LAN?** Secure cookies need TLS. On a non-`localhost` `http://` URL the app refuses to boot unless you set `ALLOW_INSECURE_COOKIES=true`, and then warns on every start. This is deliberate: a security property that disappears silently is worse than one you had to opt out of.

---

## Deployment shapes

**Three services** (default): `web`, `api`, `worker`. The worker runs separately so a multi-minute video upload never occupies a request handler, and so it can scale independently.

**One container**: the `all-in-one` image target supervises all three. Costs roughly 150–250 MB additional RSS and gives up independent worker scaling. Use it when operational simplicity matters more than either.

---

## Development

```bash
pnpm install
pnpm db:migrate
pnpm dev

pnpm verify   # typecheck + lint + test
```

**You do not need real social credentials to develop.** `MockProvider` simulates success, publish failure, token expiry, permission revocation, rate limiting, invalid media, network timeout, partial multi-platform failure, and the accept-then-hang case used to test reconciliation. Demo mode seeds a full instance with no external calls.

### Gates enforced in CI

1. No tenant-scoped model without an isolation test.
2. No outbound provider call without a declared rate budget.
3. No `[V]` evidence marker without a source URL and retrieval date. <!-- evidence-gate:ignore -->

The third exists because social API surfaces change constantly, and an uncited claim is an assumption wearing a badge.

---

## Non-goals

**No AI features** — no generation, no copywriting, no agents, no model-derived posting-time advice. This is deliberate and permanent.

Also out of scope: payment processing (entitlement architecture only), social listening, competitor benchmarking, and ad campaign management.

---

## License

To be selected before first public release.
