// "Connect Claude" / "Connect ChatGPT": the installer and sign-in runners (vendor-setup.ts) and the flow that strings
// them together (vendor-connect.ts). No real CLI, installer or network: spawn and fetch are fakes.
import { describe, expect, it } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, posix } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import {
  LOGIN_ARGS,
  VendorError,
  assertRunsAFile,
  installPlan,
  runInstall,
  runLogin,
  testVendorEnv,
  testVendorLoginEnv,
  vendorEnv,
  type SpawnFn
} from '../src/main/vendor-setup'
import { MOVED_NOTE, createVendorConnect, type CliStatus, type VendorDeps } from '../src/main/vendor-connect'
import { parseRegPath } from '../src/main/user-path'
import type { VendorInfo } from '../src/shared/api'

// ---- fakes -------------------------------------------------------------------------------------------------------

interface FakeChild extends EventEmitter {
  pid: number
  exitCode: number | null
  stdout: EventEmitter
  stderr: EventEmitter
  killed: boolean
  kill(): boolean
  finish(code: number | null, out?: string): void
}

function fakeSpawn(onSpawn?: (c: FakeChild, cmd: string, args: string[], opts: any) => void) {
  const calls: { cmd: string; args: string[]; opts: any; child: FakeChild }[] = []
  let pid = 4000
  const spawn = ((cmd: string, args: string[], opts: any) => {
    const c = new EventEmitter() as FakeChild
    c.pid = ++pid
    c.exitCode = null
    c.stdout = new EventEmitter()
    c.stderr = new EventEmitter()
    c.killed = false
    c.kill = () => ((c.killed = true), true)
    c.finish = (code, out) => {
      if (out) c.stderr.emit('data', out)
      c.exitCode = code ?? 1
      c.emit('close', code)
    }
    calls.push({ cmd, args, opts, child: c })
    onSpawn?.(c, cmd, args, opts)
    return c as unknown as ChildProcess
  }) as SpawnFn
  return { spawn, calls }
}

const script = (body = '#!/bin/sh\n' + 'echo installing\n'.repeat(30)) => async () => ({
  ok: true,
  status: 200,
  arrayBuffer: async () => new TextEncoder().encode(body).buffer as ArrayBuffer
})

const ENV = { PATH: '/usr/bin', Path: 'C:\\Windows', OPENAI_API_KEY: 'k1', ANTHROPIC_API_KEY: 'k2', HOME: '/Users/p' }
const tmp = () => mkdtempSync(join(tmpdir(), 'rs-vendor-'))

// ---- the installer ------------------------------------------------------------------------------------------------

