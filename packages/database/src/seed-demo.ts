import { hash } from '@node-rs/argon2'
import { createTestClient, withOrganization, withSystemScope, withTenant, type Db } from './client.js'
import { encrypt, keyIdOf, keyProvider } from './encryption.js'

/**
 * Demo mode seed.
 *
 * NO EXTERNAL CALLS, EVER. Every account is a MockProvider account, so a
 * demo instance is fully explorable without a single developer app, and CI can
 * exercise the whole product with no credentials.
 *
 * Seeds only what the schema actually holds today. Posts, media, campaigns,
 * conversations and a year of analytics arrive with Phases 3–7 and are added
 * here as each lands — seeding rows for models that do not exist yet is not
 * possible, and pretending otherwise in the docs would be the same fake
 * completeness the quality bar rules out.
 */

const MOCK_HANDLES = [
  'northwind', 'aurora-labs', 'tidepool', 'brightline', 'kestrel',
  'lantern', 'meridian', 'oakfield', 'porthaven', 'quillfeather',
] as const

/**
 * Most accounts succeed; a few fail in the ways that matter. `publish_failure`
 * and `rate_limited` are what make PARTIALLY_PUBLISHED visible in a fresh demo.
 */
const SCENARIOS = [
  'success',
  'success',
  'success',
  'success',
  'publish_failure',
  'success',
  'rate_limited',
  'success',
  'success',
  'success',
] as const

const ROLES = ['OWNER', 'ADMIN', 'MANAGER', 'EDITOR', 'AUTHOR', 'APPROVER', 'ANALYST', 'CLIENT'] as const

export type SeedResult = {
  organizationId: string
  workspaceIds: string[]
  userIds: string[]
  accountIds: string[]
  postCount: number
  conversationCount: number
  /** Sign-in details, printed so a demo instance is usable immediately. */
  credentials: { email: string; password: string }
}

const DEMO_PASSWORD = 'demo1234'
const DEMO_ORG_SLUG = 'demo-agency'

/**
 * Fixed, memorable addresses — NOT timestamped.
 *
 * An earlier version suffixed every email with Date.now() to avoid colliding
 * with a previous run on the unique constraint. It worked, and it produced a
 * demo login nobody could type from memory. Re-running now CLEARS the previous
 * demo organization instead, which is what "idempotent seed" should have meant
 * in the first place.
 */
const DEMO_EMAILS = [
  'owner@demo.local',
  'grace@demo.local',
  'alan@demo.local',
  'katherine@demo.local',
  'barbara@demo.local',
  'margaret@demo.local',
  'jean@demo.local',
  'radia@demo.local',
] as const

