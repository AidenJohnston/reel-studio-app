// The guided AI setup, behind one flag that is off by default (docs/architecture.md section 6, Providers): "Sign in
// with ChatGPT" (guided-chatgpt.ts, with codex-fetch.ts when Codex is missing) and "Use Reel Studio's AI" (publik.ts).
// The flag is Settings › Advanced › "Easier AI sign-in", or REELSTUDIO_EASY_AI=1 (0 forces it off). Off, nothing here
// runs: every channel but ai:easyStatus refuses, no Codex is fetched or looked for in the app's folder, and the Connect
// screen is today's. Whether it should be on by default is Sam's call (bring-your-own-AI is the product's rule).
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { EasyAiInfo, GuidedInfo, GuidedRoute, VendorInfo } from '../shared/api'
import { ensureCodex, installedCodex, type CodexPackage } from './codex-fetch'
import { createGuidedChatgpt } from './guided-chatgpt'
import { createPublikSignIn, credentialStore, publikApi, PUBLIK_LABEL, PUBLIK_MODEL, PUBLIK_ORIGIN, telemetryIdFile, type SecretBox } from './publik'
import type { VendorConnect, CliStatus } from './vendor-connect'

/** On when the setting is on or REELSTUDIO_EASY_AI=1; REELSTUDIO_EASY_AI=0 turns it off whatever the setting says. */
export function easyAiOn(saved: boolean | undefined, env: NodeJS.ProcessEnv): boolean {
  if (env.REELSTUDIO_EASY_AI === '0') return false
  return env.REELSTUDIO_EASY_AI === '1' || saved === true
}

/** Test switches, honoured only in a test run of an unpackaged app. */
export interface EasyAiTest {
  /** a local publik (e2e/easy-ai.spec.ts) */
  publikOrigin?: string
  publikToken?: string
  /** a local Codex package and its hash */
  codexPackage?: CodexPackage
}

export function easyAiTest(env: NodeJS.ProcessEnv, allowed: boolean): EasyAiTest {
  if (!allowed) return {}
  let codexPackage: CodexPackage | undefined
  try {
    const p = env.REELSTUDIO_TEST_CODEX_PACKAGE ? JSON.parse(env.REELSTUDIO_TEST_CODEX_PACKAGE) : null
    if (p && typeof p.url === 'string' && /^[0-9a-f]{64}$/.test(p.sha256)) codexPackage = { asset: 'test.tar.gz', url: p.url, sha256: p.sha256, bytes: Number(p.bytes) || 1 }
  } catch {
    /* not a test package */
  }
  return {
    ...(env.REELSTUDIO_TEST_PUBLIK_ORIGIN?.startsWith('http://127.0.0.1:') ? { publikOrigin: env.REELSTUDIO_TEST_PUBLIK_ORIGIN } : {}),
    ...(env.REELSTUDIO_TEST_PUBLIK_TOKEN ? { publikToken: env.REELSTUDIO_TEST_PUBLIK_TOKEN } : {}),
    ...(codexPackage ? { codexPackage } : {})
  }
}

/** publik's public app token, packaged next to the app (publik-app-token.txt), when this build has one. */
function packagedToken(dirs: string[]): string | null {
  for (const d of dirs) {
    const f = join(d, 'publik-app-token.txt')
    if (existsSync(f)) {
      const t = readFileSync(f, 'utf8').trim()
      if (t.startsWith('pat_')) return t
    }
  }
  return null
}

export interface EasyAiDeps {
  handle(channel: string, fn: (e: unknown, ...args: any[]) => unknown): void
  env: NodeJS.ProcessEnv
  test: EasyAiTest
  /** the saved setting (main/settings.ts easyAi) */
  saved(): Promise<boolean>
  save(on: boolean): Promise<void>
  userData: string
  settingsDir: string
  /** folders publik-app-token.txt may sit in (process.resourcesPath, the app folder) */
  tokenDirs: string[]
  secrets: SecretBox
  appVersion: string
  platform: NodeJS.Platform
  arch: string
  vendors: () => VendorConnect
  codexStatus(): Promise<CliStatus>
  ai: {
    saveConnection(c: { id?: string; label: string; kind: 'openai'; baseURL: string; model: string; key: string }): Promise<{ status: { connected: boolean }; connection?: { id: string }; error?: { code?: string; userMessage: string } }>
    removeConnection(id: string): Promise<void>
    connections(): Promise<{ id: string; baseURL: string }[]>
    active(): Promise<{ id: string; connected: boolean; connectionId?: string }>
  }
  /** usage data is on in Reel Studio (the person didn't turn it off) */
  usageAllowed(): Promise<boolean>
  openExternal(url: string): void
  broadcast(channel: string, payload: unknown): void
  aiChanged(): void
  log(line: string): void
}