describe('installing the vendor app: the vendor\'s own script, as a FILE', () => {
  it('Windows: absolute powershell.exe, -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <the file>', () => {
    const p = installPlan('claude', 'win32', 'C:\\Users\\Pat Q\\AppData\\Roaming\\Reel Studio\\vendor-setup', 'C:\\Windows')
    expect(p.url).toBe('https://claude.ai/install.ps1')
    expect(p.cmd).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    expect(p.args).toEqual(['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', 'C:\\Users\\Pat Q\\AppData\\Roaming\\Reel Studio\\vendor-setup\\claude-install.ps1'])
    expect(installPlan('chatgpt', 'win32', 'C:\\d').url).toBe('https://chatgpt.com/codex/install.ps1')
  })

  it('macOS: Anthropic\'s script under bash, OpenAI\'s under sh, each from its file', () => {
    expect(installPlan('claude', 'darwin', '/x')).toMatchObject({ url: 'https://claude.ai/install.sh', cmd: '/bin/bash', args: ['/x/claude-install.sh'] })
    expect(installPlan('chatgpt', 'darwin', '/x')).toMatchObject({ url: 'https://chatgpt.com/codex/install.sh', cmd: '/bin/sh', args: ['/x/chatgpt-install.sh'] })
    expect(() => installPlan('claude', 'linux', '/x')).toThrow(VendorError)
  })

  it('never a download piped into a shell (Defender blocks `irm … | iex` as a trojan): the guard refuses one', () => {
    expect(() => assertRunsAFile({ cmd: 'powershell.exe', args: ['-Command', 'irm https://claude.ai/install.ps1 | iex'] })).toThrow(/refusing/)
    expect(() => assertRunsAFile({ cmd: '/bin/bash', args: ['-c', 'curl -fsSL https://claude.ai/install.sh | bash'] })).toThrow(/refusing/)
    for (const v of ['claude', 'chatgpt'] as const) {
      for (const os of ['win32', 'darwin'] as const) expect(() => assertRunsAFile(installPlan(v, os, os === 'win32' ? 'C:\\Users\\Irma\\x' : '/Users/irma/x'))).not.toThrow()
    }
  })

  it('writes the exact downloaded bytes, runs the file hidden, no API key in its environment; Codex gets CODEX_NON_INTERACTIVE', async () => {
    for (const vendor of ['claude', 'chatgpt'] as const) {
      const dir = tmp()
      const body = '#!/bin/sh\n# héllo\n' + 'echo ok\n'.repeat(40)
      const { spawn, calls } = fakeSpawn((c) => setTimeout(() => c.finish(0), 5))
      await runInstall({ vendor, platform: 'darwin', dir, env: ENV, fetch: script(body), spawn })
      const file = posix.join(dir, `${vendor}-install.sh`) // the plan for macOS joins with /
      expect(readFileSync(file, 'utf8')).toBe(body)
      if (process.platform !== 'win32') expect(statSync(file).mode & 0o111).not.toBe(0)
      expect(calls).toHaveLength(1)
      expect(calls[0].args).toEqual([file])
      expect(calls[0].opts.windowsHide).toBe(true)
      expect(calls[0].opts.env.OPENAI_API_KEY).toBeUndefined()
      expect(calls[0].opts.env.ANTHROPIC_API_KEY).toBeUndefined()
      expect(calls[0].opts.env.HOME).toBe('/Users/p')
      expect(calls[0].opts.env.CODEX_NON_INTERACTIVE).toBe(vendor === 'chatgpt' ? '1' : undefined)
    }
  })

  it('a failed installer, a captive-portal page, no internet: plain words, and the page never runs', async () => {
    const { spawn, calls } = fakeSpawn((c) => setTimeout(() => c.finish(1, 'boom'), 5))
    await expect(runInstall({ vendor: 'claude', platform: 'darwin', dir: tmp(), env: ENV, fetch: script(), spawn })).rejects.toMatchObject({
      code: 'install_failed',
      userMessage: expect.stringContaining("Anthropic's Claude Code app didn't install")
    })
    const html = fakeSpawn()
    await expect(runInstall({ vendor: 'chatgpt', platform: 'darwin', dir: tmp(), env: ENV, fetch: script('<!doctype html><html>' + 'x'.repeat(400)), spawn: html.spawn }))
      .rejects.toMatchObject({ userMessage: expect.stringContaining("couldn't reach OpenAI") })
    expect(html.calls).toHaveLength(0)
    const offline = async () => { throw new Error('getaddrinfo ENOTFOUND') }
    await expect(runInstall({ vendor: 'claude', platform: 'win32', dir: tmp(), env: ENV, fetch: offline, spawn })).rejects.toMatchObject({ userMessage: expect.stringContaining("couldn't reach Anthropic") })
    expect(calls).toHaveLength(1)
  })

  it('too slow: the whole process tree is ended by OUR pid (taskkill /PID n /T /F), never by name', async () => {
    const { spawn, calls } = fakeSpawn((c, cmd) => {
      if (/taskkill/i.test(cmd)) setTimeout(() => calls[0].child.finish(null), 1)
    })
    await expect(runInstall({ vendor: 'claude', platform: 'win32', dir: tmp(), env: ENV, fetch: script(), spawn, timeoutMs: 20, systemRoot: 'C:\\Windows' }))
      .rejects.toMatchObject({ userMessage: expect.stringContaining('took too long') })
    expect(calls[1].cmd).toBe('C:\\Windows\\System32\\taskkill.exe')
    expect(calls[1].args).toEqual(['/PID', String(calls[0].child.pid), '/T', '/F'])
    expect(calls[1].args.join(' ')).not.toMatch(/\/IM/i)
  })

  it('Cancel ends it too', async () => {
    const ctrl = new AbortController()
    const { spawn, calls } = fakeSpawn((c, cmd) => {
      if (/taskkill/i.test(cmd)) setTimeout(() => calls[0].child.finish(null), 1)
    })
    const p = runInstall({ vendor: 'chatgpt', platform: 'win32', dir: tmp(), env: ENV, fetch: script(), spawn, signal: ctrl.signal })
    await new Promise((r) => setTimeout(r, 20))
    ctrl.abort()
    await expect(p).rejects.toMatchObject({ name: 'AbortError' })
    expect(calls[1].args).toContain(String(calls[0].child.pid))
  })
})

// ---- the sign-in ----------------------------------------------------------------------------------------------------

