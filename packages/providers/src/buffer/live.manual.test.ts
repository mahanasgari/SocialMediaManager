import { describe, expect, it } from 'vitest'
import { InstagramBufferProvider } from '../instagramBuffer/adapter.js'

const key = process.env['BUF']

describe.skipIf(!key)('live Buffer', () => {
  it('connects, reads the profile and reads posts back', async () => {
    const ig = new InstagramBufferProvider()
    const found = await ig.handleCallback({} as never, { apiKey: key! })
    console.log('handleCallback ->', found.length, 'account(s)')
    for (const a of found) {
      console.log('   id:', a.providerAccountId, '| handle:', a.handle, '| name:', a.displayName)
      console.log('   avatar:', a.avatarUrl ? 'yes' : 'none', '| meta:', JSON.stringify(a.platformMeta))
    }
    expect(found.length).toBeGreaterThan(0)

    const first = found[0]!
    const acct = {
      id: 'x',
      providerAccountId: first.providerAccountId,
      handle: first.handle,
      displayName: first.displayName,
      platformMeta: first.platformMeta ?? {},
    }

    const profile = await ig.fetchProfile(acct, first.credential)
    console.log('fetchProfile ->', JSON.stringify(profile))

    const posts = await ig.retrievePosts(acct, first.credential, new Date(0))
    console.log('retrievePosts ->', posts.length, 'post(s)')
    for (const p of posts.slice(0, 5)) {
      console.log('   ', p.remoteId, '| media:', p.mediaCount, '| at:', p.createdAt.toISOString(), '| text:', JSON.stringify((p.text || '').slice(0, 40)))
    }
  }, 60_000)
})
