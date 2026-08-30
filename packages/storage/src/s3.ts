import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { randomUUID } from 'node:crypto'
import { assertOutsideTransaction, loadEnv } from '@smm/config'

/**
 * S3-compatible object storage.
 *
 * One code path for MinIO, AWS S3, Cloudflare R2 and anything else speaking the
 * same protocol — the operator changes an endpoint, not a driver.
 *
 * Every call asserts it is OUTSIDE a database transaction. An upload inside one
 * would pin a Postgres connection for the duration of a file transfer, and under
 * load the pool exhausts and the deployment stalls — presenting as a database
 * problem that is actually a network one.
 */

let client: S3Client | undefined

function s3(): S3Client {
  if (!client) {
    const env = loadEnv()
    client = new S3Client({
      endpoint: env.S3_ENDPOINT,
      region: env.S3_REGION,
      // MinIO and most self-hosted gateways need path-style addressing;
      // virtual-host style assumes DNS you do not control.
      forcePathStyle: env.S3_FORCE_PATH_STYLE,
      credentials: {
        accessKeyId: env.S3_ACCESS_KEY_ID,
        secretAccessKey: env.S3_SECRET_ACCESS_KEY,
      },
    })
  }
  return client
}

function bucket(): string {
  return loadEnv().S3_BUCKET
}

/**
 * Storage keys are SERVER-GENERATED.
 *
 * A client-supplied filename is metadata and nothing more. Letting one reach the
 * key would allow traversal, collision across tenants, and unpredictable
 * content-type inference. The workspace prefix also makes a purge a prefix
 * delete rather than a row-by-row hunt.
 */
export function storageKey(workspaceId: string, extension: string): string {
  const safeExt = /^[a-z0-9]{1,8}$/i.test(extension) ? extension.toLowerCase() : 'bin'
  return `w/${workspaceId}/${randomUUID()}.${safeExt}`
}

export async function putObject(
  key: string,
  body: Buffer,
  contentType: string
): Promise<void> {
  assertOutsideTransaction('S3 putObject')
  await s3().send(
    new PutObjectCommand({
      Bucket: bucket(),
      Key: key,
      Body: body,
      ContentType: contentType,
      // Even where a bucket is public for Instagram's fetcher, individual
      // objects are not listable — the relay hands out one key at a time.
      CacheControl: 'private, max-age=31536000',
    })
  )
}

export async function getObject(key: string): Promise<{ body: Buffer; contentType: string }> {
  assertOutsideTransaction('S3 getObject')
  const result = await s3().send(new GetObjectCommand({ Bucket: bucket(), Key: key }))
  const chunks: Buffer[] = []
  for await (const chunk of result.Body as AsyncIterable<Uint8Array>) {
    chunks.push(Buffer.from(chunk))
  }
  return {
    body: Buffer.concat(chunks),
    contentType: result.ContentType ?? 'application/octet-stream',
  }
}

export async function objectExists(key: string): Promise<boolean> {
  assertOutsideTransaction('S3 headObject')
  try {
    await s3().send(new HeadObjectCommand({ Bucket: bucket(), Key: key }))
    return true
  } catch {
    return false
  }
}

export async function deleteObject(key: string): Promise<void> {
  assertOutsideTransaction('S3 deleteObject')
  await s3().send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }))
}

/**
 * A time-limited URL a platform can fetch from directly.
 *
 * Used when MEDIA_PUBLIC_MODE is `presigned-s3` — that is, when storage is
 * itself internet-reachable. Otherwise the relay streams it instead.
 */
export async function presignedGetUrl(key: string, expiresInSeconds = 1800): Promise<string> {
  assertOutsideTransaction('S3 presign')
  return getSignedUrl(s3(), new GetObjectCommand({ Bucket: bucket(), Key: key }), {
    expiresIn: expiresInSeconds,
  })
}

export async function healthCheck(): Promise<{ ok: boolean; detail?: string }> {
  try {
    await s3().send(new HeadObjectCommand({ Bucket: bucket(), Key: '__health__' }))
    return { ok: true }
  } catch (err) {
    // A 404 on a key that does not exist still proves we reached the bucket and
    // authenticated; only a connection or auth failure means unhealthy.
    const name = err instanceof Error ? err.name : ''
    if (name === 'NotFound' || name === 'NoSuchKey') return { ok: true }
    return { ok: false, detail: err instanceof Error ? err.message.slice(0, 200) : 'unreachable' }
  }
}

export function resetClient(): void {
  client = undefined
}