export async function seedDemo(client: Db, now = new Date()): Promise<SeedResult> {
  const keys = keyProvider()
  const passwordHash = await hash(DEMO_PASSWORD)
  const stamp = now.getTime()

  // Idempotent: wipe any previous demo run first. Cascades take the workspaces,
  // memberships, accounts and credentials with it.
  await withSystemScope('demo seed resets previous demo data', async () => {
    await client.organization.deleteMany({ where: { slug: DEMO_ORG_SLUG } })
    await client.user.deleteMany({ where: { email: { in: [...DEMO_EMAILS] } } })
  })

  const { organizationId, userIds } = await withSystemScope(
    'demo seed creates organizations and users before any tenant exists',
    async () => {
      const org = await client.organization.create({
        data: { name: 'Demo Agency', slug: DEMO_ORG_SLUG },
        select: { id: true },
      })

      const users = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          client.user.create({
            data: {
              email: DEMO_EMAILS[i]!,
              passwordHash,
              name: ['Ada', 'Grace', 'Alan', 'Katherine', 'Barbara', 'Margaret', 'Jean', 'Radia'][i]!,
              timezone: ['UTC', 'Europe/Berlin', 'America/New_York'][i % 3]!,
            },
            select: { id: true },
          })
        )
      )

      return { organizationId: org.id, userIds: users.map((u) => u.id) }
    }
  )

  // Three workspaces: the agency shape the tenancy model exists to support.
  const workspaceIds = await withOrganization(
    organizationId,
    async (tx) => {
      const created: string[] = []

      for (const [index, name] of ['House Brand', 'Client: Tidepool', 'Client: Kestrel'].entries()) {
        const ws = await tx.workspace.create({
           
          data: {
            name,
            slug: `ws-${index}-${stamp}`,
            timezone: ['UTC', 'Europe/Berlin', 'America/New_York'][index]!,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } as any,
          select: { id: true },
        })
        created.push(ws.id)

        // Every user in the first workspace; a narrower set in the client ones,
        // so the demo actually shows different people seeing different things
        // rather than everyone seeing everything.
        const members = index === 0 ? userIds : userIds.slice(0, 4)
        for (const [i, userId] of members.entries()) {
          await tx.membership.create({
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            data: { userId, workspaceId: ws.id, role: ROLES[i % ROLES.length] } as any,
          })
        }
      }

      // The organization-wide membership that makes the first user an owner.
      await tx.membership.create({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        data: { userId: userIds[0]!, workspaceId: null, role: 'OWNER' } as any,
      })

      return created
    }
  )

  // Twenty connected accounts, all mock. Spread unevenly so the UI is exercised
  // with a workspace that has many and one that has few.
  const accountIds: string[] = []
  const distribution = [10, 6, 4]

  for (const [index, workspaceId] of workspaceIds.entries()) {
    await withTenant(workspaceId, async (tx) => {
      for (let i = 0; i < distribution[index]!; i++) {
        const handle = MOCK_HANDLES[(index * 7 + i) % MOCK_HANDLES.length]!
        const providerAccountId = `mock-${index}-${i}-${stamp}`

        const account = await tx.socialAccount.create({
           
          data: {
            provider: 'mock',
            providerAccountId,
            handle: `@${handle}`,
            displayName: handle.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
            surfaces: ['feed', 'feedImage'],
            // A spread of behaviours, so the demo shows partial publishing and
            // the error taxonomy rather than only the happy path. Reading these
            // out of platformMeta is how the simulator learns which to use.
            platformMeta: { mockScenario: SCENARIOS[i % SCENARIOS.length] },
            // A few accounts start in NEEDS_REAUTH so the demo shows the state
            // an operator most needs to recognise, rather than only the happy path.
            status: i === 3 ? 'NEEDS_REAUTH' : 'ACTIVE',
            statusReason: i === 3 ? 'The connection expired. Reconnect to keep publishing.' : null,
            lastSyncedAt: now,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } as any,
          select: { id: true },
        })
        accountIds.push(account.id)

        // Encrypted even in demo mode. A seed that stored plaintext would be a
        // template people copy, and it would make the encryption path untested
        // in exactly the environment most people run first.
        const sealed = encrypt(`mock-token-${providerAccountId}`, keys)
        await tx.oAuthCredential.create({
           
          data: {
            socialAccountId: account.id,
            accessToken: sealed,
            scopes: ['read', 'write'],
            keyId: keyIdOf(sealed) ?? 'unknown',
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } as any,
        })
      }

      await tx.auditLog.create({
         
        data: {
          actorId: userIds[0]!,
          action: 'demo.seeded',
          entityType: 'Workspace',
          entityId: workspaceId,
          metadata: { accounts: distribution[index] },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
      })
    })
  }

  // Content with history, so a fresh demo shows a populated calendar and real
  // analytics rather than three empty states. Dates are spread across the past
  // and future because "what does this look like in use?" is the question a demo
  // exists to answer.
  const postCount = await seedContent(client, workspaceIds[0]!, userIds[0]!, now)
  const conversationCount = await seedInbox(client, workspaceIds[0]!, now)

  return {
    organizationId,
    workspaceIds,
    userIds,
    accountIds,
    postCount,
    conversationCount,
    credentials: { email: DEMO_EMAILS[0], password: DEMO_PASSWORD },
  }
}

/** CLI entry: `pnpm --filter @smm/database seed`. */
export async function main(): Promise<void> {
  const url = process.env['DATABASE_URL']
  if (!url) throw new Error('DATABASE_URL is required to seed.')

  const client = createTestClient(url)
  try {
    const result = await seedDemo(client)
     
    console.log(
      [
        '',
        'Demo data seeded.',
        `  organization : ${result.organizationId}`,
        `  workspaces   : ${result.workspaceIds.length}`,
        `  members      : ${result.userIds.length}`,
        `  accounts     : ${result.accountIds.length} (all mock — no external calls)`,
        `  posts        : ${result.postCount} (published history + scheduled future)`,
        `  conversations: ${result.conversationCount} (comments, DMs and a mention)`,
        '',
        `  sign in as   : ${result.credentials.email}`,
        `  password     : ${result.credentials.password}`,
        '',
      ].join('\n')
    )
  } finally {
    await client.$disconnect()
  }
}


const SAMPLE_POSTS = [
  'Shipping a big update to the scheduler today — queue slots, recurring rules, the lot.',
  'Three things we learned running our own infrastructure for a year.',
  'New guide: connecting your first channel in under two minutes.',
  'We are hiring a platform engineer. Remote, EU timezones.',
  'Behind the scenes on how we handle partial publishing failures.',
  'Quick tip: schedule in the timezone your audience is in, not yours.',
  'Roadmap update — what is landing next month.',
  'Our approach to rate limits, and why we budget rather than react.',
] as const

/**
 * Published history plus scheduled future.
 *
 * Metrics are attached to the published ones so the analytics page has
 * something real to render. Note some rows leave `impressions` null: that is
 * deliberate, and it exercises the "—" path for networks that do not report a
 * metric — the case a demo full of tidy numbers would hide.
 */
