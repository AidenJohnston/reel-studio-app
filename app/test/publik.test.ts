// "Use Reel Studio's AI": Sign in with publik (main/publik.ts). publikApi is checked against a local server speaking
// publik's documented calls; the sign-in itself runs against an in-memory publik the test drives.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, readFileSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GuidedInfo } from '../src/shared/api'
import { APP_SLUG, createPublikSignIn, credentialStore, publikApi, PUBLIK_WORDS, PublikError, type PublikApi, type PublikCredential, type SecretBox, type Wallet } from '../src/main/publik'

// ---- publik's calls on the wire -------------------------------------------------------------------------------------

let server: Server
let origin = ''
const seen: { path: string; auth?: string; body: any }[] = []
let installStatus = 201

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null
    seen.push({ path: req.url!, auth: req.headers.authorization, body })
    const json = (s: number, o: unknown) => res.writeHead(s, { 'content-type': 'application/json' }).end(JSON.stringify(o))
    if (req.url === '/api/v1/installs') return installStatus === 201 ? json(201, { key: 'pk_live_wire', install_id: body.install_id, claim_url: `${origin}/claim/abc` }) : json(installStatus, { error: { message: 'bad token' } })
    if (req.url === '/api/v1/wallet') return req.headers.authorization === 'Bearer pk_live_wire' ? json(200, { claim_state: 'claimed', claim_url: null, plan: { kind: 'none', label: null }, balance_micros: 50000, top_up_url: `${origin}/top-up` }) : json(401, { error: { type: 'invalid_api_key' } })
    if (req.url === '/api/v1/telemetry') return json(202, {})
    res.writeHead(404).end()
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})
afterAll(() => new Promise((r) => server.close(r)))

const api = (token: string | null = 'pat_public_token') =>
  publikApi({ origin, appToken: () => token, appVersion: '0.4.0', platform: 'win32', arch: 'x64', telemetryId: async () => '0f8fad5b-d9cb-469f-a165-70867728950e' })

describe("publik's calls", () => {
  it('fails if this computer is set up without the app token and slug, or a key that is not pk_ is accepted', async () => {
    seen.length = 0
    const c = await api().provision(null)
    expect(c).toMatchObject({ key: 'pk_live_wire', claim_url: `${origin}/claim/abc` })
    expect(seen[0]).toMatchObject({ path: '/api/v1/installs', body: { app_token: 'pat_public_token', app_slug: APP_SLUG, os: 'windows', arch: 'x64', install_id: c.install_id, dialects: ['chat_completions'] } })
    expect((await api().wallet('pk_live_wire')).wallet).toMatchObject({ claim_state: 'claimed', balance_micros: 50000 })
    expect((await api().wallet('pk_live_gone')).status).toBe(401)
  })

  it('fails if a build with no app token, or one publik refuses, calls publik or says anything but that it is not ready', async () => {
    seen.length = 0
    const none = await api(null).provision(null).catch((e) => e)
    expect(none).toBeInstanceOf(PublikError)
    expect(none.message).toBe(PUBLIK_WORDS.notReady)
    expect(seen).toEqual([])
    installStatus = 401
    expect((await api().provision(null).catch((e) => e)).message).toBe(PUBLIK_WORDS.notReady)
    installStatus = 201
  })

  it('fails if usage counting sends anything but the event, the app and an id, or skips the key', async () => {
    seen.length = 0
    await api().telemetry('app_opened', 'pk_live_wire')
    expect(seen).toEqual([{ path: '/api/v1/telemetry', auth: 'Bearer pk_live_wire', body: { v: 1, app: APP_SLUG, install_id: '0f8fad5b-d9cb-469f-a165-70867728950e', event: 'app_opened', app_version: '0.4.0', os: 'windows', arch: 'x64' } }])
  })

  it('fails if publik being unreachable is not told apart from publik saying no', async () => {
    const off = publikApi({ origin: 'http://127.0.0.1:9', appToken: () => 'pat_x', appVersion: '1', platform: 'darwin', arch: 'arm64', telemetryId: async () => 'x' })
    const e = await off.provision(null).catch((x) => x)
    expect([e.kind, e.message]).toEqual(['offline', PUBLIK_WORDS.offline])
  })
})

