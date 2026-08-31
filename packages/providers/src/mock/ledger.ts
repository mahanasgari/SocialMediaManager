import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { RemotePost } from '../base.js'

/**
 * A record of published posts that survives our process dying.
 *
 * The mock's default ledger is a `Map`, which is right for unit tests and
 * useless for the one test that matters most. Fault injection kills the worker
 * mid-publish and asks a fresh process "did that post go out?" — and a provider
 * whose memory of what you published vanishes when YOU crash is not a provider,
 * it is a mirror. It would answer "no", the reconciler would requeue, and the
 * harness would prove the opposite of what it claims to.
 *
 * Real providers keep their records on their own servers, entirely indifferent
 * to whether we are still running. This file is the smallest honest version of
 * that.
 *
 * Append-only JSONL, and written with a SINGLE synchronous append per post.
 * Both properties are load-bearing:
 *
 *   - Synchronous, because the process is about to be SIGKILLed by design and a
 *     buffered write would be lost — recreating the in-memory problem through a
 *     slower route.
 *   - Append-only, because a read-modify-write would leave a truncated file if
 *     the kill landed mid-rewrite, and "the ledger is corrupt" is a different
 *     failure from the one under test.
 *
 * Only ever used by MockProvider. Nothing real touches it.
 */
export class FileLedger {
  constructor(private readonly path: string) {
    const dir = dirname(path)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  }

  append(providerAccountId: string, post: RemotePost): void {
    appendFileSync(
      this.path,
      JSON.stringify({ providerAccountId, ...post, createdAt: post.createdAt.toISOString() }) + '\n'
    )
  }

  read(providerAccountId: string): RemotePost[] {
    if (!existsSync(this.path)) return []
    return readFileSync(this.path, 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      // A partial final line is possible: the process may have been killed
      // between the write starting and the newline landing. Skipping it is
      // correct — a half-written record is a post we cannot claim went out.
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as Record<string, unknown>]
        } catch {
          return []
        }
      })
      .filter((row) => row['providerAccountId'] === providerAccountId)
      .map((row) => ({
        remoteId: String(row['remoteId']),
        createdAt: new Date(String(row['createdAt'])),
        text: String(row['text'] ?? ''),
        mediaCount: Number(row['mediaCount'] ?? 0),
      }))
  }

  /** Every post, for a harness counting how many times something was published. */
  all(): Array<RemotePost & { providerAccountId: string }> {
    if (!existsSync(this.path)) return []
    return readFileSync(this.path, 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .flatMap((line) => {
        try {
          const row = JSON.parse(line) as Record<string, unknown>
          return [
            {
              providerAccountId: String(row['providerAccountId']),
              remoteId: String(row['remoteId']),
              createdAt: new Date(String(row['createdAt'])),
              text: String(row['text'] ?? ''),
              mediaCount: Number(row['mediaCount'] ?? 0),
            },
          ]
        } catch {
          return []
        }
      })
  }
}
