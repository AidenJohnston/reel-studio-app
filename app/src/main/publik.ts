// "Use Reel Studio's AI": Sign in with publik, behind the easy-AI flag (main/easy-ai.ts; docs/architecture.md
// section 6, Providers). publik gives an app's users AI with no key of their own, at one OpenAI-compatible address.
// Written from publik's public module (publikhq.com/sdk/publik.ts.md and /skills/api.md, read 2026-11-12):
//   1. this computer gets its own `pk_` key: POST /api/v1/installs with the app's public `pat_` app token;
//   2. the person signs in on publik's claim page in the browser while the app asks GET /api/v1/wallet every 3 s, for
//      at most 10 minutes, until it answers claim_state "claimed";
//   3. with no plan and no balance, publik's top-up page opens and the app waits for AI time the same way;
//   4. the key becomes a saved connection (the AI package's OpenAI-compatible provider, tier model publik-smart), and
//      usage counting starts: app_opened, then active_session every 30 minutes (POST /api/v1/telemetry, no content).
// Differences from publik's module, on purpose: the key lives encrypted with Electron safeStorage in Reel Studio's
// settings folder, not in a plain file in publik's shared folder; usage counting also stops when the person turned
// off usage data in Reel Studio; and the address the key is sent to is always publik's, never one a reply names.
// publik's scan reads this file for the endpoint strings and the slug literal below.
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { dirname } from 'node:path'
import type { GuidedInfo } from '../shared/api'

/** The listing's slug on publik. Double quotes: publik's scan looks for this exact form. Unconfirmed: Sam names it. */
export const APP_SLUG = "reel-studio"
export const PUBLIK_ORIGIN = 'https://publikhq.com'
/** publik-smart: in our testing, edits got noticeably worse on cheaper models; publik's tier decides what serves it */
export const PUBLIK_MODEL = 'publik-smart'
export const PUBLIK_LABEL = 'Reel Studio AI'
const INSTALLS = '/api/v1/installs'
const WALLET = '/api/v1/wallet'
const TELEMETRY = '/api/v1/telemetry'
export const POLL_MS = 3_000
export const POLL_LIMIT_MS = 10 * 60_000
export const SESSION_MS = 30 * 60_000

export const PUBLIK_WORDS = {
  connecting: 'Connecting to Reel Studio’s AI.',
  waiting: 'A page opened in your browser. Sign in there, and this finishes on its own.',
  needsPlan: 'Your account needs AI time. Add some on the page that opened, and this finishes on its own.',
  done: 'You’re signed in. Reel Studio’s AI edits your reels now.',
  expired: 'We stopped waiting for the sign-in. Try again when you’re ready.',
  offline: 'Reel Studio’s AI isn’t reachable. Check you’re online, then try again.',
  notReady: 'Reel Studio’s AI isn’t ready in this version yet. Try Sign in with ChatGPT.',
  ended: 'Your Reel Studio AI sign-in ended. Sign in again.',
  failed: 'The sign-in didn’t finish. Try again.',
  stillOn: 'The sign-in stopped, but Reel Studio’s AI is still connected. Use Sign out in Settings to remove it.'
} as const

export interface PublikCredential {
  key: string
  install_id: string
  claim_url: string | null
  /** the saved connection carrying the key (ai saveConnection) */
  connection_id?: string
}

export interface Wallet {
  claim_state: 'anonymous' | 'claimed'
  claim_url: string | null
  plan: { kind: 'none' | 'plan' | 'pack'; label: string | null }
  balance_micros: number
  top_up_url: string
}

export class PublikError extends Error {
  constructor(readonly kind: 'offline' | 'not_ready' | 'revoked' | 'refused', message: string) {
    super(message)
  }
}

/** publik's three calls, typed. A real one (publikApi) and the tests' fake implement it. */
export interface PublikApi {
  provision(prior: PublikCredential | null): Promise<PublikCredential>
  /** 401: the key is gone (null wallet) */
  wallet(key: string): Promise<{ status: number; wallet: Wallet | null }>
  telemetry(event: 'app_opened' | 'active_session', key: string): Promise<void>
}