// ---- the sign-in ----------------------------------------------------------------------------------------------------

const ORIGIN = 'https://publikhq.com'
const wallet = (w: Partial<Wallet> = {}): Wallet => ({ claim_state: 'anonymous', claim_url: `${ORIGIN}/claim/k1`, plan: { kind: 'none', label: null }, balance_micros: 0, top_up_url: `${ORIGIN}/top-up`, ...w })

function publik(o: { claimed?: boolean; balance?: number; revoked?: string[]; offline?: boolean; claimUrl?: string; stored?: PublikCredential; counting?: boolean; sessionMs?: number; slowSave?: Promise<void>; dropFails?: boolean | (() => boolean); saveFails?: (c: PublikCredential) => boolean } = {}) {
  const s = { claimed: !!o.claimed, balance: o.balance ?? 0, provisions: 0, events: [] as string[], revoked: new Set(o.revoked ?? []), counting: o.counting ?? true, saving: false }
  const fake: PublikApi = {
    async provision() {
      if (o.offline) throw new PublikError('offline', PUBLIK_WORDS.offline)
      s.provisions++
      return { key: `pk_live_${s.provisions}`, install_id: `i${s.provisions}`, claim_url: o.claimUrl ?? `${ORIGIN}/claim/k${s.provisions}` }
    },
    async wallet(key) {
      if (s.revoked.has(key)) return { status: 401, wallet: null }
      return { status: 200, wallet: wallet({ claim_state: s.claimed ? 'claimed' : 'anonymous', claim_url: null, balance_micros: s.balance }) }
    },
    async telemetry(event) {
      s.events.push(event)
    }
  }
  let saved: PublikCredential | null = o.stored ?? null
  const used: { key: string; id?: string }[] = []
  const dropped: string[] = []
  const opened: string[] = []
  const steps: GuidedInfo[] = []
  let active: string | null = o.stored?.connection_id ?? null
  const sign = createPublikSignIn({
    api: fake,
    store: {
      load: async () => saved,
      save: async (c) => {
        if (o.saveFails?.(c)) throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' })
        saved = c
      },
      clear: async () => void (saved = null)
    },
    origin: ORIGIN,
    openUrl: (u) => opened.push(u),
    async useKey(key, id) {
      used.push({ key, ...(id ? { id } : {}) })
      s.saving = true
      await o.slowSave
      return (active = id ?? 'c_publik')
    },
    async dropKey(id) {
      if (typeof o.dropFails === 'function' ? o.dropFails() : o.dropFails) throw { code: 'locked', userMessage: 'Close other apps, then try again.' }
      dropped.push(id)
      if (active === id) active = null
    },
    ownConnections: async () => (active ? [active] : []),
    inUse: async (id) => active === id,
    countingAllowed: async () => s.counting,
    emit: (i) => steps.push(i),
    pollMs: 2,
    limitMs: 60,
    sessionMs: o.sessionMs ?? 60_000
  })
  return { s, sign, used, dropped, opened, steps, saved: () => saved }
}

const until = async (ok: () => boolean): Promise<void> => {
  for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 2))
  expect(ok()).toBe(true)
}

