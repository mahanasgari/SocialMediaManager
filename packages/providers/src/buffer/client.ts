import { assertOutsideTransaction } from '@smm/config'
import { ProviderError } from '../errors.js'
import type { ProviderId } from '../capabilities/index.js'

/**
 * Buffer's GraphQL API — the shared transport for every Buffer-routed connector.
 *
 * This is a ROUTE, not a network. Nobody has a "Buffer audience": posting here
 * reaches Instagram or Facebook exactly as posting directly does, with Buffer
 * standing in the middle holding the OAuth grant we would otherwise hold
 * ourselves. Everything that follows is shaped by what that middle layer can
 * and cannot pass through.
 *
 * Three facts decided this file's shape:
 *
 *   1. THE API KEY IS ACCOUNT-WIDE AND IS THE WHOLE CREDENTIAL. Buffer's
 *      third-party OAuth is documented but closed to new clients, so there is
 *      no per-user grant to obtain — a person pastes a key from Buffer's
 *      Settings → API and it reaches every channel in that Buffer account.
 *      [V] https://developers.buffer.com/guides/authentication retrieved 2026-09-07
 *
 *   2. ONE MUTATION PER CHANNEL. `createPost` takes a single `channelId`, not
 *      an array, so fan-out is our job — which suits us, because a variant is
 *      already per-account and a partial failure must stay attributable to the
 *      channel it happened on.
 *      [V] https://developers.buffer.com/examples/create-text-post.html retrieved 2026-09-07
 *
 *   3. ERRORS ARRIVE AS DATA, NOT AS STATUS CODES. GraphQL answers 200 with an
 *      `errors` array, and `createPost` returns a union whose failure arm is a
 *      `MutationError` object. A transport that only checked `response.ok`
 *      would report every rejected post as a success. Both are checked here so
 *      no adapter has to remember to.
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

type GraphQLResponse<T> = {
  data?: T
  errors?: Array<{ message?: string; extensions?: { code?: string } }>
}

/**
 * Runs one GraphQL operation.
 *
 * `provider` is passed in rather than hard-coded because this transport serves
 * several connectors and a ProviderError must name the one the user actually
 * connected — "buffer failed" is not something they can act on when what they
 * see on screen is an Instagram channel.
 */
export async function bufferRequest<T>(
  provider: ProviderId,
  apiKey: string,
  operation: string,
  query: string,
  variables: Record<string, unknown> = {}
): Promise<T> {
  assertOutsideTransaction(`buffer.${operation}`)

  let response: Response
  try {
    response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(30_000),
    })
  } catch (cause) {
    // A timeout or a DNS failure is Buffer being unreachable, which is worth
    // retrying — distinct from Buffer answering with a refusal, which is not.
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
      'Buffer rejected the API key for this channel. Generate a new one under Settings → API in Buffer and reconnect the channel.',
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

  // GraphQL reports failure inside a 200. Checking response.ok alone would let
  // every one of these through as a success.
  const first = body.errors?.[0]
  if (first) {
    throw new ProviderError(provider, codeFor(first.extensions?.code), messageOf(first.message), {
      httpStatus: response.status,
      raw: body.errors,
    })
  }

  if (!body.data) {
    throw new ProviderError(
      provider,
      'ProviderDown',
      'Buffer returned an empty response.',
      { httpStatus: response.status }
    )
  }

  return body.data
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

const CHANNEL_FIELDS = `id name service displayName avatar`

/**
 * Every channel the key can reach.
 *
 * Buffer scopes this by the key's own permissions, so what comes back is
 * already what this account may post to — there is no separate permission check
 * for us to get wrong.
 */
export async function listChannels(
  provider: ProviderId,
  apiKey: string
): Promise<BufferChannel[]> {
  const data = await bufferRequest<{ channels: BufferChannel[] }>(
    provider,
    apiKey,
    'channels',
    `query Channels { channels { ${CHANNEL_FIELDS} } }`
  )
  return data.channels ?? []
}

export type BufferPostInput = {
  channelId: string
  text: string
  assets?: ReadonlyArray<{ image: { url: string } } | { video: { url: string } }>
  /** Absent means "add to the queue"; present means publish at this instant. */
  dueAt?: string
}

export type BufferPost = {
  id: string
  status?: string | null
  text?: string | null
  createdAt?: string | null
  metrics?: Array<{ key?: string | null; value?: number | null }> | null
}

/**
 * Creates one post on one channel.
 *
 * `mode` is chosen rather than defaulted. `addToQueue` would hand the timing to
 * Buffer's own posting schedule, which means a post this product scheduled for
 * 09:00 would go out whenever Buffer's queue happened to reach it — the
 * calendar would show a time that was never real. `customScheduled` with an
 * explicit `dueAt` keeps the time the user chose authoritative.
 */
export async function createPost(
  provider: ProviderId,
  apiKey: string,
  input: BufferPostInput
): Promise<BufferPost> {
  const data = await bufferRequest<{
    createPost:
      | { __typename: 'PostActionSuccess'; post: BufferPost }
      | { __typename: 'MutationError'; message: string }
  }>(
    provider,
    apiKey,
    'createPost',
    `mutation CreatePost($input: CreatePostInput!) {
       createPost(input: $input) {
         __typename
         ... on PostActionSuccess { post { id status text createdAt } }
         ... on MutationError { message }
       }
     }`,
    {
      input: {
        channelId: input.channelId,
        text: input.text,
        ...(input.assets && input.assets.length > 0 ? { assets: input.assets } : {}),
        ...(input.dueAt
          ? { mode: 'customScheduled', schedulingType: 'custom', dueAt: input.dueAt }
          : { mode: 'addToQueue', schedulingType: 'automatic' }),
      },
    }
  )

  const result = data.createPost
  if (result.__typename === 'MutationError') {
    // The failure arm of the union. This is a refusal with a reason, not an
    // outage, so it must not be retried into a rate limit.
    throw new ProviderError(provider, 'ContentRejected', messageOf(result.message))
  }
  return result.post
}

/** Removes a post Buffer still holds. Published posts are gone from our reach. */
export async function deletePost(
  provider: ProviderId,
  apiKey: string,
  postId: string
): Promise<void> {
  await bufferRequest(
    provider,
    apiKey,
    'deletePost',
    `mutation DeletePost($input: DeletePostInput!) {
       deletePost(input: $input) { __typename ... on MutationError { message } }
     }`,
    { input: { id: postId } }
  )
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
  const data = await bufferRequest<{ posts: { edges?: Array<{ node: BufferPost }> } }>(
    provider,
    apiKey,
    'posts',
    `query Posts($input: PostsInput!, $first: Int!) {
       posts(input: $input, first: $first) {
         edges { node { id status text createdAt } }
       }
     }`,
    { input: { channelIds: [channelId] }, first }
  )
  return (data.posts?.edges ?? []).map((edge) => edge.node)
}

/** Metrics Buffer has collected for one post. */
export async function postMetrics(
  provider: ProviderId,
  apiKey: string,
  postId: string
): Promise<Record<string, number | null>> {
  const data = await bufferRequest<{ post: BufferPost | null }>(
    provider,
    apiKey,
    'post',
    `query Post($input: PostInput!) {
       post(input: $input) { id metrics { key value } }
     }`,
    { input: { id: postId } }
  )

  const metrics: Record<string, number | null> = {}
  for (const metric of data.post?.metrics ?? []) {
    if (metric.key) metrics[metric.key] = metric.value ?? null
  }
  return metrics
}