export function setupEasyAi(d: EasyAiDeps) {
  let on = false
  const ready = d.saved().then(
    (s) => (on = easyAiOn(s, d.env)),
    () => (on = easyAiOn(false, d.env))
  )
  const codexDir = join(d.userData, 'codex')
  const origin = d.test.publikOrigin ?? PUBLIK_ORIGIN
  const appToken = (): string | null => d.test.publikToken ?? packagedToken(d.tokenDirs)
  const emit = (i: GuidedInfo): void => d.broadcast('ai:guided', i)

  const codexPlace = { dir: codexDir, platform: d.platform, arch: d.arch, ...(d.test.codexPackage ? { pkg: d.test.codexPackage } : {}) }
  let fetched: string | null = null
  // the vendor connect's steps reach whichever guided sign-in is listening (index.ts createVendors emit)
  let listener: ((i: VendorInfo) => void) | null = null

  const chatgpt = createGuidedChatgpt({
    status: () => d.codexStatus(),
    fetchCodex: (signal, onPct) => ensureCodex({ ...codexPlace, systemRoot: d.env.SystemRoot }, signal, onPct),
    useFetched: (bin) => {
      fetched = bin
      d.log('[easy-ai] Codex fetched into the app folder')
    },
    async connect(code, onStep) {
      listener = (i) => {
        if (i.vendor === 'chatgpt') onStep(i)
      }
      try {
        return code ? await d.vendors().signInWithCode('chatgpt') : await d.vendors().connect('chatgpt')
      } finally {
        listener = null
      }
    },
    cancelConnect: () => d.vendors().cancel('chatgpt'),
    reopen: () => d.vendors().signInAgain('chatgpt'),
    openUrl: d.openExternal,
    emit
  })

  const publik = createPublikSignIn({
    api: publikApi({ origin, appToken, appVersion: d.appVersion, platform: d.platform, arch: d.arch, telemetryId: telemetryIdFile(join(d.settingsDir, 'publik-telemetry.json')) }),
    store: credentialStore(join(d.settingsDir, 'publik.bin'), d.secrets),
    origin,
    openUrl: d.openExternal,
    async useKey(key, connectionId) {
      const save = (id?: string) => d.ai.saveConnection({ ...(id ? { id } : {}), label: PUBLIK_LABEL, kind: 'openai', baseURL: `${origin}/api/v1`, model: PUBLIK_MODEL, key })
      let r = await save(connectionId)
      // the connection was removed by hand (Settings › Advanced): save a new one instead of failing every time
      if (connectionId && r.error?.code === 'connection_gone') r = await save()
      d.aiChanged()
      if (!r.status.connected || !r.connection) throw { userMessage: r.error?.userMessage || 'Reel Studio’s AI didn’t answer. Try again.' }
      return r.connection.id
    },
    async dropKey(id) {
      try {
        await d.ai.removeConnection(id)
      } finally {
        d.aiChanged()
      }
    },
    async ownConnections() {
      const base = `${origin}/api/v1`.replace(/\/+$/, '')
      return (await d.ai.connections()).filter((c) => c.baseURL.replace(/\/+$/, '') === base).map((c) => c.id)
    },
    async inUse(id) {
      const a = await d.ai.active()
      return a.id === 'custom' && a.connected && a.connectionId === id
    },
    async countingAllowed() {
      const dnt = (d.env.DO_NOT_TRACK ?? '').trim().toLowerCase()
      if (dnt && dnt !== '0' && dnt !== 'false') return false
      if (['0', 'false', 'off'].includes((d.env.PUBLIK_TELEMETRY ?? '').trim().toLowerCase())) return false
      return d.usageAllowed()
    },
    emit
  })

  const refuse = { code: 'NOT_AVAILABLE', userMessage: 'This way to connect isn’t turned on.' }
  const routeOf = (r: unknown): GuidedRoute => (r === 'publik' ? 'publik' : 'chatgpt')
  const guarded =
    (fn: (route: GuidedRoute) => unknown) =>
    async (_e: unknown, r: unknown): Promise<unknown> => {
      await ready
      if (!on) throw refuse
      return await fn(routeOf(r))
    }
  const info = async (): Promise<EasyAiInfo> => {
    await ready
    const last = publik.status()
    return { on, publik: on && !!appToken(), ...(on && last.problem === 'signed_out' ? { publikNotice: last } : {}) }
  }

  d.handle('ai:easyStatus', () => info())
  // Settings › Advanced: the flag's own switch, the way in and the way back out
  d.handle('ai:setEasyAi', async (_e, v: unknown) => {
    await ready
    await d.save(v === true)
    on = easyAiOn(v === true, d.env)
    if (!on) {
      chatgpt.cancel()
      publik.cancel()
      publik.stop()
    }
    return info()
  })
  d.handle(
    'ai:guidedStart',
    guarded((r) => {
      if (r === 'publik' && !appToken()) throw { code: 'NOT_AVAILABLE', userMessage: 'Reel Studio’s AI isn’t ready in this version yet. Try Sign in with ChatGPT.' }
      // one guided sign-in at a time: starting one stops the other
      if (r === 'publik') {
        chatgpt.cancel()
        return publik.start()
      }
      publik.cancel()
      return chatgpt.start()
    })
  )
  d.handle('ai:guidedStatus', guarded((r) => (r === 'publik' ? publik.status() : chatgpt.status())))
  d.handle('ai:guidedCancel', guarded((r) => (r === 'publik' ? publik.cancel() : chatgpt.cancel())))
  d.handle('ai:guidedReopen', guarded((r) => (r === 'publik' ? publik.reopen() : chatgpt.reopen())))
  d.handle('ai:guidedSignOut', guarded((r) => (r === 'publik' ? publik.signOut() : undefined)))

  return {
    /** the vendor connect's steps, for the guided ChatGPT sign-in that started it */
    onVendor(i: VendorInfo): void {
      listener?.(i)
    },
    /** the Codex the app fetched, while the flag is on (the AI package's detection looks here last) */
    managedCodex(): string | null {
      if (!on) return null
      return fetched ?? installedCodex(codexPlace)
    },
    /** at start-up, after the AI is loaded: a saved publik sign-in starts counting, or says it ended */
    async resume(): Promise<void> {
      await ready
      if (on && appToken()) await publik.resume().catch((e) => d.log(`[easy-ai] publik resume: ${String((e as Error)?.message ?? e)}`))
    },
    info
  }
}

export type EasyAi = ReturnType<typeof setupEasyAi>
