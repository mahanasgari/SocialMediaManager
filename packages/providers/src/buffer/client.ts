import { assertOutsideTransaction } from '@smm/config'
import { ProviderError } from '../errors.js'
import type { ProviderId } from '../capabilities/index.js'

/**
 * Buffer's GraphQL API — the shared transport for every Buffer-routed connector.
 *
 * This is a ROUTE, not a network. Nobody has a "Buffer audience": posting here
 * reaches Instagram or Facebook exactly as posting directly does, with Buffer
 * standing in the middle holding the OAuth grant we would otherwise hold
 * ourselves.
 *
 * EVERY OPERATION HERE WAS CHECKED AGAINST THE LIVE SCHEMA by introspection on
 * 2026-09-10. The first version — written from the published documentation and
 * passing forty unit tests against a stubbed transport — got five things wrong,
 * and each one failed every call it appeared in:
 *
 *   - `channels` and `posts` both REQUIRE an `organizationId`. The documented
 *     examples show neither, so nothing worked until we first asked which
 *     organization the key belongs to.
 *   - `createPost` requires `needsApproval`, mentioned in no example.
 *   - `assets` is `[AssetInput!]!` — non-null. A text-only post must send an
 *     empty list rather than omit the field.
 *   - the result union is `PostActionPayload` with SIX error members, not the
 *     `MutationError` the examples show. A fragment on a type outside the union
 *     is a validation error, so the mutation failed before Buffer ever looked
 *     at the post.
 *   - `PostMetric` is keyed by `name`, not `key`, and selecting a field that
 *     does not exist fails the whole query.
 *
 * The lesson worth keeping: a stubbed transport tests that OUR code does what
 * we expect. It cannot test whether our expectation matches the provider, and
 * forty green tests said nothing about five broken calls.
 *
 * Two facts still shape the file:
 *
 *   1. THE API KEY IS ACCOUNT-WIDE AND IS THE WHOLE CREDENTIAL. Buffer's
 *      third-party OAuth is documented but closed to new clients.
 *      [V] https://developers.buffer.com/guides/authentication retrieved 2026-09-07
 *
 *   2. ERRORS ARRIVE AS DATA. GraphQL answers 200 with an `errors` array, and
 *      createPost returns its failures as union members. A transport checking
 *      only `response.ok` would report every rejected post as a success.
 */

const ENDPOINT = 'https://api.buffer.com'

/** A channel as Buffer describes it. `service` is the network behind the route. */
export type BufferChannel = {
  id: string
  name: string
  service: string
  displayName?: string | null
  avatar?: string | null
}

type GraphQLError = { message?: string; extensions?: { code?: string }; path?: unknown[] }
type GraphQLResponse<T> = { data?: T | null; errors?: GraphQLError[] }

/**
 * Runs one GraphQL operation.
 *
 * `required` names the top-level field the caller cannot proceed without. It
 * exists because Buffer answers a partially-forbidden query with BOTH data and
 * errors — a real key returns the account fine while refusing one sub-field —
 * and throwing on any error at all would discard a usable response over a field
 * we could live without.
 */
async function request<T>(
  provider: ProviderId,
  apiKey: string,
  operation: string,
  query: string,
  variables: Record<string, unknown>,
  required: keyof T & string
): Promise<T> {
  assertOutsideTransaction(`buffer.${operation}`)

  let response: Response
  try {
    response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(30_000),
    })
  } catch (cause) {
    throw new ProviderError(
      provider,
      'ProviderDown',
      'Buffer could not be reached. This is usually temporary; the post stays queued and will be tried again.',
      { raw: cause }
    )
  }

  if (response.status === 401 || response.status === 403) {
    throw new ProviderError(
      provider,
      'PermissionRevoked',
      'Buffer rejected the API key. Generate a new one under Settings → API in Buffer and reconnect the channel.',
      { httpStatus: response.status }
    )
  }

  if (response.status === 429) {
    const retryAfter = Number(response.headers.get('retry-after'))
    throw new ProviderError(provider, 'RateLimited', 'Buffer is rate limiting this account.', {
      httpStatus: 429,
      ...(Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfterSeconds: retryAfter } : {}),
    })
  }

  if (response.status >= 500) {
    throw new ProviderError(provider, 'ProviderDown', 'Buffer returned a server error.', {
      httpStatus: response.status,
    })
  }

  const body = (await response.json().catch(() => ({}))) as GraphQLResponse<T>
  const value = body.data?.[required]

  // Only a MISSING answer is a failure. An error beside a usable answer is
  // Buffer declining one field, which is not a reason to fail the operation.
  if (value === undefined || value === null) {
    const first = body.errors?.[0]
    throw new ProviderError(provider, codeFor(first?.extensions?.code), messageOf(first?.message), {
      httpStatus: response.status,
      raw: body.errors,
    })
  }

  return body.data as T
}