describe('Sign in with publik', () => {
  it('fails if a new person is not sent to the sign-in page, waited for, and connected with this computer’s key', async () => {
    const t = publik({ balance: 50_000 })
    const done = t.sign.start()
    await until(() => t.steps.some((s) => s.step === 'waiting'))
    expect(t.opened).toEqual([`${ORIGIN}/claim/k1`])
    expect(t.steps.at(-1)).toMatchObject({ step: 'waiting', message: PUBLIK_WORDS.waiting, canReopen: true })
    expect(t.saved()?.key).toBe('pk_live_1') // kept before anything uses it
    t.s.claimed = true
    expect(await done).toMatchObject({ route: 'publik', step: 'done', message: PUBLIK_WORDS.done })
    expect((await done).already).toBeUndefined()
    expect(t.used).toEqual([{ key: 'pk_live_1' }])
    expect(t.saved()).toMatchObject({ key: 'pk_live_1', connection_id: 'c_publik' })
    await until(() => t.s.events.length > 0)
    expect(t.s.events).toEqual(['app_opened'])
  })

  it('fails if someone already signed in with AI time is sent to a page again', async () => {
    const t = publik({ claimed: true, balance: 1, stored: { key: 'pk_live_old', install_id: 'i0', claim_url: null } })
    expect(await t.sign.start()).toMatchObject({ step: 'done', already: true })
    expect(t.opened).toEqual([])
    expect(t.s.provisions).toBe(0)
    expect(t.used).toEqual([{ key: 'pk_live_old' }])
  })

  it('fails if Cancel while waiting connects anything', async () => {
    const t = publik()
    const done = t.sign.start()
    await until(() => t.steps.some((s) => s.step === 'waiting'))
    t.sign.cancel()
    expect(await done).toMatchObject({ step: 'idle', problem: 'cancelled' })
    t.s.claimed = true
    expect(t.used).toEqual([])
  })

  it('fails if a sign-in nobody finishes waits forever or is reported as a failure of the app', async () => {
    const t = publik()
    expect(await t.sign.start()).toMatchObject({ step: 'failed', problem: 'expired', message: PUBLIK_WORDS.expired })
    expect(t.used).toEqual([])
  })

  it('fails if no network is not said as no network', async () => {
    const t = publik({ offline: true })
    expect(await t.sign.start()).toMatchObject({ step: 'failed', problem: 'offline', message: PUBLIK_WORDS.offline })
  })

  it('fails if an account with no AI time is connected, or not sent to add some and waited for', async () => {
    const t = publik({ claimed: true, stored: { key: 'pk_live_old', install_id: 'i0', claim_url: null } })
    const done = t.sign.start()
    await until(() => t.steps.some((s) => s.problem === 'needs_plan'))
    expect(t.opened).toEqual([`${ORIGIN}/top-up`])
    expect(t.used).toEqual([])
    t.s.balance = 50_000
    expect(await done).toMatchObject({ step: 'done' })
  })

  it('fails if a key publik no longer knows is kept instead of starting a fresh install, once', async () => {
    const t = publik({ claimed: true, balance: 1, revoked: ['pk_live_old'], stored: { key: 'pk_live_old', install_id: 'i0', claim_url: null, connection_id: 'c_old' } })
    expect(await t.sign.start()).toMatchObject({ step: 'done' })
    expect(t.dropped).toEqual(['c_old']) // the dead key's connection doesn't stay behind
    expect(t.s.provisions).toBe(1)
    expect(t.used).toEqual([{ key: 'pk_live_1' }])
  })

  it('fails if a claim link to another site is opened in the browser', async () => {
    const t = publik({ claimUrl: 'https://evil.example/claim', balance: 1 })
    const done = t.sign.start()
    await until(() => t.opened.length > 0)
    expect(t.opened).toEqual([`${ORIGIN}/wallet`])
    t.sign.cancel()
    await done
  })

  it('fails if a sign-in that ended while the app was closed stays the editor, or is not said in one sentence', async () => {
    const t = publik({ revoked: ['pk_live_old'], stored: { key: 'pk_live_old', install_id: 'i0', claim_url: null, connection_id: 'c_publik' } })
    expect(await t.sign.resume()).toMatchObject({ step: 'failed', problem: 'signed_out', message: PUBLIK_WORDS.ended })
    expect(t.dropped).toEqual(['c_publik'])
    expect(t.saved()).toBeNull()
  })

  it('fails if Sign out keeps the key or the connection, or if counting runs when the person said no to usage data', async () => {
    const t = publik({ claimed: true, balance: 1, counting: false })
    expect(await t.sign.start()).toMatchObject({ step: 'done' })
    await new Promise((r) => setTimeout(r, 10))
    expect(t.s.events).toEqual([])
    await t.sign.signOut()
    expect(t.dropped).toEqual(['c_publik'])
    expect(t.saved()).toBeNull()
  })
})

