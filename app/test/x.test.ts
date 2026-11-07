// X (src/main/x.ts) against fabricated X API answers. Only the loopback listener uses a socket.
import { afterEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { X_API, XService } from '../src/main/x'

const BROKER = 'https://signin.example'
const NOW = Date.UTC(2026, 10, 6)
const VIDEO = 'fabricated x video bytes'

interface Step { url: string; method?: string; body?: unknown; status?: number; inspect?: (init: RequestInit) => void | Promise<void>; respond?: (init: RequestInit) => Promise<Response> }
const cleanup: { dir: string; service: XService }[] = []
afterEach(async () => {
  for (const c of cleanup.splice(0)) { c.service.stop(); await fs.rm(c.dir, { recursive: true, force: true }) }
})

async function world() {
  const dir = await fs.mkdtemp(join(tmpdir(), 'x-fixture-'))
  const project = join(dir, 'projects', 'fixture')
  await fs.mkdir(join(project, 'versions', 'v1'), { recursive: true })
  await fs.writeFile(join(project, 'project.json'), '{}')
  await fs.writeFile(join(project, 'versions', 'v1', 'export.mp4'), VIDEO)
  const steps: Step[] = []
  const errors: unknown[] = []
  let now = NOW
  let failSave = false
  // runs once, inside the next encrypted save: a person pressing Cancel while the sign-in is being written
  let duringSave: (() => void) | null = null
  const saving = () => { const f = duringSave; duringSave = null; f?.() }
  let browser = async (_url: string): Promise<void> => { throw new Error('unexpected browser') }
  const service = new XService({
    settings: async () => ({ clientId: 'x-client', brokerUrl: BROKER }),
    settingsDir: join(dir, 'settings'), projectsDir: () => join(dir, 'projects'), now: () => now, waitMs: 0,
    secrets: { isEncryptionAvailable: () => true, encryptString: (v) => { saving(); if (failSave) throw new Error('disk full'); return Buffer.from(v).reverse() }, decryptString: (b) => Buffer.from(b).reverse().toString() },
    openExternal: (url) => browser(url),
    fetch: async (url, init) => {
      const step = steps.shift()
      try {
        expect(step, `unexpected HTTP ${url}`).toBeDefined()
        expect(url).toBe(step!.url)
        expect(init.method ?? 'GET').toBe(step!.method ?? 'GET')
        expect(init.redirect).toBe('error')
        await step!.inspect?.(init)
      } catch (e) { errors.push(e); throw e }
      return step!.respond ? step!.respond(init) : Response.json(step!.body ?? {}, { status: step!.status ?? 200 })
    }
  })
  cleanup.push({ dir, service })
  const connect = () => {
    let back = '', state = ''
    steps.push({ url: `${BROKER}/v1/x/start`, method: 'POST', respond: async (init) => {
      const b = JSON.parse(String(init.body))
      back = b.loopback_uri; state = b.state
      const u = new URL('https://x.com/i/oauth2/authorize')
      u.search = new URLSearchParams({ response_type: 'code', client_id: 'x-client', redirect_uri: `${BROKER}/v1/x/callback`, state: 'sealed', code_challenge: 'c', code_challenge_method: 'S256' }).toString()
      return Response.json({ authorize_url: u.toString() })
    } })
    browser = async () => {
      const cb = new URL(back)
      cb.search = new URLSearchParams({ state, handoff: 'sealed-handoff-from-the-service' }).toString()
      expect((await fetch(cb)).status).toBe(200)
    }
    steps.push({ url: `${BROKER}/v1/x/complete`, method: 'POST', body: { access_token: 'x-token', refresh_token: 'x-refresh', token_type: 'bearer', expires_in: 7200, permissions: ['tweet.read', 'tweet.write', 'users.read', 'media.write', 'offline.access'] } })
    steps.push({ url: `${X_API}/users/me`, body: { data: { id: '99', username: 'e2e_x', name: 'E2E' } } })
  }
  const upload = (token = 'x-token') => {
    steps.push({ url: `${X_API}/media/upload/initialize`, method: 'POST', body: { data: { id: '1234', media_key: '13_1234' } }, inspect: (init) => {
      expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${token}`)
      expect(JSON.parse(String(init.body))).toEqual({ media_type: 'video/mp4', total_bytes: VIDEO.length, media_category: 'tweet_video' })
    } })
    steps.push({ url: `${X_API}/media/upload/1234/append`, method: 'POST', respond: async () => new Response(null, { status: 204 }), inspect: async (init) => {
      const f = init.body as FormData
      expect(f.get('segment_index')).toBe('0')
      expect(await (f.get('media') as Blob).text()).toBe(VIDEO)
    } })
    steps.push({ url: `${X_API}/media/upload/1234/finalize`, method: 'POST', body: { data: { id: '1234', processing_info: { state: 'pending', check_after_secs: 1 } } } })
    steps.push({ url: `${X_API}/media/upload?command=STATUS&media_id=1234`, body: { data: { processing_info: { state: 'succeeded' } } } })
  }
  return { dir, project, steps, service, connect, upload, later: (ms: number) => { now += ms }, breakSaving: () => { failSave = true }, duringSave: (fn: () => void) => { duringSave = fn }, done: () => { expect(errors).toEqual([]); expect(steps).toEqual([]) } }
}

const INPUT = { slug: 'fixture', version: 1, text: 'On X #reel' }

describe('X', () => {
  it('connects through the sign-in service, uploads the video in pieces and posts it with the text', async () => {
    const w = await world(); w.connect()
    expect(await w.service.connect()).toEqual({ connected: true, accountId: '99', username: 'e2e_x' })
    w.upload()
    w.steps.push({ url: `${X_API}/tweets`, method: 'POST', body: { data: { id: '5555', text: 'On X #reel' } }, inspect: (init) => {
      expect(JSON.parse(String(init.body))).toEqual({ text: 'On X #reel', media: { media_ids: ['1234'] } })
    } })
    const post = await w.service.publish(INPUT)
    expect(post).toEqual({ version: 1, accountId: '99', postId: '5555', publishedAt: new Date(NOW).toISOString() })
    const outcomes = JSON.parse(await fs.readFile(join(w.project, 'outcomes.json'), 'utf8'))
    expect(outcomes.versions.v1['x:5555']).toMatchObject({ platform: 'x', apiVersion: 'v2' })
    expect(await w.service.publish(INPUT)).toEqual(post)
    await expect(w.service.publish({ ...INPUT, text: 'Different words' })).rejects.toMatchObject({ code: 'X_ALREADY_POSTED' }); w.done()
  })

  it('cancelling while the sign-in is being saved connects nothing', async () => {
    const w = await world(); w.connect()
    w.duringSave(() => w.service.cancelConnect())
    await expect(w.service.connect()).rejects.toMatchObject({ code: 'X_CANCELLED' })
    expect(await w.service.session()).toEqual({ connected: false }); w.done()
  })

  it('refreshes the two-hour token through the service and keeps X’s new refresh token', async () => {
    const w = await world(); w.connect(); await w.service.connect()
    w.later(2 * 3600_000)
    w.steps.push({ url: `${BROKER}/v1/x/refresh`, method: 'POST', body: { access_token: 'x-token-2', refresh_token: 'x-refresh-2', token_type: 'bearer', expires_in: 7200 },
      inspect: (init) => { expect(JSON.parse(String(init.body))).toEqual({ refresh_token: 'x-refresh' }) } })
    w.upload('x-token-2')
    w.steps.push({ url: `${X_API}/tweets`, method: 'POST', body: { data: { id: '5556' } } })
    await w.service.publish(INPUT)
    // the next refresh uses the new refresh token (asking again for the posted version posts nothing)
    w.later(2 * 3600_000)
    w.steps.push({ url: `${BROKER}/v1/x/refresh`, method: 'POST', body: { access_token: 'x-token-3', refresh_token: 'x-refresh-3', token_type: 'bearer', expires_in: 7200 },
      inspect: (init) => { expect(JSON.parse(String(init.body))).toEqual({ refresh_token: 'x-refresh-2' }) } })
    expect(await w.service.publish(INPUT)).toMatchObject({ postId: '5556' }); w.done()
  })

  it('says to connect again when X’s new refresh token can’t be kept', async () => {
    const w = await world(); w.connect(); await w.service.connect()
    w.later(2 * 3600_000)
    w.steps.push({ url: `${BROKER}/v1/x/refresh`, method: 'POST', body: { access_token: 'x-token-2', refresh_token: 'x-refresh-2', token_type: 'bearer', expires_in: 7200 } })
    w.breakSaving()
    await expect(w.service.publish(INPUT)).rejects.toMatchObject({ code: 'X_TOKEN', userMessage: expect.stringContaining('Connect X again') }); w.done()
  })

  it('never posts again after X’s answer to the post was lost; a refusal can be tried again', async () => {
    const w = await world(); w.connect(); await w.service.connect()
    w.upload()
    w.steps.push({ url: `${X_API}/tweets`, method: 'POST', status: 402, body: { title: 'CreditsDepleted' } })
    await expect(w.service.publish(INPUT)).rejects.toMatchObject({ code: 'X_CREDITS' })
    w.upload()
    w.steps.push({ url: `${X_API}/tweets`, method: 'POST', respond: async () => { throw new Error('reset') } })
    await expect(w.service.publish(INPUT)).rejects.toMatchObject({ code: 'X_PUBLISH_UNKNOWN' })
    await expect(w.service.publish(INPUT)).rejects.toMatchObject({ code: 'X_PUBLISH_UNKNOWN' }); w.done()
  })
})
