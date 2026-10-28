// "Connect Claude" / "Connect ChatGPT": one click installs the person's own AI app if it is missing, starts its own
// sign-in in the browser, checks it worked and makes it the AI editor. The page only ever learns
// {vendor, state, step, version, plan kind, message, problem}: never a path, an account, a link or a code.
import type { VendorInfo, VendorProblem, VendorStep } from '../shared/api'
import { VendorError, type LoginResult, type Vendor } from './vendor-setup'

export interface CliStatus {
  state: 'missing' | 'broken' | 'signed_out' | 'ready'
  bin?: string
  version?: string
  plan?: string
  reason?: string
  chatgptMoved?: boolean
}

export interface VendorDeps {
  status(v: Vendor): Promise<CliStatus>
  install(v: Vendor, signal: AbortSignal): Promise<void>
  login(v: Vendor, bin: string, signal: AbortSignal): Promise<LoginResult>
  /** makes it the AI editor (ai.setActive) */
  select(v: Vendor): Promise<void>
  emit(info: VendorInfo): void
  log?(line: string): void
  /** how long a sign-in may wait in the browser (default 10 minutes) */
  loginTimeoutMs?: number
}

export const LOGIN_TIMEOUT_MS = 10 * 60_000

const APP: Record<Vendor, string> = { claude: 'Claude Code app', chatgpt: 'Codex app' }

export const VENDOR_MESSAGES: Record<Exclude<VendorProblem, 'install_failed' | 'cancelled'>, (v: Vendor) => string> = {
  not_found_after_install: (v) => `Your ${APP[v]} installed, but we can't find it. Click Check again, or install it yourself.`,
  sign_in_failed: () => "The sign-in didn't finish. Try again.",
  sign_in_timeout: () => "We stopped waiting for the sign-in. Try again when you're ready.",
  port_busy: () => 'Another ChatGPT sign-in is already open. Close it and try again.',
  free_plan: () => "You're signed in, but your Claude plan doesn't include the Claude Code app. It needs Claude Pro or Max."
}

export const MOVED_NOTE = "ChatGPT now connects through OpenAI's Codex app. Click Connect ChatGPT once."

interface Run {
  ctrl: AbortController
  login?: AbortController
  restart?: boolean
  done: Promise<VendorInfo>
}