describe('the vendor app\'s own sign-in', () => {
  it('claude auth login --claudeai / codex login, hidden, stdin closed (no code can be pasted through Reel Studio), no API keys', async () => {
    expect(LOGIN_ARGS).toEqual({ claude: ['auth', 'login', '--claudeai'], chatgpt: ['login'] })
    for (const vendor of ['claude', 'chatgpt'] as const) {
      const { spawn, calls } = fakeSpawn((c) => setTimeout(() => c.finish(0), 5))
      const r = await runLogin({ vendor, bin: '/x/bin', env: ENV, platform: 'darwin', spawn })
      expect(r).toEqual({ code: 0 })
      expect(calls[0].cmd).toBe('/x/bin')
      expect(calls[0].args).toEqual(LOGIN_ARGS[vendor])
      expect(calls[0].opts.stdio[0]).toBe('ignore')
      expect(calls[0].opts.windowsHide).toBe(true)
      expect(calls[0].opts.env.OPENAI_API_KEY).toBeUndefined()
      expect(calls[0].opts.env.ANTHROPIC_API_KEY).toBeUndefined()
    }
  })

  it('what the CLI prints (links with the sign-in\'s state) never leaves runLogin', async () => {
    const link = 'https://auth.example/oauth/authorize?state=SECRET_STATE'
    const { spawn } = fakeSpawn((c) => setTimeout(() => (c.stdout.emit('data', link), c.finish(0)), 5))
    const r = await runLogin({ vendor: 'chatgpt', bin: '/x/codex', env: ENV, platform: 'darwin', spawn })
    expect(JSON.stringify(r)).not.toContain('SECRET_STATE')
  })

  it('port 1455 already taken by another sign-in', async () => {
    const { spawn } = fakeSpawn((c) => setTimeout(() => c.finish(1, 'Error: Address already in use (os error 10048)'), 5))
    expect(await runLogin({ vendor: 'chatgpt', bin: '/x/codex', env: ENV, platform: 'win32', spawn })).toEqual({ code: 1, portBusy: true })
  })

  it('aborting ends our process tree and says so', async () => {
    const ctrl = new AbortController()
    const { spawn, calls } = fakeSpawn((c, cmd) => {
      if (/taskkill/i.test(cmd)) setTimeout(() => calls[0].child.finish(null), 1)
    })
    const p = runLogin({ vendor: 'claude', bin: 'C:\\x\\claude.exe', env: ENV, platform: 'win32', spawn, signal: ctrl.signal })
    ctrl.abort()
    expect(await p).toMatchObject({ aborted: true })
    expect(calls[1].args).toEqual(['/PID', String(calls[0].child.pid), '/T', '/F'])
  })
})

