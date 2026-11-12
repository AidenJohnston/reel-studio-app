// "Sign in with ChatGPT", guided (main/easy-ai.ts, behind the easy-AI flag). One button: the app gets OpenAI's Codex
// app when this computer has none (codex-fetch.ts), then runs Codex's own sign-in through the same connect as the
// ChatGPT row (vendor-connect.ts), so the browser page, the port check and the sign-in with a code stay one piece of
// code. What it adds on top: the download, a code sign-in that starts by itself when the browser one can't open its
// port, and the page opened for the person. Codex keeps its sign-in in its own store; Reel Studio never sees it.
import type { GuidedInfo, VendorInfo } from '../shared/api'
import type { CliStatus } from './vendor-connect'
import { CodexFetchError, FETCH_MESSAGES } from './codex-fetch'

export const CHATGPT_WORDS = {
  looking: 'Looking for ChatGPT on this computer.',
  getting: 'Getting ChatGPT ready on this computer. This takes a minute or two.',
  waiting: 'A ChatGPT page opened in your browser. Sign in there, and this finishes on its own.',
  code: 'Type this code on the ChatGPT page that opened in your browser.',
  checking: 'Checking your ChatGPT sign-in.',
  done: 'You’re signed in. ChatGPT edits your reels now.',
  expired: 'We stopped waiting for the sign-in. Try again when you’re ready.',
  failed: 'The sign-in didn’t finish. Try again.',
  missing: 'ChatGPT couldn’t start on this computer. Try again, or use Other ways below.'
} as const

export interface ChatgptDeps {
  /** a fresh look at Codex (the person's own, else the one the app fetched) */
  status(): Promise<CliStatus>
  /** fetches the pinned Codex package (codex-fetch.ts ensureCodex); resolves with its binary */
  fetchCodex(signal: AbortSignal, onPct: (pct: number) => void): Promise<string>
  /** tells the AI package where the fetched Codex is, so detection finds it */
  useFetched(bin: string): void
  /** vendors.connect('chatgpt') (or its sign-in with a code), with each step it emits */
  connect(code: boolean, onStep: (i: VendorInfo) => void): Promise<VendorInfo>
  cancelConnect(): void
  /** vendors.signInAgain('chatgpt'): Codex opens a fresh page */
  reopen(): boolean
  openUrl(url: string): void
  emit(i: GuidedInfo): void
}

/** one guided sign-in in flight; `code`: the code sign-in's page, once Codex printed it */
interface Run {
  ctrl: AbortController
  done: Promise<GuidedInfo>
  code?: { url: string }
}

export function createGuidedChatgpt(deps: ChatgptDeps) {
  let run: Run | null = null
  let last: GuidedInfo = { route: 'chatgpt', step: 'idle' }
  const emit = (i: Omit<GuidedInfo, 'route'>): GuidedInfo => {
    last = { route: 'chatgpt', ...i }
    deps.emit(last)
    return last
  }
  const cancelled = (): GuidedInfo => emit({ step: 'idle', problem: 'cancelled' })

  /** What the connect said at its end, in this screen's words. */
  const ended = (i: VendorInfo, already: boolean): GuidedInfo | 'use_code' => {
    if (i.step === 'done') return emit({ step: 'done', message: CHATGPT_WORDS.done, ...(already ? { already: true } : {}) })
    if (i.problem === 'cancelled') return cancelled()
    if (i.problem === 'port_busy') return 'use_code'
    if (i.problem === 'sign_in_timeout') return emit({ step: 'failed', problem: 'expired', message: CHATGPT_WORDS.expired })
    if (i.state === 'missing' || i.state === 'broken') return emit({ step: 'failed', problem: 'failed', message: CHATGPT_WORDS.missing })
    return emit({ step: 'failed', problem: 'failed', message: i.message || CHATGPT_WORDS.failed })
  }

  const onStep = (r: Run) => (i: VendorInfo): void => {
    if (r.ctrl.signal.aborted) return
    if (i.step === 'signing_in' && i.deviceCode) {
      if (!r.code) {
        r.code = { url: i.deviceCode.url }
        deps.openUrl(i.deviceCode.url)
      }
      emit({ step: 'waiting', message: CHATGPT_WORDS.code, deviceCode: i.deviceCode })
    } else if (i.step === 'signing_in' && i.signIn !== 'code') emit({ step: 'waiting', message: CHATGPT_WORDS.waiting, canReopen: true })
    else if (i.step === 'checking') emit({ step: 'checking', message: CHATGPT_WORDS.checking })
  }

  async function flow(r: Run): Promise<GuidedInfo> {
    const signal = r.ctrl.signal
    emit({ step: 'checking', message: CHATGPT_WORDS.looking })
    let st = await deps.status()
    if (signal.aborted) return cancelled()
    const already = st.state === 'ready'
    if (st.state === 'missing' || st.state === 'broken') {
      emit({ step: 'getting', pct: 0, message: CHATGPT_WORDS.getting })
      let bin: string
      try {
        bin = await deps.fetchCodex(signal, (pct) => !signal.aborted && emit({ step: 'getting', pct, message: CHATGPT_WORDS.getting }))
      } catch (e) {
        if (signal.aborted || (e instanceof CodexFetchError && e.problem === 'cancelled')) return cancelled()
        const p = e instanceof CodexFetchError ? e.problem : 'failed'
        const problem = p === 'offline' || p === 'disk' ? p : 'failed'
        return emit({ step: 'failed', problem, message: p === 'cancelled' ? FETCH_MESSAGES.failed : FETCH_MESSAGES[p] })
      }
      deps.useFetched(bin)
      st = await deps.status()
      if (signal.aborted) return cancelled()
      if (st.state === 'missing' || st.state === 'broken') return emit({ step: 'failed', problem: 'failed', message: CHATGPT_WORDS.missing })
    }
    let code = false
    for (;;) {
      const i = await deps.connect(code, onStep(r))
      if (signal.aborted) return cancelled()
      const out = ended(i, already)
      if (out !== 'use_code') return out
      // ChatGPT's browser sign-in couldn't open its port (another program, or Windows reserved it): the sign-in with
      // a code needs no port, so it starts by itself instead of asking the person to choose.
      if (code) return emit({ step: 'failed', problem: 'failed', message: CHATGPT_WORDS.failed })
      code = true
    }
  }

  return {
    status: (): GuidedInfo => last,
    /** Starts, or joins the sign-in already running. */
    start(): Promise<GuidedInfo> {
      if (run) return run.done
      const r = { ctrl: new AbortController() } as Run
      r.done = flow(r)
        .catch(() => emit({ step: 'failed', problem: 'failed', message: CHATGPT_WORDS.failed }))
        .finally(() => {
          if (run === r) run = null
        })
      run = r
      return r.done
    },
    cancel(): void {
      if (!run) return
      run.ctrl.abort()
      deps.cancelConnect()
    },
    /** waiting: the browser sign-in opens a fresh page; the code sign-in opens its page again (same code) */
    reopen(): void {
      if (!run) return
      if (run.code) deps.openUrl(run.code.url)
      else deps.reopen()
    },
    running: (): boolean => run !== null
  }
}

export type GuidedChatgpt = ReturnType<typeof createGuidedChatgpt>