async function seedContent(
  client: Db,
  workspaceId: string,
  authorId: string,
  now: Date
): Promise<number> {
  return withTenant(workspaceId, async (tx) => {
    const accounts = await tx.socialAccount.findMany({
      where: { status: 'ACTIVE' },
      select: { id: true },
      take: 3,
    })
    if (accounts.length === 0) return 0

    let created = 0

    for (const [index, content] of SAMPLE_POSTS.entries()) {
      // Roughly half in the past (published), half ahead (scheduled).
      const isPast = index < 5
      const offsetDays = isPast ? -(index * 3 + 1) : (index - 4) * 2
      const at = new Date(now.getTime() + offsetDays * 86_400_000)

      const post = await tx.post.create({
         
        data: {
          authorId,
          baseContent: content,
          scheduledAt: at,
          publishedAt: isPast ? at : null,
          status: isPast ? 'PUBLISHED' : 'SCHEDULED',
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
        select: { id: true },
      })
      created++

      const targets = accounts.slice(0, (index % accounts.length) + 1)
      for (const account of targets) {
        const variant = await tx.postVariant.create({
           
          data: {
            postId: post.id,
            socialAccountId: account.id,
            surface: 'feed',
            status: isPast ? 'PUBLISHED' : 'SCHEDULED',
            remoteId: isPast ? `demo-remote-${post.id.slice(0, 8)}-${account.id.slice(0, 4)}` : null,
            publishedAt: isPast ? at : null,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } as any,
          select: { id: true },
        })

        if (!isPast) continue

        const reach = 400 + index * 260
        const likes = 12 + index * 9
        const comments = 1 + index
        const reportsImpressions = index % 3 !== 0

        await tx.postMetric.create({
           
          data: {
            postVariantId: variant.id,
            capturedAt: new Date(at.getTime() + 3_600_000),
            reach,
            // Null on purpose for some rows — see the note above.
            impressions: reportsImpressions ? Math.round(reach * 1.4) : null,
            likes,
            comments,
            shares: Math.round(likes / 4),
            saves: null,
            clicks: Math.round(reach * 0.03),
            engagementRate: Number((((likes + comments) / reach) * 100).toFixed(2)),
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } as any,
        })
      }
    }

    return created
  })
}

/**
 * Sample conversations.
 *
 * Written to look like a real inbox rather than a demo: an unanswered question,
 * a complaint, a thread already replied to, and one that arrived out of order.
 * A seed where every conversation looks the same hides exactly the cases the
 * inbox exists to handle.
 */
const SAMPLE_THREADS = [
  {
    kind: 'COMMENT_THREAD' as const,
    handle: '@rosalind_f',
    messages: [
      { body: 'Does this ship outside the EU?', minutesAgo: 40, direction: 'IN' },
    ],
  },
  {
    kind: 'DM' as const,
    handle: '@tim_b',
    messages: [
      { body: 'Order 4417 arrived damaged. Photos attached.', minutesAgo: 180, direction: 'IN' },
      { body: 'Sorry about that — sending a replacement today.', minutesAgo: 150, direction: 'OUT' },
      { body: 'Appreciated, thank you.', minutesAgo: 140, direction: 'IN' },
    ],
  },
  {
    kind: 'COMMENT_THREAD' as const,
    handle: '@ada_l',
    messages: [
      // Deliberately out of order in the array: the LATER message is listed
      // first, and the thread must still render chronologically because
      // ordering comes from providerCreatedAt rather than insertion order.
      { body: 'Never mind, found it in the FAQ.', minutesAgo: 300, direction: 'IN' },
      { body: 'Where do I find the sizing chart?', minutesAgo: 320, direction: 'IN' },
    ],
  },
  {
    kind: 'MENTION' as const,
    handle: '@katherine_j',
    messages: [
      { body: 'Been using these for a month now. Genuinely good.', minutesAgo: 1440, direction: 'IN' },
    ],
  },
  {
    kind: 'DM' as const,
    handle: '@grace_h',
    messages: [{ body: 'Any plans for a wholesale tier?', minutesAgo: 2880, direction: 'IN' }],
  },
]

async function seedInbox(client: Db, workspaceId: string, now: Date): Promise<number> {
  return withTenant(workspaceId, async (tx) => {
    const accounts = await tx.socialAccount.findMany({
      where: { status: 'ACTIVE' },
      select: { id: true },
      take: 2,
    })
    if (accounts.length === 0) return 0

    let created = 0

    for (const [index, thread] of SAMPLE_THREADS.entries()) {
      const account = accounts[index % accounts.length]!
      const latest = Math.min(...thread.messages.map((m) => m.minutesAgo))
      const unread = thread.messages.filter((m) => m.direction === 'IN').length

      const conversation = await tx.conversation.create({
         
        data: {
          socialAccountId: account.id,
          providerConversationId: `demo-conv-${index}`,
          kind: thread.kind,
          subjectHandle: thread.handle,
          lastMessageAt: new Date(now.getTime() - latest * 60_000),
          // The thread that was already answered reads as handled.
          unreadCount: thread.messages.some((m) => m.direction === 'OUT') ? 0 : unread,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
        select: { id: true },
      })
      created++

      for (const [messageIndex, message] of thread.messages.entries()) {
        await tx.message.create({
           
          data: {
            conversationId: conversation.id,
            providerMessageId: `demo-msg-${index}-${messageIndex}`,
            direction: message.direction,
            authorHandle: message.direction === 'OUT' ? 'you' : thread.handle,
            body: message.body,
            providerCreatedAt: new Date(now.getTime() - message.minutesAgo * 60_000),
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } as any,
        })
      }
    }

    return created
  })
}