/**
 * Maps a GraphQL error code onto the shared taxonomy.
 *
 * The retry policy reads the taxonomy and never the provider, so an
 * unrecognised code must land somewhere deliberate. It lands on
 * PermanentFailure: retrying something we do not understand is how a scheduler
 * spends an hour re-sending a post the network was never going to accept.
 */
function codeFor(code: string | undefined) {
  switch (code) {
    case 'UNAUTHENTICATED':
    case 'FORBIDDEN':
      return 'PermissionRevoked' as const
    case 'RATE_LIMITED':
      return 'RateLimited' as const
    case 'INTERNAL_SERVER_ERROR':
      return 'ProviderDown' as const
    default:
      return 'PermanentFailure' as const
  }
}

/** Buffer's messages are written for people, so they are kept when present. */
function messageOf(message: string | undefined): string {
  return message?.trim()
    ? message.trim()
    : 'Buffer refused the request without saying why. Check the channel is still connected in Buffer.'
}

/**
 * The organization every other call has to name.
 *
 * Cached per key for the process lifetime. An account's organization does not
 * change, and without the cache every channel list and every reconciliation
 * read would cost two round trips instead of one.
 */
const organizations = new Map<string, string>()

export async function organizationId(provider: ProviderId, apiKey: string): Promise<string> {
  const cached = organizations.get(apiKey)
  if (cached) return cached

  const data = await request<{ account: { organizations?: Array<{ id: string }> | null } }>(
    provider,
    apiKey,
    'account',
    `query Account { account { id organizations { id name } } }`,
    {},
    'account'
  )

  const id = data.account.organizations?.[0]?.id
  if (!id) {
    throw new ProviderError(
      provider,
      'PermanentFailure',
      'That Buffer account has no organization, so it has no channels to post to. Finish setting the account up in Buffer first.'
    )
  }

  organizations.set(apiKey, id)
  return id
}

/** Clears the cached organization. For tests, so one does not leak into the next. */
export function resetOrganizationCache(): void {
  organizations.clear()
}

/** Every channel the key can reach. */
export async function listChannels(
  provider: ProviderId,
  apiKey: string
): Promise<BufferChannel[]> {
  const org = await organizationId(provider, apiKey)
  const data = await request<{ channels: BufferChannel[] }>(
    provider,
    apiKey,
    'channels',
    `query Channels($input: ChannelsInput!) {
       channels(input: $input) { id name service displayName avatar }
     }`,
    { input: { organizationId: org } },
    'channels'
  )
  return data.channels
}

export type BufferPostInput = {
  channelId: string
  text: string
  /** Non-null in the schema: a text-only post sends [], never omits the field. */
  assets: ReadonlyArray<{ image: { url: string } } | { video: { url: string } }>
  /**
   * Absent means publish NOW, which is what the scheduler wants. Present hands
   * the timing to Buffer for that instant instead. ISO 8601.
   */
  dueAt?: string
}

/**
 * [V] draft | error | needs_approval | scheduled | sending | sent
 *     schema introspection of https://api.buffer.com retrieved 2026-09-10
 */
export type BufferPostStatus =
  | 'draft'
  | 'error'
  | 'needs_approval'
  | 'scheduled'
  | 'sending'
  | 'sent'

export type BufferPost = {
  id: string
  status?: BufferPostStatus | null
  text?: string | null
  createdAt?: string | null
  sentAt?: string | null
  /** The post's URL on the network itself, once Buffer has sent it. */
  externalLink?: string | null
  /** An object, not a string. Selecting it bare is a validation error. */
  error?: { message?: string | null } | null
  /** Selected so reconciliation can count media rather than assume none. */
  assets?: Array<{ id?: string | null }> | null
  /** Keyed by `name`, not `key`. Selecting `key` fails the whole query. */
  metrics?: Array<{ name?: string | null; value?: number | null }> | null
}

/**
 * [V] `error` is a PostPublishingError object, not a string
 *     schema introspection of https://api.buffer.com retrieved 2026-09-10
 */
const POST_FIELDS = `id status text createdAt sentAt externalLink error { message } assets { id }`

type PostActionPayload =
  | { __typename: 'PostActionSuccess'; post: BufferPost }
  | { __typename: string; message?: string; code?: string | number }