const OS: Record<string, string> = { darwin: 'macos', win32: 'windows', linux: 'linux' }

/** publik's API at `origin` (tests pass a local server). Only https, or http on 127.0.0.1 in tests. */
export function publikApi(o: {
  origin: string
  appToken: () => string | null
  appVersion: string
  platform: NodeJS.Platform
  arch: string
  /** one random id per computer account for usage counting (publik's telemetry.json rule, kept in our settings) */
  telemetryId: () => Promise<string>
  fetch?: typeof fetch
}): PublikApi {
  const f = o.fetch ?? fetch
  const call = async (path: string, init: RequestInit, ms: number): Promise<Response> => {
    try {
      return await f(o.origin + path, { ...init, redirect: 'error', signal: AbortSignal.timeout(ms) })
    } catch {
      throw new PublikError('offline', PUBLIK_WORDS.offline)
    }
  }
  return {
    async provision(prior) {
      const token = o.appToken()
      if (!token?.startsWith('pat_')) throw new PublikError('not_ready', PUBLIK_WORDS.notReady)
      let installId = prior?.install_id ?? randomUUID()
      for (let attempt = 0; attempt < 2; attempt++) {
        const res = await call(
          INSTALLS,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              app_token: token,
              app_slug: APP_SLUG,
              app_version: o.appVersion,
              os: OS[o.platform] ?? 'linux',
              ...(o.arch === 'arm64' || o.arch === 'x64' ? { arch: o.arch } : {}),
              install_id: installId,
              disclosure_version: 1,
              dialects: ['chat_completions']
            })
          },
          20_000
        )
        const body = (await res.json().catch(() => ({}))) as Record<string, any>
        const key: string | null = typeof body.key === 'string' ? body.key : res.status === 200 ? (prior?.key ?? null) : null
        if ((res.status === 201 || res.status === 200) && key?.startsWith('pk_'))
          return { key, install_id: typeof body.install_id === 'string' ? body.install_id : installId, claim_url: typeof body.claim_url === 'string' ? body.claim_url : null }
        // publik's module: a 200 with no key we hold, or a revoked install, starts a fresh install
        if (res.status === 200 || body.error?.type === 'install_revoked') {
          installId = randomUUID()
          continue
        }
        if (res.status === 401 || res.status === 403) throw new PublikError('not_ready', PUBLIK_WORDS.notReady)
        throw new PublikError('refused', PUBLIK_WORDS.failed)
      }
      throw new PublikError('refused', PUBLIK_WORDS.failed)
    },
    async wallet(key) {
      const res = await call(WALLET, { headers: { authorization: `Bearer ${key}` } }, 15_000)
      const b = (await res.json().catch(() => ({}))) as Record<string, any>
      if (!res.ok || typeof b.claim_state !== 'string') return { status: res.status, wallet: null }
      return {
        status: res.status,
        wallet: {
          claim_state: b.claim_state === 'claimed' ? 'claimed' : 'anonymous',
          claim_url: typeof b.claim_url === 'string' ? b.claim_url : null,
          plan: b.plan && typeof b.plan.kind === 'string' ? b.plan : { kind: 'none', label: null },
          balance_micros: Number(b.balance_micros) || 0,
          top_up_url: typeof b.top_up_url === 'string' ? b.top_up_url : `${o.origin}/wallet`
        }
      }
    },
    async telemetry(event, key) {
      const body = { v: 1, app: APP_SLUG, install_id: await o.telemetryId(), event, app_version: o.appVersion.replace(/^v/i, ''), os: OS[o.platform] ?? 'linux', ...(o.arch === 'arm64' || o.arch === 'x64' ? { arch: o.arch } : {}) }
      // event: 'app_opened' | 'active_session'; never content, never the reel
      await call(TELEMETRY, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify(body) }, 5_000).catch(() => {})
    }
  }
}

