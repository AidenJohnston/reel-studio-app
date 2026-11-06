// LinkedIn (src/main/linkedin.ts) against fabricated LinkedIn answers. Only the loopback listener uses a socket.
import { afterEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LINKEDIN_API, LinkedInService } from '../src/main/linkedin'

const BROKER = 'https://signin.example'
const NOW = Date.UTC(2026, 10, 6)
const VIDEO = 'fabricated linkedin video, two parts'
const SPLIT = 10

interface Step { url: string; method?: string; body?: unknown; headers?: Record<string, string>; inspect?: (init: RequestInit) => void | Promise<void>; respond?: (init: RequestInit) => Promise<Response> }
const cleanup: { dir: string; service: LinkedInService }[] = []
afterEach(async () => {
  for (const c of cleanup.splice(0)) { c.service.stop(); await fs.rm(c.dir, { recursive: true, force: true }) }
})

async function world() {
  const dir = await fs.mkdtemp(join(tmpdir(), 'li-fixture-'))
  const project = join(dir, 'projects', 'fixture')
  await fs.mkdir(join(project, 'versions', 'v1'), { recursive: true })
  await fs.writeFile(join(project, 'project.json'), '{}')
  await fs.writeFile(join(project, 'versions', 'v1', 'export.mp4'), VIDEO)
  const steps: Step[] = []
  const errors: unknown[] = []
  let browser = async (_url: string): Promise<void> => { throw new Error('unexpected browser') }
  const service = new LinkedInService({
    settings: async () => ({ clientId: 'li-client', brokerUrl: BROKER }),
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
      if (step!.respond) return step!.respond(init)
      return new Response(step!.body === undefined ? null : JSON.stringify(step!.body), { status: 200, headers: step!.headers })
    }
  })
  cleanup.push({ dir, service })
  const connect = () => {
    let back = '', state = ''
    steps.push({ url: `${BROKER}/v1/linkedin/start`, method: 'POST', respond: async (init) => {
      const b = JSON.parse(String(init.body))
      back = b.loopback_uri; state = b.state
      const u = new URL('https://www.linkedin.com/oauth/v2/authorization')
      u.search = new URLSearchParams({ response_type: 'code', client_id: 'li-client', redirect_uri: `${BROKER}/v1/linkedin/callback`, scope: 'openid profile w_member_social', state: 'sealed' }).toString()
      return Response.json({ authorize_url: u.toString() })
    } })
    browser = async () => {
      const cb = new URL(back)
      cb.search = new URLSearchParams({ state, handoff: 'sealed-handoff-from-the-service' }).toString()
      expect((await fetch(cb)).status).toBe(200)
    }
    steps.push({ url: `${BROKER}/v1/linkedin/complete`, method: 'POST', body: { access_token: 'li-token', token_type: 'bearer', expires_in: 5_184_000, permissions: ['openid', 'profile', 'w_member_social'] } })
    steps.push({ url: `${LINKEDIN_API}/v2/userinfo`, body: { sub: 'AbC123', name: 'E2E Member' } })
  }
  const upload = () => {
    steps.push({ url: `${LINKEDIN_API}/rest/videos?action=initializeUpload`, method: 'POST', inspect: (init) => {
      const h = new Headers(init.headers)
      expect(h.get('linkedin-version')).toBe('202610')
      expect(h.get('x-restli-protocol-version')).toBe('2.0.0')
      expect(JSON.parse(String(init.body))).toEqual({ initializeUploadRequest: { owner: 'urn:li:person:AbC123', fileSizeBytes: VIDEO.length, uploadCaptions: false, uploadThumbnail: false } })
    }, body: { value: { video: 'urn:li:video:C5505', uploadToken: 'tok', uploadInstructions: [
      { uploadUrl: 'https://www.linkedin.com/dms-uploads/C5505/part1', firstByte: 0, lastByte: SPLIT - 1 },
      { uploadUrl: 'https://www.linkedin.com/dms-uploads/C5505/part2', firstByte: SPLIT, lastByte: VIDEO.length - 1 }
    ] } } })
    for (const [n, part] of [[1, VIDEO.slice(0, SPLIT)], [2, VIDEO.slice(SPLIT)]] as const)
      steps.push({ url: `https://www.linkedin.com/dms-uploads/C5505/part${n}`, method: 'PUT', headers: { etag: `etag-${n}` }, inspect: async (init) => { expect(await new Response(init.body).text()).toBe(part) } })
    steps.push({ url: `${LINKEDIN_API}/rest/videos?action=finalizeUpload`, method: 'POST', inspect: (init) => {
      expect(JSON.parse(String(init.body))).toEqual({ finalizeUploadRequest: { video: 'urn:li:video:C5505', uploadToken: 'tok', uploadedPartIds: ['etag-1', 'etag-2'] } })
    } })
    steps.push({ url: `${LINKEDIN_API}/rest/videos/urn%3Ali%3Avideo%3AC5505`, body: { status: 'PROCESSING' } })
    steps.push({ url: `${LINKEDIN_API}/rest/videos/urn%3Ali%3Avideo%3AC5505`, body: { status: 'AVAILABLE' } })
  }
  return { dir, project, steps, service, connect, upload, done: () => { expect(errors).toEqual([]); expect(steps).toEqual([]) } }
}