/**
 * Creates one post on one channel.
 *
 * `mode` decides WHO owns the timing, and the answer must be us. By the time
 * this runs the scheduler has already waited — the worker claims variants whose
 * `scheduledAt` has passed — so publish means "send this now". `addToQueue`
 * would hand that straight back to Buffer's own posting schedule, and a post
 * scheduled for 09:00 would go out whenever Buffer's next slot came round with
 * our calendar showing a time that never happened.
 *
 * [V] ShareMode = addToQueue | customScheduled | shareNext | shareNow;
 *     SchedulingType = automatic | notification
 *     schema introspection of https://api.buffer.com retrieved 2026-09-10
 */
export async function createPost(
  provider: ProviderId,
  apiKey: string,
  input: BufferPostInput
): Promise<BufferPost> {
  const data = await request<{ createPost: PostActionPayload }>(
    provider,
    apiKey,
    'createPost',
    `mutation CreatePost($input: CreatePostInput!) {
       createPost(input: $input) {
         __typename
         ... on PostActionSuccess { post { ${POST_FIELDS} } }
         ... on NotFoundError { message }
         ... on UnauthorizedError { message }
         ... on UnexpectedError { message }
         ... on RestProxyError { message code }
         ... on LimitReachedError { message }
         ... on InvalidInputError { message }
       }
     }`,
    {
      input: {
        channelId: input.channelId,
        text: input.text,
        assets: input.assets,
        // Required, and absent from every published example. True would park the
        // post in an approval queue instead of sending it.
        needsApproval: false,
        ...(input.dueAt
          ? { mode: 'customScheduled', schedulingType: 'automatic', dueAt: input.dueAt }
          : { mode: 'shareNow', schedulingType: 'automatic' }),
      },
    },
    'createPost'
  )

  return unwrap(provider, data.createPost)
}

/**
 * Turns the result union into a post or a typed error.
 *
 * Each arm maps to the shared taxonomy rather than to one generic failure,
 * because the retry policy reads the taxonomy: a limit must back off, a revoked
 * authorisation must stop, and a rejected caption must never be retried into
 * either.
 */
function unwrap(provider: ProviderId, result: PostActionPayload): BufferPost {
  if (result.__typename === 'PostActionSuccess') {
    const post = (result as { post: BufferPost }).post
    if (post.status === 'error') {
      // Accepted, then failed on the network. Not a transport failure, and
      // retrying it would send the same rejected content again.
      throw new ProviderError(
        provider,
        'ContentRejected',
        post.error?.message?.trim() || 'Buffer accepted the post and then failed to send it.'
      )
    }
    return post
  }

  const message = messageOf((result as { message?: string }).message)
  switch (result.__typename) {
    case 'UnauthorizedError':
      throw new ProviderError(provider, 'PermissionRevoked', message)
    case 'LimitReachedError':
      throw new ProviderError(provider, 'RateLimited', message)
    case 'UnexpectedError':
      throw new ProviderError(provider, 'ProviderDown', message)
    case 'NotFoundError':
      throw new ProviderError(
        provider,
        'PermanentFailure',
        `${message} The channel may have been removed from this Buffer account.`
      )
    // RestProxyError is the NETWORK's own refusal relayed through Buffer, which
    // is the one case where the message is genuinely about the content.
    case 'RestProxyError':
    case 'InvalidInputError':
    default:
      throw new ProviderError(provider, 'ContentRejected', message)
  }
}

/**
 * Recent posts on a channel, for reconciliation after a lost response.
 *
 * This query existing is why the Buffer route can declare `retrievePosts` true,
 * which in turn is why a timed-out publish here can be resolved automatically
 * rather than parked in NEEDS_REVIEW for a person to judge.
 */
export async function listPosts(
  provider: ProviderId,
  apiKey: string,
  channelId: string,
  first = 50
): Promise<BufferPost[]> {
  const org = await organizationId(provider, apiKey)
  const data = await request<{ posts: { edges?: Array<{ node: BufferPost }> | null } }>(
    provider,
    apiKey,
    'posts',
    `query Posts($input: PostsInput!, $first: Int!) {
       posts(input: $input, first: $first) {
         edges { node { ${POST_FIELDS} } }
       }
     }`,
    { input: { organizationId: org, filter: { channelIds: [channelId] } }, first },
    'posts'
  )
  return (data.posts.edges ?? []).map((edge) => edge.node)
}

/** Metrics Buffer has collected for one post. */
export async function postMetrics(
  provider: ProviderId,
  apiKey: string,
  postId: string
): Promise<Record<string, number | null>> {
  const data = await request<{ post: BufferPost | null }>(
    provider,
    apiKey,
    'post',
    `query Post($input: PostInput!) {
       post(input: $input) { id metrics { name value } }
     }`,
    { input: { id: postId } },
    'post'
  )

  const metrics: Record<string, number | null> = {}
  for (const metric of data.post?.metrics ?? []) {
    if (metric.name) metrics[metric.name] = metric.value ?? null
  }
  return metrics
}