/** Only publik's own pages open in the browser (a claim or top-up link from a reply). */
export function publikPage(url: string | null | undefined, origin: string): string | null {
  if (!url) return null
  try {
    const u = new URL(url)
    const o = new URL(origin)
    return u.origin === o.origin ? u.href : null
  } catch {
    return null
  }
}

/**
 * The random id usage counting sends, kept across launches so publik counts a person once a week, not once a launch.
 * publik's module keeps it in publik's shared folder; here it is one file in Reel Studio's settings (not a secret).
 */
export function telemetryIdFile(file: string): () => Promise<string> {
  let id: string | null = null
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
  return async () => {
    if (id) return id
    try {
      const saved = String(JSON.parse(await fs.readFile(file, 'utf8')).install_id).toLowerCase()
      if (UUID.test(saved)) return (id = saved)
    } catch {
      /* none yet */
    }
    const fresh = randomUUID()
    await fs.mkdir(dirname(file), { recursive: true }).catch(() => {})
    await fs.writeFile(file, JSON.stringify({ install_id: fresh }) + '\n', { mode: 0o600 }).catch(() => {})
    return (id = fresh)
  }
}

export interface SecretBox {
  isEncryptionAvailable(): boolean
  encryptString(s: string): Buffer
  decryptString(b: Buffer): string
  getSelectedStorageBackend?(): string
}

/** The credential, encrypted with safeStorage in one file. No keyring (Linux basic_text): this session only. */
export function credentialStore(file: string, box: SecretBox) {
  let memory: PublikCredential | null = null
  const usable = (): boolean => box.isEncryptionAvailable() && box.getSelectedStorageBackend?.() !== 'basic_text'
  return {
    async load(): Promise<PublikCredential | null> {
      if (!usable()) return memory
      try {
        const c = JSON.parse(box.decryptString(await fs.readFile(file))) as PublikCredential
        return typeof c?.key === 'string' && c.key.startsWith('pk_') ? c : null
      } catch {
        return null
      }
    },
    async save(c: PublikCredential): Promise<void> {
      if (!usable()) {
        memory = c
        return
      }
      await fs.mkdir(dirname(file), { recursive: true })
      const tmp = `${file}.${randomUUID().slice(0, 8)}.tmp`
      await fs.writeFile(tmp, box.encryptString(JSON.stringify(c)), { mode: 0o600 })
      await fs.rename(tmp, file)
    },
    async clear(): Promise<void> {
      memory = null
      await fs.rm(file, { force: true })
    }
  }
}
export type CredentialStore = ReturnType<typeof credentialStore>

export interface PublikDeps {
  api: PublikApi
  store: Pick<CredentialStore, 'load' | 'save' | 'clear'>
  origin: string
  openUrl(url: string): void
  /** saves the key as a connection and makes it the editor; resolves with the connection id. Throws `userMessage`. */
  useKey(key: string, connectionId?: string): Promise<string>
  /** removes the connection (sign out) */
  dropKey(connectionId: string): Promise<void>
  /** is that connection still the editor? (a person may have chosen another since) */
  inUse(connectionId: string): Promise<boolean>
  /** usage counting may run: the person didn't turn off usage data, DO_NOT_TRACK isn't set */
  countingAllowed(): Promise<boolean>
  emit(i: GuidedInfo): void
  pollMs?: number
  limitMs?: number
  sessionMs?: number
}

/** one sign-in in flight; `page`: the publik page it opened, for Open the page again */
interface Run {
  ctrl: AbortController
  done: Promise<GuidedInfo>
  page?: string
}