describe('environments', () => {
  it('one PATH, whatever its case; no ANTHROPIC_* / OPENAI_*', () => {
    const e = vendorEnv({ Path: 'C:\\a', OPENAI_BASE_URL: 'x', anthropic_api_key: 'y', KEEP: '1' }, { PATH: 'C:\\b' })
    expect(e).toEqual({ KEEP: '1', PATH: 'C:\\b' })
  })

  it('the test switch: a throwaway home, a bare system PATH, both CLIs\' config folders inside it, BROWSER passed through', () => {
    expect(testVendorEnv({ PATH: 'x' }, 'win32')).toBeNull()
    const w = testVendorEnv({ REELSTUDIO_TEST_VENDOR_HOME: 'C:\\t', Path: 'C:\\Users\\me\\.local\\bin', SystemRoot: 'C:\\Windows', REELSTUDIO_TEST_BROWSER: 'C:\\t\\capture.cmd', OPENAI_API_KEY: 'k' }, 'win32')!
    expect(w).toMatchObject({ USERPROFILE: 'C:\\t', HOME: 'C:\\t', LOCALAPPDATA: 'C:\\t\\AppData\\Local', APPDATA: 'C:\\t\\AppData\\Roaming', CLAUDE_CONFIG_DIR: 'C:\\t\\.claude', CODEX_HOME: 'C:\\t\\.codex', BROWSER: 'C:\\t\\capture.cmd' })
    expect(w.PATH).toBe('C:\\Windows\\System32;C:\\Windows;C:\\Windows\\System32\\WindowsPowerShell\\v1.0')
    expect(Object.keys(w).filter((k) => k.toLowerCase() === 'path')).toEqual(['PATH'])
    expect(w.OPENAI_API_KEY).toBeUndefined()
    expect(testVendorEnv({ REELSTUDIO_TEST_VENDOR_HOME: '/tmp/t', PATH: '/opt/homebrew/bin' }, 'darwin')).toMatchObject({ HOME: '/tmp/t', PATH: '/usr/bin:/bin:/usr/sbin:/sbin', CODEX_HOME: '/tmp/t/.codex' })
  })

  it('the test switch, sign-in step: the REAL home stays (the browser opens their own profile), only the config folders are throwaway', () => {
    expect(testVendorLoginEnv({ PATH: 'x' }, 'win32')).toBeNull()
    const base = { REELSTUDIO_TEST_VENDOR_HOME: 'C:\\t', USERPROFILE: 'C:\\Users\\me', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local', Path: 'C:\\real', OPENAI_API_KEY: 'k' }
    const w = testVendorLoginEnv(base, 'win32')!
    expect(w).toMatchObject({ USERPROFILE: 'C:\\Users\\me', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local', Path: 'C:\\real', CLAUDE_CONFIG_DIR: 'C:\\t\\.claude', CODEX_HOME: 'C:\\t\\.codex' })
    expect(w.OPENAI_API_KEY).toBeUndefined()
    expect(testVendorLoginEnv({ REELSTUDIO_TEST_VENDOR_HOME: '/tmp/t', HOME: '/Users/me' }, 'darwin')).toMatchObject({ HOME: '/Users/me', CLAUDE_CONFIG_DIR: '/tmp/t/.claude', CODEX_HOME: '/tmp/t/.codex' })
  })

  it('reads the user PATH and its type from reg query', () => {
    const out = '\r\nHKEY_CURRENT_USER\\Environment\r\n    Path    REG_EXPAND_SZ    C:\\Users\\me\\.local\\bin;%USERPROFILE%\\x\r\n\r\n'
    expect(parseRegPath(out)).toEqual({ type: 'REG_EXPAND_SZ', value: 'C:\\Users\\me\\.local\\bin;%USERPROFILE%\\x' })
    expect(parseRegPath('ERROR: The system was unable to find the specified registry key or value.')).toBeNull()
  })
})

// ---- the flow ---------------------------------------------------------------------------------------------------------

function flow(o: {
  states: CliStatus[]
  install?: (signal: AbortSignal) => Promise<void>
  login?: (signal: AbortSignal, n: number) => Promise<{ code: number | null; portBusy?: boolean; aborted?: boolean }>
  loginTimeoutMs?: number
}) {
  const seen: VendorInfo[] = []
  const selected: string[] = []
  const states = [...o.states]
  let logins = 0
  let installs = 0
  const deps: VendorDeps = {
    status: async () => (states.length > 1 ? states.shift()! : states[0]),
    install: async (_v, signal) => {
      installs++
      await (o.install ?? (async () => undefined))(signal)
    },
    login: async (_v, _bin, signal) => (o.login ?? (async () => ({ code: 0 })))(signal, ++logins),
    select: async (v) => void selected.push(v),
    emit: (i) => void seen.push(i),
    loginTimeoutMs: o.loginTimeoutMs
  }
  return { vc: createVendorConnect(deps), seen, selected, steps: () => seen.map((i) => i.step), counts: () => ({ logins, installs }) }
}
const BIN = '/Users/p/.local/bin/claude'
const missing: CliStatus = { state: 'missing' }
const out: CliStatus = { state: 'signed_out', bin: BIN, version: '2.1.310' }
const ready: CliStatus = { state: 'ready', bin: BIN, version: '2.1.310', plan: 'max' }
const hang = (signal: AbortSignal) => new Promise<{ code: null; aborted: true }>((r) => signal.addEventListener('abort', () => r({ code: null, aborted: true })))

describe('Connect: install if missing, sign in, check, choose', () => {
  it('fresh computer: installing, signing in, checking, done, and only then it becomes the AI editor', async () => {
    const f = flow({ states: [missing, out, ready] })
    const end = await f.vc.connect('claude')
    expect(f.steps()).toEqual(['installing', 'signing_in', 'checking', 'done'])
    expect(end).toMatchObject({ vendor: 'claude', state: 'ready', step: 'done', version: '2.1.310', plan: 'max' })
    expect(f.selected).toEqual(['claude'])
  })

  it('already signed in: no install, no browser, chosen at once', async () => {
    const f = flow({ states: [ready] })
    await f.vc.connect('chatgpt')
    expect(f.steps()).toEqual(['done'])
    expect(f.counts()).toEqual({ logins: 0, installs: 0 })
    expect(f.selected).toEqual(['chatgpt'])
  })

  it('the page never learns where the app is', async () => {
    const f = flow({ states: [missing, out, ready] })
    await f.vc.connect('claude')
    expect(JSON.stringify([...f.seen, await f.vc.status('claude')])).not.toContain(BIN)
  })

  it('install failed: its plain words, no sign-in, nothing chosen', async () => {
    const f = flow({ states: [missing], install: async () => { throw new VendorError('install_failed', 'It did not install.') } })
    expect(await f.vc.connect('claude')).toMatchObject({ step: 'failed', problem: 'install_failed', message: 'It did not install.' })
    expect(f.counts().logins).toBe(0)
    expect(f.selected).toEqual([])
  })

  it('installed but still not found', async () => {
    const f = flow({ states: [missing, missing] })
    expect(await f.vc.connect('chatgpt')).toMatchObject({ step: 'failed', problem: 'not_found_after_install' })
  })

  it('sign-in ended without signing in, port busy, or nobody came back in time', async () => {
    expect(await flow({ states: [out, out], login: async () => ({ code: 1 }) }).vc.connect('claude')).toMatchObject({ problem: 'sign_in_failed', message: "The sign-in didn't finish. Try again." })
    expect(await flow({ states: [out], login: async () => ({ code: 1, portBusy: true }) }).vc.connect('chatgpt')).toMatchObject({ problem: 'port_busy', message: 'Another ChatGPT sign-in is already open. Close it and try again.' })
    const slow = flow({ states: [out], login: hang, loginTimeoutMs: 20 })
    expect(await slow.vc.connect('claude')).toMatchObject({ problem: 'sign_in_timeout' })
    expect(slow.selected).toEqual([])
  })

  it('Cancel before the sign-in even started: it never starts', async () => {
    const f = flow({ states: [out], login: hang })
    const p = f.vc.connect('claude')
    f.vc.cancel('claude')
    expect(await p).toMatchObject({ step: 'idle', problem: 'cancelled' })
    expect(f.counts().logins).toBe(0)
  })

  it('Cancel while the browser page is open: back to the button, nothing chosen', async () => {
    const f = flow({ states: [out], login: hang })
    const p = f.vc.connect('claude')
    await new Promise((r) => setTimeout(r, 5))
    expect(f.vc.running('claude')).toBe(true)
    f.vc.cancel('claude')
    expect(await p).toMatchObject({ step: 'idle', problem: 'cancelled' })
    expect(f.selected).toEqual([])
    expect(f.vc.running('claude')).toBe(false)
  })

  it('"Open the sign-in page again" starts a fresh sign-in (a fresh page), then it finishes', async () => {
    const f = flow({ states: [out, ready], login: (signal, n) => (n === 1 ? hang(signal) : Promise.resolve({ code: 0 })) })
    const p = f.vc.connect('claude')
    await new Promise((r) => setTimeout(r, 5))
    expect(f.vc.signInAgain('claude')).toBe(true)
    expect(await p).toMatchObject({ step: 'done' })
    expect(f.counts().logins).toBe(2)
    expect(f.steps()).toEqual(['signing_in', 'signing_in', 'checking', 'done'])
  })

  it('a Claude plan the app reports as free is never chosen', async () => {
    const f = flow({ states: [out, { ...ready, plan: 'free' }] })
    expect(await f.vc.connect('claude')).toMatchObject({ step: 'failed', problem: 'free_plan', message: expect.stringContaining('Claude Pro or Max') })
    expect(f.selected).toEqual([])
  })

  it('choosing ChatGPT stops a Claude sign-in that is still waiting', async () => {
    const seen: VendorInfo[] = []
    const vc = createVendorConnect({
      status: async (v) => (v === 'claude' ? out : ready),
      install: async () => undefined,
      login: async (_v, _b, signal) => hang(signal),
      select: async () => undefined,
      emit: (i) => void seen.push(i)
    })
    const claude = vc.connect('claude')
    await new Promise((r) => setTimeout(r, 5))
    await vc.connect('chatgpt')
    expect(await claude).toMatchObject({ vendor: 'claude', step: 'idle', problem: 'cancelled' })
  })

  it('a second click while it runs joins the same connect', async () => {
    const f = flow({ states: [out], login: hang })
    const a = f.vc.connect('claude')
    const b = f.vc.connect('claude')
    await new Promise((r) => setTimeout(r, 5))
    f.vc.cancel('claude')
    expect(await a).toBe(await b)
    expect(f.counts().logins).toBe(1)
  })

  it('the old in-app ChatGPT sign-in was retired: the ChatGPT card says why, until it is connected', async () => {
    const f = flow({ states: [{ state: 'missing', chatgptMoved: true }] })
    expect(await f.vc.status('chatgpt')).toMatchObject({ step: 'idle', message: MOVED_NOTE })
    expect((await f.vc.status('claude')).message).toBeUndefined()
  })
})