describe('Sign in with publik: stopping part way', () => {
  it('fails if Cancel while the key is being saved leaves Reel Studio’s AI connected', async () => {
    let release: () => void = () => {}
    const t = publik({ claimed: true, balance: 1, slowSave: new Promise<void>((r) => (release = r)) })
    const done = t.sign.start()
    await until(() => t.s.saving)
    t.sign.cancel()
    release()
    expect(await done).toMatchObject({ step: 'idle', problem: 'cancelled' })
    expect(t.dropped).toEqual(['c_publik'])
    expect(t.saved()?.connection_id).toBeUndefined()
    await new Promise((r) => setTimeout(r, 10))
    expect(t.s.events).toEqual([])
  })

  it('fails if turning usage data off after signing in does not stop the next event', async () => {
    const t = publik({ claimed: true, balance: 1, sessionMs: 5 })
    expect(await t.sign.start()).toMatchObject({ step: 'done' })
    await until(() => t.s.events.length >= 2)
    t.s.counting = false
    const sent = t.s.events.length
    await new Promise((r) => setTimeout(r, 30))
    expect(t.s.events.length).toBe(sent)
    t.sign.stop()
  })

  it('fails if a Cancel whose undo fails forgets the connection Sign out must remove, or says it was cancelled', async () => {
    let release: () => void = () => {}
    const t = publik({ claimed: true, balance: 1, slowSave: new Promise<void>((r) => (release = r)), dropFails: true })
    const done = t.sign.start()
    await until(() => t.s.saving)
    t.sign.cancel()
    release()
    expect(await done).toMatchObject({ step: 'failed', message: PUBLIK_WORDS.stillOn })
    expect(t.saved()?.connection_id).toBe('c_publik')
  })
})

describe('Sign in with publik: a credential that cannot be saved', () => {
  it('fails if a connection whose id could not be kept stays connected where Sign out can never reach it', async () => {
    // the disk fills between saving the install's key and saving the connection's id
    const t = publik({ claimed: true, balance: 1, saveFails: (c) => !!c.connection_id })
    expect(await t.sign.start()).toMatchObject({ step: 'failed', problem: 'failed' })
    expect(t.dropped).toEqual(['c_publik'])
    expect(t.used).toHaveLength(1)
  })

  it('fails if Sign out cannot remove a connection whose id was never kept and whose removal failed once', async () => {
    let failing = true
    const t = publik({ claimed: true, balance: 1, saveFails: (c) => !!c.connection_id, dropFails: () => failing })
    expect(await t.sign.start()).toMatchObject({ step: 'failed', message: PUBLIK_WORDS.stillOn })
    expect(t.saved()?.connection_id).toBeUndefined()
    failing = false
    await t.sign.signOut()
    expect(t.dropped).toEqual(['c_publik'])
  })
})

describe('where the key is kept', () => {
  const box = (backend = 'dpapi'): SecretBox => ({
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => backend,
    encryptString: (s) => Buffer.from(Buffer.from(s).map((b) => b ^ 0x5a)),
    decryptString: (b) => Buffer.from(b.map((x) => x ^ 0x5a)).toString()
  })
  const cred: PublikCredential = { key: 'pk_live_secret_123', install_id: 'i1', claim_url: 'https://publikhq.com/claim/x' }

  it('fails if the key reaches the disk readable, or does not come back after a restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'publik-'))
    const file = join(dir, 'publik.bin')
    await credentialStore(file, box()).save(cred)
    expect(readFileSync(file).toString('utf8')).not.toContain('pk_live')
    expect(readdirSync(dir)).toEqual(['publik.bin']) // no temp file left
    expect(await credentialStore(file, box()).load()).toEqual(cred)
    await credentialStore(file, box()).clear()
    expect(existsSync(file)).toBe(false)
  })

  it('fails if a computer with no keyring writes the key to a file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'publik-'))
    const s = credentialStore(join(dir, 'publik.bin'), box('basic_text'))
    await s.save(cred)
    expect(readdirSync(dir)).toEqual([])
    expect(await s.load()).toEqual(cred) // this session only
  })
})
