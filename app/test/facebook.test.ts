// Facebook Reels on a Page (src/main/facebook.ts) against fabricated Graph answers. No Meta host is contacted; only the
// loopback listener uses a socket.
import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FACEBOOK_GRAPH, FacebookService } from '../src/main/facebook'

const BROKER = 'https://signin.example'
const NOW = Date.UTC(2026, 10, 6)
const VIDEO = 'fabricated reel bytes, twenty-nine'
const USER = 'fb-user-token'
const PAGE_TOKEN = 'fb-page-token'

interface Step { url: string; method?: string; body?: unknown; status?: number; inspect?: (init: RequestInit) => void | Promise<void>; respond?: (init: RequestInit) => Promise<Response> }
const cleanup: { dir: string; service: FacebookService }[] = []
afterEach(async () => {
  for (const c of cleanup.splice(0)) { c.service.stop(); await fs.rm(c.dir, { recursive: true, force: true }) }
})

async function world() {
  const dir = await fs.mkdtemp(join(tmpdir(), 'fb-fixture-'))
  const project = join(dir, 'projects', 'fixture')
  await fs.mkdir(join(project, 'versions', 'v1'), { recursive: true })
  await fs.writeFile(join(project, 'project.json'), '{}')
  await fs.writeFile(join(project, 'versions', 'v1', 'export.mp4'), VIDEO)
  const steps: Step[] = []
  const errors: unknown[] = []
  let browser = async (_url: string): Promise<void> => { throw new Error('unexpected browser') }
  // a reversible stand-in for the OS keychain
  const secrets = {
    isEncryptionAvailable: () => true,
    encryptString: (v: string) => Buffer.from(v, 'utf8').reverse(),
    decryptString: (b: Buffer) => Buffer.from(b).reverse().toString('utf8')
  }
  const service = new FacebookService({
    settings: async () => ({ appId: '2222', brokerUrl: BROKER }), settingsDir: join(dir, 'settings'), projectsDir: () => join(dir, 'projects'),
    secrets, now: () => NOW, openExternal: (url) => browser(url),
    fetch: async (url, init) => {
      const step = steps.shift()
      try {
        expect(step, `unexpected HTTP ${url}`).toBeDefined()
        expect(url).toBe(step!.url)
        expect(init.method ?? 'GET').toBe(step!.method ?? 'GET')
        expect(init.redirect).toBe('error')
        await step!.inspect?.(init)
      } catch (e) { errors.push(e); throw e }
      if (step!.respond) return step!.respond(init)
      return Response.json(step!.body ?? {}, { status: step!.status ?? 200 })
    }
  })
  cleanup.push({ dir, service })
  const connect = (pages: unknown[]) => {
    let back = ''
    let state = ''
    let challenge = ''
    steps.push({ url: `${BROKER}/v1/facebook/start`, method: 'POST', respond: async (init) => {
      const b = JSON.parse(String(init.body))
      back = b.loopback_uri; state = b.state; challenge = b.code_challenge
      const u = new URL('https://www.facebook.com/v26.0/dialog/oauth')
      u.search = new URLSearchParams({ client_id: '2222', redirect_uri: `${BROKER}/v1/facebook/callback`, state: 'sealed', response_type: 'code' }).toString()
      return Response.json({ authorize_url: u.toString() })
    } })
    // the person clicks Allow; the service sends them back to the app with a handoff
    browser = async () => {
      const cb = new URL(back)
      cb.search = new URLSearchParams({ state, handoff: 'sealed-handoff-from-the-service' }).toString()
      expect((await fetch(cb)).status).toBe(200)
    }
    steps.push({ url: `${BROKER}/v1/facebook/complete`, method: 'POST', body: { access_token: USER, token_type: 'bearer', expires_in: 5_000_000, permissions: ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts'] },
      inspect: (init) => { expect(createHash('sha256').update(JSON.parse(String(init.body)).code_verifier).digest('base64url')).toBe(challenge) } })
    steps.push({ url: `${FACEBOOK_GRAPH}/me?fields=name`, body: { name: 'Sam Creator' } })
    steps.push({ url: `${FACEBOOK_GRAPH}/me/accounts?fields=id,name,access_token,tasks&limit=100`, body: { data: pages } })
  }
  const publishSteps = (have: number, finish: Partial<Step> = {}) => {
    steps.push({ url: `${FACEBOOK_GRAPH}/77/video_reels`, method: 'POST', body: { video_id: '555', upload_url: 'https://rupload.facebook.com/video-upload/555' },
      inspect: (init) => { expect(new URLSearchParams(String(init.body)).get('upload_phase')).toBe('start'); expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${PAGE_TOKEN}`) } })
    resume(have)
    steps.push({ url: `${FACEBOOK_GRAPH}/77/video_reels`, method: 'POST', body: { success: true }, inspect: (init) => {
      expect(Object.fromEntries(new URLSearchParams(String(init.body)))).toEqual({ upload_phase: 'finish', video_id: '555', video_state: 'PUBLISHED', description: 'A reel #fb' })
    }, ...finish })
  }
  const resume = (have: number) => {
    steps.push({ url: `${FACEBOOK_GRAPH}/555?fields=status`, body: { status: { video_status: 'uploading', uploading_phase: { status: 'in_progress', bytes_transfered: have } } } })
    steps.push({ url: 'https://rupload.facebook.com/video-upload/v26.0/555', method: 'POST', body: { success: true }, inspect: async (init) => {
      const h = new Headers(init.headers)
      expect(h.get('authorization')).toBe(`OAuth ${PAGE_TOKEN}`)
      expect(h.get('offset')).toBe(String(have))
      expect(h.get('file_size')).toBe(String(VIDEO.length))
      expect(await new Response(init.body).text()).toBe(VIDEO.slice(have))
    } })
  }
  const PAGES = [{ id: '76', name: 'Read only', access_token: 'nope', tasks: ['ANALYZE'] }, { id: '77', name: 'My Page', access_token: PAGE_TOKEN, tasks: ['CREATE_CONTENT', 'ANALYZE'] }]
  return { dir, project, steps, service, connect, publishSteps, resume, PAGES, done: () => { expect(errors).toEqual([]); expect(steps).toEqual([]) } }
}

const INPUT = { slug: 'fixture', version: 1, description: 'A reel #fb' }

describe('Facebook', () => {
  it('connects through the sign-in service and keeps only the Pages the account can post to', async () => {
    const w = await world(); w.connect(w.PAGES)
    const s = await w.service.connect()
    expect(s).toEqual({ connected: true, userName: 'Sam Creator', page: { id: '77', name: 'My Page' }, pages: [{ id: '77', name: 'My Page' }], expiresAt: NOW + 5_000_000_000 })
    expect(JSON.stringify(s)).not.toContain(PAGE_TOKEN)
    expect(await w.service.session()).toEqual(s); w.done()
  })

  it('says plainly when the account can’t post to any Page, and saves nothing', async () => {
    const w = await world(); w.connect([w.PAGES[0]])
    await expect(w.service.connect()).rejects.toMatchObject({ code: 'FB_NO_PAGE' })
    expect(await w.service.session()).toEqual({ connected: false }); w.done()
  })

  it('posts a reel to the Page and records it next to the other platforms’ posts; asking again posts nothing', async () => {
    const w = await world(); w.connect(w.PAGES); await w.service.connect()
    w.publishSteps(0)
    const post = await w.service.publish(INPUT)
    expect(post).toEqual({ version: 1, accountId: '77', postId: '555', publishedAt: new Date(NOW).toISOString() })
    const outcomes = JSON.parse(await fs.readFile(join(w.project, 'outcomes.json'), 'utf8'))
    expect(outcomes.versions.v1['facebook:555']).toEqual({ ...post, platform: 'facebook', apiVersion: 'v26.0', observedAt: null, metrics: null })
    expect(await w.service.publish(INPUT)).toEqual(post); w.done()
  })

  it('carries on from what Facebook already has after a stopped upload', async () => {
    const w = await world(); w.connect(w.PAGES); await w.service.connect()
    await fs.writeFile(join(w.project, 'facebook-publish.json'), JSON.stringify({ schemaVersion: 1, versions: { v1: {
      state: 'uploading', pageId: '77', videoId: '555', inputHash: createHash('sha256').update(JSON.stringify({ page: '77', description: INPUT.description })).digest('hex')
    } } }))
    w.resume(10)
    w.steps.push({ url: `${FACEBOOK_GRAPH}/77/video_reels`, method: 'POST', body: { success: true } })
    expect(await w.service.publish(INPUT)).toMatchObject({ postId: '555' }); w.done()
  })

  it('never posts again after Facebook’s answer to Post was lost', async () => {
    const w = await world(); w.connect(w.PAGES); await w.service.connect()
    w.publishSteps(0, { respond: async () => { throw new Error('connection reset') } })
    await expect(w.service.publish(INPUT)).rejects.toMatchObject({ code: 'FB_PUBLISH_UNKNOWN' })
    await expect(w.service.publish(INPUT)).rejects.toMatchObject({ code: 'FB_PUBLISH_UNKNOWN' }); w.done()
  })

  it('disconnect forgets the account and asks Facebook to end the access', async () => {
    const w = await world(); w.connect(w.PAGES); await w.service.connect()
    w.steps.push({ url: `${FACEBOOK_GRAPH}/me/permissions`, method: 'DELETE', body: { success: true }, inspect: (init) => {
      expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${USER}`)
    } })
    await w.service.disconnect()
    expect(await w.service.session()).toEqual({ connected: false }); w.done()
  })
})