const INPUT = { slug: 'fixture', version: 1, text: 'On LinkedIn' }

describe('LinkedIn', () => {
  it('connects, uploads the parts LinkedIn names, and posts the video as the member', async () => {
    const w = await world(); w.connect()
    expect(await w.service.connect()).toEqual({ connected: true, accountId: 'AbC123', name: 'E2E Member', expiresAt: NOW + 5_184_000_000 })
    w.upload()
    w.steps.push({ url: `${LINKEDIN_API}/rest/posts`, method: 'POST', headers: { 'x-restli-id': 'urn:li:share:777' }, inspect: (init) => {
      expect(JSON.parse(String(init.body))).toMatchObject({ author: 'urn:li:person:AbC123', commentary: 'On LinkedIn', content: { media: { id: 'urn:li:video:C5505' } }, lifecycleState: 'PUBLISHED' })
    } })
    const post = await w.service.publish(INPUT)
    expect(post).toEqual({ version: 1, accountId: 'AbC123', postId: 'urn:li:share:777', publishedAt: new Date(NOW).toISOString() })
    const outcomes = JSON.parse(await fs.readFile(join(w.project, 'outcomes.json'), 'utf8'))
    expect(outcomes.versions.v1['linkedin:urn:li:share:777']).toMatchObject({ platform: 'linkedin', apiVersion: '202610' })
    expect(await w.service.publish(INPUT)).toEqual(post); w.done()
  })

  it('never posts again after LinkedIn’s answer to the post was lost, and uploads only to LinkedIn', async () => {
    const w = await world(); w.connect(); await w.service.connect()
    w.upload()
    w.steps.push({ url: `${LINKEDIN_API}/rest/posts`, method: 'POST', respond: async () => { throw new Error('reset') } })
    await expect(w.service.publish(INPUT)).rejects.toMatchObject({ code: 'LI_PUBLISH_UNKNOWN' })
    await expect(w.service.publish(INPUT)).rejects.toMatchObject({ code: 'LI_PUBLISH_UNKNOWN' }); w.done()
    // an upload link anywhere else is refused before a byte is sent
    const v = await world(); v.connect(); await v.service.connect()
    v.steps.push({ url: `${LINKEDIN_API}/rest/videos?action=initializeUpload`, method: 'POST', body: { value: { video: 'urn:li:video:C1', uploadInstructions: [{ uploadUrl: 'https://evil.example/up', firstByte: 0, lastByte: VIDEO.length - 1 }] } } })
    await expect(v.service.publish(INPUT)).rejects.toMatchObject({ code: 'LI_RESPONSE' }); v.done()
  })
})