export function createVendorConnect(deps: VendorDeps) {
  const runs = new Map<Vendor, Run>()
  const last = new Map<Vendor, VendorInfo>()

  const info = (v: Vendor, st: CliStatus, step: VendorStep, extra: Partial<VendorInfo> = {}): VendorInfo => ({
    vendor: v,
    state: st.state,
    step,
    ...(st.version ? { version: st.version } : {}),
    ...(st.plan ? { plan: st.plan } : {}),
    ...(v === 'chatgpt' && st.chatgptMoved && st.state !== 'ready' && step === 'idle' ? { message: MOVED_NOTE } : {}),
    ...extra
  })
  const emit = (i: VendorInfo): VendorInfo => {
    last.set(i.vendor, i)
    deps.emit(i)
    return i
  }
  const fail = (v: Vendor, st: CliStatus, problem: VendorProblem, message: string): VendorInfo => emit(info(v, st, 'failed', { problem, message }))

  async function flow(v: Vendor, run: Run): Promise<VendorInfo> {
    const signal = run.ctrl.signal
    let st = await deps.status(v)
    if (st.state === 'missing' || st.state === 'broken') {
      emit(info(v, st, 'installing'))
      try {
        await deps.install(v, signal)
      } catch (e) {
        if (signal.aborted) return emit(info(v, st, 'idle', { problem: 'cancelled' }))
        const err = e instanceof VendorError ? e : null
        deps.log?.(`[vendor] ${v} install failed: ${err?.detail ?? String((e as Error)?.message ?? e)}`.slice(0, 1500))
        return fail(v, st, 'install_failed', err?.userMessage ?? `Your ${APP[v]} didn't install. Try again, or install it yourself.`)
      }
      st = await deps.status(v)
      if (st.state === 'missing' || st.state === 'broken') return fail(v, st, 'not_found_after_install', VENDOR_MESSAGES.not_found_after_install(v))
    }
    while (st.state === 'signed_out') {
      if (signal.aborted) return emit(info(v, st, 'idle', { problem: 'cancelled' }))
      if (!st.bin) return fail(v, st, 'not_found_after_install', VENDOR_MESSAGES.not_found_after_install(v))
      emit(info(v, st, 'signing_in'))
      run.restart = false
      const login = (run.login = new AbortController())
      const timeout = setTimeout(() => login.abort(), deps.loginTimeoutMs ?? LOGIN_TIMEOUT_MS)
      const onCancel = (): void => login.abort()
      signal.addEventListener('abort', onCancel, { once: true })
      let r: LoginResult
      try {
        r = await deps.login(v, st.bin, login.signal)
      } finally {
        clearTimeout(timeout)
        signal.removeEventListener('abort', onCancel)
        run.login = undefined
      }
      if (signal.aborted) return emit(info(v, st, 'idle', { problem: 'cancelled' }))
      if (run.restart) continue // "Open the sign-in page again": a fresh sign-in, which opens a fresh page
      if (r.aborted) return fail(v, st, 'sign_in_timeout', VENDOR_MESSAGES.sign_in_timeout(v))
      if (r.portBusy) return fail(v, st, 'port_busy', VENDOR_MESSAGES.port_busy(v))
      emit(info(v, st, 'checking'))
      st = await deps.status(v)
      if (st.state !== 'ready') return fail(v, st, 'sign_in_failed', VENDOR_MESSAGES.sign_in_failed(v))
    }
    if (signal.aborted) return emit(info(v, st, 'idle', { problem: 'cancelled' }))
    if (st.state !== 'ready') return fail(v, st, 'sign_in_failed', VENDOR_MESSAGES.sign_in_failed(v))
    // Anthropic's own page already stops a free account (it never comes back); this catches a plan it lets through.
    if (v === 'claude' && st.plan?.toLowerCase() === 'free') return fail(v, st, 'free_plan', VENDOR_MESSAGES.free_plan(v))
    await deps.select(v)
    return emit(info(v, st, 'done'))
  }

  return {
    /** A fresh look, plus the step of a connect in progress. */
    async status(v: Vendor): Promise<VendorInfo> {
      const running = runs.get(v)
      if (running) return last.get(v)!
      const st = await deps.status(v)
      return info(v, st, 'idle')
    },
    /** Installs if needed, signs in, selects. One at a time per vendor; starting one vendor stops the other. */
    connect(v: Vendor): Promise<VendorInfo> {
      const current = runs.get(v)
      if (current) return current.done
      const other: Vendor = v === 'claude' ? 'chatgpt' : 'claude'
      runs.get(other)?.ctrl.abort()
      const run = { ctrl: new AbortController() } as Run
      run.done = flow(v, run)
        .catch((e) => {
          deps.log?.(`[vendor] ${v} connect: ${String((e as Error)?.message ?? e)}`)
          return emit({ vendor: v, state: 'missing', step: 'failed', problem: 'sign_in_failed', message: VENDOR_MESSAGES.sign_in_failed(v) })
        })
        .finally(() => {
          if (runs.get(v) === run) runs.delete(v)
        })
      runs.set(v, run)
      return run.done
    },
    /** Stops an install or a waiting sign-in. */
    cancel(v: Vendor): void {
      runs.get(v)?.ctrl.abort()
    },
    /** Restarts a waiting sign-in, so the CLI opens a fresh page. */
    signInAgain(v: Vendor): boolean {
      const run = runs.get(v)
      if (!run?.login) return false
      run.restart = true
      run.login.abort()
      return true
    },
    running(v: Vendor): boolean {
      return runs.has(v)
    }
  }
}

export type VendorConnect = ReturnType<typeof createVendorConnect>
