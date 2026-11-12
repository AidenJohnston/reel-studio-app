// "Sign in with ChatGPT", guided (main/guided-chatgpt.ts), through the real ChatGPT connect (vendor-connect.ts), wired
// the way easy-ai.ts wires them. Codex itself is a fake: its status and its sign-in's ending are the test's.
import { describe, expect, it } from 'vitest'
import type { GuidedInfo, VendorInfo } from '../src/shared/api'
import { createGuidedChatgpt, CHATGPT_WORDS } from '../src/main/guided-chatgpt'
import { CodexFetchError, FETCH_MESSAGES } from '../src/main/codex-fetch'
import { createVendorConnect, type CliStatus } from '../src/main/vendor-connect'
import type { DeviceCode, LoginResult } from '../src/main/vendor-setup'

type Login = (signal: AbortSignal, onDeviceCode?: (c: DeviceCode) => void) => Promise<LoginResult>

function world(o: { state: CliStatus['state']; login?: Login; fetchFails?: CodexFetchError }) {
  let state = o.state
  let fetched: string | null = null
  const steps: GuidedInfo[] = []
  const opened: string[] = []
  const logins: { code: boolean }[] = []
  const selected: string[] = []
  let fetches = 0
  let listener: ((i: VendorInfo) => void) | null = null
  const status = async (): Promise<CliStatus> => (state === 'missing' && fetched ? { state: (state = 'signed_out'), bin: fetched } : { state, ...(state === 'missing' ? {} : { bin: '/codex' }) })
  const vendors = createVendorConnect({
    status: async () => status(),
    async login(_v, _bin, signal, onDeviceCode) {
      logins.push({ code: !!onDeviceCode })
      const r = await (o.login ?? (async () => ({ code: 0 })))(signal, onDeviceCode)
      if (r.code === 0) state = 'ready'
      return r
    },
    async select(v) {
      selected.push(v)
    },
    emit: (i) => listener?.(i)
  })
  const g = createGuidedChatgpt({
    status,
    async fetchCodex(signal, onPct) {
      fetches++
      onPct(40)
      if (o.fetchFails) throw o.fetchFails
      if (signal.aborted) throw new CodexFetchError('cancelled', 'Stopped.')
      return '/app/codex/bin/codex'
    },
    useFetched: (bin) => (fetched = bin),
    async connect(code, onStep) {
      listener = (i) => i.vendor === 'chatgpt' && onStep(i)
      try {
        return code ? await vendors.signInWithCode('chatgpt') : await vendors.connect('chatgpt')
      } finally {
        listener = null
      }
    },
    cancelConnect: () => vendors.cancel('chatgpt'),
    reopen: () => vendors.signInAgain('chatgpt'),
    openUrl: (u) => opened.push(u),
    emit: (i) => steps.push(i)
  })
  return { g, steps, opened, logins, selected, fetches: () => fetches, kinds: () => steps.map((s) => s.step) }
}

/** a browser sign-in that waits for the person until `finish` (or the abort) */
function waitingLogin() {
  let finish: (r: LoginResult) => void = () => {}
  const login: Login = (signal) =>
    new Promise((resolve) => {
      finish = resolve
      signal.addEventListener('abort', () => resolve({ code: null, aborted: true }), { once: true })
    })
  return { login, finish: (r: LoginResult) => finish(r) }
}

const until = async (ok: () => boolean): Promise<void> => {
  for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 5))
  expect(ok()).toBe(true)
}

describe('Sign in with ChatGPT, guided', () => {
  it('fails if a computer with no Codex is not got ready, signed in and made the editor in one press', async () => {
    const w = waitingLogin()
    const t = world({ state: 'missing', login: w.login })
    const done = t.g.start()
    await until(() => t.kinds().includes('waiting'))
    // the download's progress shows while it runs, from 0
    expect(t.steps.filter((s) => s.step === 'getting').map((s) => [s.pct, s.message])).toEqual([
      [0, CHATGPT_WORDS.getting],
      [40, CHATGPT_WORDS.getting]
    ])
    expect(t.steps.at(-1)).toMatchObject({ step: 'waiting', message: CHATGPT_WORDS.waiting, canReopen: true })
    w.finish({ code: 0 })
    expect(await done).toMatchObject({ route: 'chatgpt', step: 'done', message: CHATGPT_WORDS.done })
    expect((await done).already).toBeUndefined()
    expect(t.selected).toEqual(['chatgpt'])
    expect(t.fetches()).toBe(1)
  })

  it('fails if a ChatGPT already signed in on this computer opens a sign-in or downloads anything', async () => {
    const t = world({ state: 'ready' })
    expect(await t.g.start()).toMatchObject({ step: 'done', already: true })
    expect(t.logins).toEqual([])
    expect(t.fetches()).toBe(0)
    expect(t.selected).toEqual(['chatgpt'])
  })

  it('fails if Cancel while the browser page is open leaves a sign-in running or makes ChatGPT the editor', async () => {
    const w = waitingLogin()
    const t = world({ state: 'signed_out', login: w.login })
    const done = t.g.start()
    await until(() => t.kinds().includes('waiting'))
    t.g.cancel()
    expect(await done).toMatchObject({ step: 'idle', problem: 'cancelled' })
    expect(t.selected).toEqual([])
    expect(t.g.running()).toBe(false)
  })

  it('fails if a sign-in that timed out is not told apart from one that failed', async () => {
    const t = world({ state: 'signed_out', login: async () => ({ code: null, aborted: true }) })
    expect(await t.g.start()).toMatchObject({ step: 'failed', problem: 'expired', message: CHATGPT_WORDS.expired })
    const f = world({ state: 'signed_out', login: async () => ({ code: 1 }) })
    expect(await f.g.start()).toMatchObject({ step: 'failed', problem: 'failed' })
    expect(f.selected).toEqual([])
  })

  it('fails if a failed download tries to sign in, or does not say what to do', async () => {
    const t = world({ state: 'missing', fetchFails: new CodexFetchError('offline', FETCH_MESSAGES.offline) })
    expect(await t.g.start()).toMatchObject({ step: 'failed', problem: 'offline', message: FETCH_MESSAGES.offline })
    expect(t.logins).toEqual([])
  })

  it('fails if a browser sign-in that cannot open its port asks the person to choose instead of showing a code on its own', async () => {
    const code = { url: 'https://auth.openai.com/codex/device', code: 'AB12-CD34E' }
    let gotCode = false
    const t = world({
      state: 'signed_out',
      login: async (_s, onDeviceCode) => {
        if (!onDeviceCode) return { code: 1, portBusy: true, portReserved: true }
        onDeviceCode(code)
        gotCode = true
        return { code: 0 }
      }
    })
    expect(await t.g.start()).toMatchObject({ step: 'done' })
    expect(gotCode).toBe(true)
    expect(t.logins).toEqual([{ code: false }, { code: true }])
    expect(t.steps.find((s) => s.deviceCode)).toMatchObject({ step: 'waiting', deviceCode: code, message: CHATGPT_WORDS.code })
    expect(t.opened).toEqual([code.url]) // OpenAI's page opens for her, once
  })
})
