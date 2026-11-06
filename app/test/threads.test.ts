// Threads (src/main/threads.ts) against fabricated Graph answers. Only the loopback listener uses a socket.
import { afterEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { THREADS_GRAPH, ThreadsService } from '../src/main/threads'

const BROKER = 'https://signin.example'
const NOW = Date.UTC(2026, 10, 6)
const VIDEO = 'fabricated threads video bytes'
const TOKEN = 'th-token'

interface Step { url: string; method?: string; body?: unknown; inspect?: (init: RequestInit) => void | Promise<void>; respond?: (init: RequestInit) => Promise<Response> }
const cleanup: { dir: string; service: ThreadsService }[] = []
afterEach(async () => {
  for (const c of cleanup.splice(0)) { c.service.stop(); await fs.rm(c.dir, { recursive: true, force: true }) }
})

async function world() {
  const dir = await fs.mkdtemp(join(tmpdir(), 'th-fixture-'))
  const project = join(dir, 'projects', 'fixture')
  await fs.mkdir(join(project, 'versions', 'v1'), { recursive: true })
  await fs.writeFile(join(project, 'project.json'), '{}')
  await fs.writeFile(join(project, 'versions', 'v1', 'export.mp4'), VIDEO)
  const steps: Step[] = []
  const errors: unknown[] = []
  let browser = async (_url: string): Promise<void> => { throw new Error('unexpected browser') }
  const service = new ThreadsService({
    settings: async () => ({ appId: '3333', brokerUrl: BROKER, mediaOrigins: ['https://media.example'] }),
    settingsDir: join(dir, 'settings'), projectsDir: () => join(dir, 'projects'), now: () => NOW, waitMs: 0,
    secrets: { isEncryptionAvailable: () => true, encryptString: (v) => Buffer.from(v).reverse(), decryptString: (b) => Buffer.from(b).reverse().toString() },
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
      return step!.respond ? step!.respond(init) : Response.json(step!.body ?? {})
    }
  })
  cleanup.push({ dir, service })
  const connect = () => {
    let back = '', state = ''
    steps.push({ url: `${BROKER}/v1/threads/start`, method: 'POST', respond: async (init) => {
      const b = JSON.parse(String(init.body))
      back = b.loopback_uri; state = b.state
      const u = new URL('https://threads.com/oauth/authorize')
      u.search = new URLSearchParams({ client_id: '3333', redirect_uri: `${BROKER}/v1/threads/callback`, scope: 'threads_basic,threads_content_publish', response_type: 'code', state: 'sealed' }).toString()
      return Response.json({ authorize_url: u.toString() })
    } })
    browser = async () => {
      const cb = new URL(back)
      cb.search = new URLSearchParams({ state, handoff: 'sealed-handoff-from-the-service' }).toString()
      expect((await fetch(cb)).status).toBe(200)
    }
    steps.push({ url: `${BROKER}/v1/threads/complete`, method: 'POST', body: { access_token: TOKEN, token_type: 'bearer', expires_in: 5_184_000, permissions: [], upload_pass: 'sealed-pass' } })
    steps.push({ url: `${THREADS_GRAPH}/me?fields=id,username`, body: { id: '4242', username: 'e2e.threads' } })
  }
  const upload = () => {
    steps.push({ url: `${BROKER}/v1/threads/uploads`, method: 'POST', body: { video: { upload_url: 'https://media.example/th/1.mp4?sig=put', public_url: 'https://media.example/th/1.mp4?sig=get' } },
      inspect: (init) => {
        expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${TOKEN}`)
        expect(JSON.parse(String(init.body))).toEqual({ video_size: VIDEO.length, cover_size: null, upload_pass: 'sealed-pass' })
      } })
    steps.push({ url: 'https://media.example/th/1.mp4?sig=put', method: 'PUT', inspect: async (init) => { expect(await new Response(init.body).text()).toBe(VIDEO) } })
    steps.push({ url: `${THREADS_GRAPH}/4242/threads`, method: 'POST', body: { id: '600' }, inspect: (init) => {
      expect(Object.fromEntries(new URLSearchParams(String(init.body)))).toEqual({ media_type: 'VIDEO', video_url: 'https://media.example/th/1.mp4?sig=get', text: 'On Threads #reel' })
    } })
  }
  const status = (s: string) => steps.push({ url: `${THREADS_GRAPH}/600?fields=status,error_message`, body: { status: s } })
  return { dir, project, steps, service, connect, upload, status, done: () => { expect(errors).toEqual([]); expect(steps).toEqual([]) } }
}

const INPUT = { slug: 'fixture', version: 1, text: 'On Threads #reel' }

describe('Threads', () => {
  it('connects through the sign-in service and posts once Threads has processed the video', async () => {
    const w = await world(); w.connect()
    expect(await w.service.connect()).toEqual({ connected: true, accountId: '4242', username: 'e2e.threads', expiresAt: NOW + 5_184_000_000 })
    w.upload(); w.status('IN_PROGRESS'); w.status('FINISHED')
    w.steps.push({ url: `${THREADS_GRAPH}/4242/threads_publish`, method: 'POST', body: { id: '700' }, inspect: (init) => { expect(String(init.body)).toBe('creation_id=600') } })
    const post = await w.service.publish(INPUT)
    expect(post).toEqual({ version: 1, accountId: '4242', postId: '700', publishedAt: new Date(NOW).toISOString() })
    const outcomes = JSON.parse(await fs.readFile(join(w.project, 'outcomes.json'), 'utf8'))
    expect(outcomes.versions.v1['threads:700']).toMatchObject({ platform: 'threads', apiVersion: 'v1.0' })
    // asking again posts nothing
    expect(await w.service.publish(INPUT)).toEqual(post); w.done()
  })

  it('won’t publish a container made from an older export of the version', async () => {
    const w = await world(); w.connect(); await w.service.connect()
    // made, then still processing when the person stopped waiting
    w.upload(); for (let i = 0; i < 10; i++) w.status('IN_PROGRESS')
    await expect(w.service.publish(INPUT)).rejects.toMatchObject({ code: 'TH_PROCESSING' })
    await fs.writeFile(join(w.project, 'versions', 'v1', 'export.mp4'), VIDEO.split('').reverse().join(''))
    await expect(w.service.publish(INPUT)).rejects.toMatchObject({ code: 'TH_PUBLISH_CHANGED' }); w.done()
  })

  it('never posts again after Threads’ answer to Publish was lost, and refuses text over 500 characters', async () => {
    const w = await world(); w.connect(); await w.service.connect()
    await expect(w.service.publish({ ...INPUT, text: 'x'.repeat(501) })).rejects.toMatchObject({ code: 'TH_INPUT' })
    w.upload(); w.status('FINISHED')
    w.steps.push({ url: `${THREADS_GRAPH}/4242/threads_publish`, method: 'POST', respond: async () => { throw new Error('reset') } })
    await expect(w.service.publish(INPUT)).rejects.toMatchObject({ code: 'TH_PUBLISH_UNKNOWN' })
    await expect(w.service.publish(INPUT)).rejects.toMatchObject({ code: 'TH_PUBLISH_UNKNOWN' }); w.done()
  })
})