export function createPublikSignIn(deps: PublikDeps) {
  const pollMs = deps.pollMs ?? POLL_MS
  const limitMs = deps.limitMs ?? POLL_LIMIT_MS
  let run: Run | null = null
  let last: GuidedInfo = { route: 'publik', step: 'idle' }
  let timer: ReturnType<typeof setInterval> | null = null
  const emit = (i: Omit<GuidedInfo, 'route'>): GuidedInfo => {
    last = { route: 'publik', ...i }
    deps.emit(last)
    return last
  }

  const sleep = (ms: number, signal: AbortSignal): Promise<boolean> =>
    new Promise((resolve) => {
      if (signal.aborted) return resolve(false)
      const t = setTimeout(() => resolve(true), ms)
      signal.addEventListener('abort', () => (clearTimeout(t), resolve(false)), { once: true })
    })

  /** Asks the wallet until `ok`; false on cancel or after the limit. A wallet that can't be read is asked again. */
  async function until(key: string, ok: (w: Wallet) => boolean, signal: AbortSignal): Promise<'yes' | 'timeout' | 'cancelled'> {
    for (const end = Date.now() + limitMs; Date.now() < end; ) {
      if (!(await sleep(pollMs, signal))) return 'cancelled'
      const r = await deps.api.wallet(key).catch(() => null)
      if (signal.aborted) return 'cancelled'
      if (r?.wallet && ok(r.wallet)) return 'yes'
    }
    return 'timeout'
  }

  // Usage counting. Consent is asked before every event, so turning usage data off in Settings stops the next one;
  // `counting` changes on every start and stop, so a start still waiting on its answer can't run after a stop.
  let counting = 0
  const send = async (event: 'app_opened' | 'active_session', key: string, gen: number): Promise<void> => {
    if (gen === counting && (await deps.countingAllowed()) && gen === counting) await deps.api.telemetry(event, key)
  }
  function startCounting(key: string): void {
    if (timer) return
    const gen = ++counting
    timer = setInterval(() => void send('active_session', key, gen), deps.sessionMs ?? SESSION_MS)
    timer.unref?.()
    void send('app_opened', key, gen)
  }
  function stopCounting(): void {
    counting++
    if (timer) clearInterval(timer)
    timer = null
  }

  const hasTime = (w: Wallet): boolean => w.plan.kind !== 'none' || w.balance_micros > 0
  const failWith = (e: unknown): GuidedInfo => {
    if (e instanceof PublikError) {
      if (e.kind === 'offline') return emit({ step: 'failed', problem: 'offline', message: PUBLIK_WORDS.offline })
      return emit({ step: 'failed', problem: 'failed', message: e.message })
    }
    const said = (e as { userMessage?: unknown } | null)?.userMessage
    return emit({ step: 'failed', problem: 'failed', message: typeof said === 'string' && said ? said : PUBLIK_WORDS.failed })
  }

  async function flow(r: Run): Promise<GuidedInfo> {
    const signal = r.ctrl.signal
    const cancelled = (): GuidedInfo => emit({ step: 'idle', problem: 'cancelled' })
    emit({ step: 'checking', message: PUBLIK_WORDS.connecting })
    try {
      let c = await deps.store.load()
      let w: Wallet | null = null
      for (let attempt = 0; attempt < 2 && !w; attempt++) {
        if (!c) {
          c = await deps.api.provision(null)
          await deps.store.save(c) // the key reaches the encrypted store before anything else uses it
        }
        const got = await deps.api.wallet(c.key)
        if (signal.aborted) return cancelled()
        if (got.status === 401) {
          // the key is gone on publik's side (revoked or deleted): its connection goes too, then a fresh install, once
          if (c.connection_id) await deps.dropKey(c.connection_id)
          await deps.store.clear()
          c = null
          continue
        }
        if (!got.wallet) return emit({ step: 'failed', problem: 'offline', message: PUBLIK_WORDS.offline })
        w = got.wallet
      }
      if (!c || !w) return emit({ step: 'failed', problem: 'failed', message: PUBLIK_WORDS.failed })
      const already = w.claim_state === 'claimed' && hasTime(w)
      if (w.claim_state !== 'claimed') {
        const page = publikPage(w.claim_url ?? c.claim_url, deps.origin) ?? `${deps.origin}/wallet`
        r.page = page
        deps.openUrl(page)
        emit({ step: 'waiting', message: PUBLIK_WORDS.waiting, canReopen: true })
        const got = await until(c.key, (x) => x.claim_state === 'claimed', signal)
        if (got === 'cancelled') return cancelled()
        if (got === 'timeout') return emit({ step: 'failed', problem: 'expired', message: PUBLIK_WORDS.expired })
        w = (await deps.api.wallet(c.key)).wallet ?? w
      }
      if (!hasTime(w)) {
        const page = publikPage(w.top_up_url, deps.origin) ?? `${deps.origin}/wallet`
        r.page = page
        deps.openUrl(page)
        emit({ step: 'waiting', problem: 'needs_plan', message: PUBLIK_WORDS.needsPlan, canReopen: true })
        const got = await until(c.key, hasTime, signal)
        if (got === 'cancelled') return cancelled()
        if (got === 'timeout') return emit({ step: 'failed', problem: 'expired', message: PUBLIK_WORDS.expired })
      }
      if (signal.aborted) return cancelled()
      emit({ step: 'checking', message: PUBLIK_WORDS.connecting })
      const id = await deps.useKey(c.key, c.connection_id)
      // the connection's id is kept before anything else, so Sign out can always find it
      try {
        if (id !== c.connection_id) await deps.store.save({ ...c, connection_id: id })
      } catch (e) {
        // it couldn't be kept (a full disk): nothing could remove this connection later, so it doesn't stay
        try {
          await deps.dropKey(id)
        } catch {
          return emit({ step: 'failed', problem: 'failed', message: PUBLIK_WORDS.stillOn })
        }
        return signal.aborted ? cancelled() : failWith(e)
      }
      if (signal.aborted) {
        // Cancel (or the flag turned off) while the key was being checked or saved: take it back out
        try {
          await deps.dropKey(id)
        } catch {
          return emit({ step: 'failed', problem: 'failed', message: PUBLIK_WORDS.stillOn })
        }
        await deps.store.save({ key: c.key, install_id: c.install_id, claim_url: c.claim_url })
        return cancelled()
      }
      startCounting(c.key)
      return emit({ step: 'done', message: PUBLIK_WORDS.done, ...(already ? { already: true } : {}) })
    } catch (e) {
      if (signal.aborted) return cancelled()
      return failWith(e)
    }
  }

  return {
    status: (): GuidedInfo => last,
    start(): Promise<GuidedInfo> {
      if (run) return run.done
      const r = { ctrl: new AbortController() } as Run
      r.done = flow(r).finally(() => {
        if (run === r) run = null
      })
      run = r
      return r.done
    },
    cancel(): void {
      run?.ctrl.abort()
    },
    reopen(): void {
      if (run?.page) deps.openUrl(run.page)
    },
    /**
     * At start-up: a saved sign-in that is still the editor starts usage counting; one publik no longer knows says so
     * in one sentence (and the connection is removed, so the editor isn't a dead key). Never opens a page.
     */
    async resume(): Promise<GuidedInfo> {
      const c = await deps.store.load()
      if (!c?.connection_id || !(await deps.inUse(c.connection_id))) return last
      const got = await deps.api.wallet(c.key).catch(() => null)
      if (!got) return last // offline at start-up: keep the connection, its own errors say what to do
      if (got.status === 401 || got.wallet?.claim_state === 'anonymous') {
        await deps.dropKey(c.connection_id)
        await deps.store.clear()
        return emit({ step: 'failed', problem: 'signed_out', message: PUBLIK_WORDS.ended })
      }
      startCounting(c.key)
      return last
    },
    /** The way back out: the key and its connection are removed; the next sign-in starts a fresh install. */
    async signOut(): Promise<void> {
      // a sign-in still running finishes (cancelled) first, so it can't save the key again after this
      const running = run
      running?.ctrl.abort()
      await running?.done.catch(() => undefined)
      stopCounting()
      const c = await deps.store.load()
      // if the connection can't be removed, the credential stays, so Sign out can be tried again
      if (c?.connection_id) await deps.dropKey(c.connection_id)
      await deps.store.clear()
      emit({ step: 'idle' })
    },
    stop: stopCounting,
    running: (): boolean => run !== null
  }
}

export type PublikSignIn = ReturnType<typeof createPublikSignIn>
