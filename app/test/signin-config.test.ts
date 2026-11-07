// How the app reads Reel Studio's sign-in service's list of platforms (src/main/signin-config.ts).
import { describe, expect, it } from 'vitest'
import { availability, instagramFrom, readPlatforms, SigninDirectory, signinUrl } from '../src/main/signin-config'

const IG = { clientId: '1111', review: 'testers', mediaOrigins: ['https://media.example'] }
const TT = { clientKey: 'tt-key', audited: false, directPost: true }

describe('the platform list', () => {
  it('offers a platform only when every field is as expected', () => {
    expect(readPlatforms({ v: 1, platforms: { instagram: IG, tiktok: TT } })).toEqual({ instagram: IG, tiktok: TT })
    for (const bad of [
      { ...IG, clientId: '11a' }, { ...IG, review: 'pending' }, { ...IG, mediaOrigins: [] },
      { ...IG, mediaOrigins: ['http://media.example'] }, { ...IG, mediaOrigins: ['https://media.example/path'] }
    ]) expect(readPlatforms({ v: 1, platforms: { instagram: bad } }), JSON.stringify(bad)).toEqual({})
    expect(readPlatforms({ v: 1, platforms: { tiktok: { ...TT, audited: 'no' } } })).toEqual({})
    expect(readPlatforms({ v: 2, platforms: { instagram: IG } })).toEqual({})
  })

  it('says why a platform can’t be connected, and where its approval stands when it can', () => {
    const d = { reached: true as const, platforms: readPlatforms({ v: 1, platforms: { instagram: IG, tiktok: TT } }) }
    expect(availability({ reached: false }, 'instagram', false)).toEqual({ open: false, why: 'unreachable' })
    expect(availability(d, 'facebook', false)).toEqual({ open: false, why: 'not_set_up' })
    expect(availability(d, 'instagram', false)).toEqual({ open: true, review: 'testers' })
    expect(availability(d, 'tiktok', false)).toEqual({ open: true, review: 'private_only' })
    expect(availability({ reached: false }, 'tiktok', true)).toEqual({ open: true, review: 'own' })
    expect(instagramFrom({ reached: false }, 'https://signin.example').instagramEnabled).toBe(false)
    expect(instagramFrom(d, 'https://signin.example')).toEqual({ instagramEnabled: true, instagramAppId: '1111', instagramBrokerUrl: 'https://signin.example', instagramUploadOrigins: ['https://media.example'] })
  })
})

describe('asking the service', () => {
  it('asks again 30 s after it couldn’t be reached, and keeps an answer for 10 minutes', async () => {
    let now = 0
    let up = false
    const asked: string[] = []
    const dir = new SigninDirectory({
      baseUrl: 'https://signin.example', now: () => now, log: () => {},
      fetch: async (url) => {
        asked.push(url)
        if (!up) throw new Error('offline')
        return Response.json({ v: 1, platforms: { tiktok: TT } })
      }
    })
    expect(await dir.get()).toEqual({ reached: false })
    up = true
    now += 29_000
    expect(await dir.get()).toEqual({ reached: false })
    now += 2_000
    expect(await dir.get()).toEqual({ reached: true, platforms: { tiktok: TT } })
    now += 9 * 60_000
    await dir.get()
    expect(asked).toEqual(['https://signin.example/v1/platforms', 'https://signin.example/v1/platforms'])
    // Check again in Settings asks now
    await dir.get(true)
    expect(asked).toHaveLength(3)
  })

  it('takes another address only when it is https, or http on this computer', () => {
    const logs: string[] = []
    const D = 'https://signin.getreelstudio.com'
    expect(signinUrl({ REELSTUDIO_SIGNIN_URL: 'http://127.0.0.1:8787' }, D, (l) => logs.push(l))).toBe('http://127.0.0.1:8787')
    expect(signinUrl({ REELSTUDIO_SIGNIN_URL: 'https://staging.example/' }, D, (l) => logs.push(l))).toBe('https://staging.example')
    expect(signinUrl({ REELSTUDIO_SIGNIN_URL: 'http://signin.example' }, D, (l) => logs.push(l))).toBe(D)
    expect(signinUrl({}, D, (l) => logs.push(l))).toBe(D)
    expect(logs).toEqual(['[signin] REELSTUDIO_SIGNIN_URL is not a usable address; using the built-in one'])
  })
})
