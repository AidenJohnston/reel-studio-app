// Installs the person's own AI app (Anthropic's Claude Code app, OpenAI's Codex app) and starts its OWN sign-in.
// Reel Studio never sees the sign-in: the vendor's CLI opens the vendor's page in the browser and catches the answer
// itself (on 127.0.0.1); the app only learns "the process ended" and then asks the CLI "signed in or not?".
//
// Install = the vendor's own install script, downloaded to a FILE and run hidden. Never a `irm … | iex` or
// `curl … | bash` command line: Microsoft Defender flags that one-liner as Trojan:Win32/Commando.A!ml and blocks it
// (measured 2026-10-25). The same script run as a file was not flagged.
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { posix, win32 } from 'node:path'

export type Vendor = 'claude' | 'chatgpt'

/** Where each vendor publishes its installer (the commands on their own install pages, fetched by us instead). */
export const INSTALL_SCRIPTS: Record<Vendor, { mac: string; win: string }> = {
  claude: { mac: 'https://claude.ai/install.sh', win: 'https://claude.ai/install.ps1' },
  chatgpt: { mac: 'https://chatgpt.com/codex/install.sh', win: 'https://chatgpt.com/codex/install.ps1' }
}


const VENDOR_NAME: Record<Vendor, string> = { claude: 'Anthropic', chatgpt: 'OpenAI' }
const APP_NAME: Record<Vendor, string> = { claude: "Anthropic's Claude Code app", chatgpt: "OpenAI's Codex app" }

export const INSTALL_TIMEOUT_MS = 10 * 60_000

export class VendorError extends Error {
  constructor(
    readonly code: 'install_failed' | 'unsupported',
    readonly userMessage: string,
    /** for main.log only (install output holds no secret); never sent to the page */
    readonly detail?: string
  ) {
    super(userMessage)
  }
}

export type SpawnFn = (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess

export interface Plan {
  url: string
  fileName: string
  cmd: string
  args: string[]
}

/** The command that runs a downloaded installer FILE. */
export function installPlan(vendor: Vendor, platform: NodeJS.Platform, dir: string, systemRoot = 'C:\\Windows'): Plan {
  if (platform === 'win32') {
    const file = win32.join(dir, `${vendor}-install.ps1`)
    return {
      url: INSTALL_SCRIPTS[vendor].win,
      fileName: file,
      cmd: win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file]
    }
  }
  if (platform === 'darwin') {
    const file = posix.join(dir, `${vendor}-install.sh`)
    // Anthropic's script is bash; OpenAI's is POSIX sh (as their own pages run them)
    return { url: INSTALL_SCRIPTS[vendor].mac, fileName: file, cmd: vendor === 'claude' ? '/bin/bash' : '/bin/sh', args: [file] }
  }
  throw new VendorError('unsupported', 'Reel Studio can install it for you on a Mac or a Windows PC only.')
}

/** Refuses any command line that pipes a download into a shell. A guard, so a later edit cannot bring it back. */
export function assertRunsAFile(plan: Pick<Plan, 'cmd' | 'args'>): void {
  const line = [plan.cmd, ...plan.args].join(' ')
  if (/\|\s*(iex|invoke-expression|bash|sh|zsh)\b|\b(irm|iwr|invoke-webrequest|invoke-restmethod|curl|wget)\b|https?:\/\//i.test(line)) {
    throw new Error(`refusing to run a download-and-pipe command line: ${line}`)
  }
}

/** The environment for a vendor installer or CLI: no ANTHROPIC_* / OPENAI_* (a stray API key must never pick the
 * account), every case-variant of the same name collapsed, plus `extra`. */
export function vendorEnv(base: NodeJS.ProcessEnv, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(base)) if (!/^(ANTHROPIC_|OPENAI_)/i.test(k)) out[k] = v
  for (const [k, v] of Object.entries(extra)) {
    for (const old of Object.keys(out)) if (old.toLowerCase() === k.toLowerCase()) delete out[old]
    if (v !== undefined) out[k] = v
  }
  return out
}

/** Ends a process and everything it started (PowerShell's downloads, a login's helper). Only OUR pid, never by name. */
export function killTree(child: ChildProcess, platform: NodeJS.Platform, spawn: SpawnFn = nodeSpawn, systemRoot = 'C:\\Windows'): void {
  if (child.pid === undefined || child.exitCode !== null) return
  try {
    if (platform === 'win32') {
      spawn(win32.join(systemRoot, 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    } else {
      process.kill(-child.pid, 'SIGTERM') // the child leads its own process group (detached)
    }
  } catch {
    try {
      child.kill()
    } catch {
      /* already gone */
    }
  }
}

export interface InstallDeps {
  vendor: Vendor
  platform: NodeJS.Platform
  /** <userData>/vendor-setup */
  dir: string
  env: NodeJS.ProcessEnv
  fetch: (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer> }>
  spawn?: SpawnFn
  signal?: AbortSignal
  timeoutMs?: number
  systemRoot?: string
  log?: (line: string) => void
}

/** Downloads the vendor's installer to a file and runs it hidden. Resolves when it exits 0. */
export async function runInstall(d: InstallDeps): Promise<void> {
  const plan = installPlan(d.vendor, d.platform, d.dir, d.systemRoot)
  assertRunsAFile(plan)
  const cantReach = `${APP_NAME[d.vendor]} didn't install: this computer couldn't reach ${VENDOR_NAME[d.vendor]}. Check your internet, then try again.`
  let bytes: Buffer
  try {
    const res = await d.fetch(plan.url, { signal: d.signal })
    if (!res.ok) throw new VendorError('install_failed', cantReach, `GET ${plan.url} -> ${res.status}`)
    bytes = Buffer.from(await res.arrayBuffer())
  } catch (e) {
    if (d.signal?.aborted) throw e
    if (e instanceof VendorError) throw e
    throw new VendorError('install_failed', cantReach, String((e as Error)?.message ?? e))
  }
  // A captive portal or an error page is not an installer.
  const head = bytes.subarray(0, 200).toString('utf8').trimStart()
  if (bytes.length < 200 || head.startsWith('<')) throw new VendorError('install_failed', cantReach, `GET ${plan.url}: not a script (${bytes.length} bytes)`)
  await mkdir(d.dir, { recursive: true })
  await writeFile(plan.fileName, bytes) // the exact bytes (no re-encoding: PowerShell reads them as published)
  if (d.platform !== 'win32') await chmod(plan.fileName, 0o755)
  d.log?.(`[vendor] installing ${d.vendor}: ${plan.cmd} ${plan.args.join(' ')}`)

  const spawn = d.spawn ?? nodeSpawn
  const env = vendorEnv(d.env, d.vendor === 'chatgpt' ? { CODEX_NON_INTERACTIVE: '1' } : {})
  await new Promise<void>((resolve, reject) => {
    let tail = ''
    let timedOut = false
    const child = spawn(plan.cmd, plan.args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], detached: d.platform !== 'win32' })
    const keep = (b: Buffer | string): void => {
      tail = (tail + String(b)).slice(-4000)
    }
    child.stdout?.on('data', keep)
    child.stderr?.on('data', keep)
    const stop = (): void => killTree(child, d.platform, spawn, d.systemRoot)
    const timer = setTimeout(() => {
      timedOut = true
      stop()
    }, d.timeoutMs ?? INSTALL_TIMEOUT_MS)
    d.signal?.addEventListener('abort', stop, { once: true })
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(new VendorError('install_failed', `${APP_NAME[d.vendor]} didn't install. Try again, or install it yourself.`, String(e?.message ?? e)))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      d.signal?.removeEventListener('abort', stop)
      d.log?.(`[vendor] ${d.vendor} installer exited ${code}${timedOut ? ' (timed out)' : ''}: ${tail.replace(/\s+/g, ' ').slice(-600)}`)
      if (d.signal?.aborted) return reject(Object.assign(new Error('cancelled'), { name: 'AbortError' }))
      if (code === 0) return resolve()
      reject(
        new VendorError(
          'install_failed',
          timedOut
            ? `${APP_NAME[d.vendor]} took too long to install. Try again, or install it yourself.`
            : `${APP_NAME[d.vendor]} didn't install. Your antivirus or your company's settings may have stopped it. Try again, or install it yourself.`,
          tail
        )
      )
    })
  })
}

export const LOGIN_ARGS: Record<Vendor, string[]> = {
  // --claudeai: the Claude subscription sign-in, never the Console (API billing) one
  claude: ['auth', 'login', '--claudeai'],
  chatgpt: ['login']
}

export interface LoginResult {
  code: number | null
  /** another sign-in already holds the callback port (Codex uses 127.0.0.1:1455) */
  portBusy?: boolean
  aborted?: boolean
}

const PORT_BUSY = /address already in use|address in use|os error 10048|os error 48\b|only one usage of each socket/i

/**
 * Runs the CLI's own sign-in, hidden. It opens the vendor's page in the browser and waits for the answer on 127.0.0.1.
 * Its output (links carrying the sign-in's state) stays in this function: it is never sent to the page or the log.
 * stdin is closed, so a sign-in code can never be pasted through Reel Studio.
 */
export function runLogin(d: { vendor: Vendor; bin: string; env: NodeJS.ProcessEnv; platform: NodeJS.Platform; signal?: AbortSignal; spawn?: SpawnFn; systemRoot?: string }): Promise<LoginResult> {
  const spawn = d.spawn ?? nodeSpawn
  return new Promise((resolve) => {
    let out = ''
    const child = spawn(d.bin, LOGIN_ARGS[d.vendor], { env: vendorEnv(d.env), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], detached: d.platform !== 'win32' })
    const keep = (b: Buffer | string): void => {
      out = (out + String(b)).slice(-8000)
    }
    child.stdout?.on('data', keep)
    child.stderr?.on('data', keep)
    const stop = (): void => killTree(child, d.platform, spawn, d.systemRoot)
    if (d.signal?.aborted) stop()
    d.signal?.addEventListener('abort', stop, { once: true })
    child.on('error', () => resolve({ code: -1 }))
    child.on('close', (code) => {
      d.signal?.removeEventListener('abort', stop)
      if (d.signal?.aborted) return resolve({ code, aborted: true })
      resolve({ code, ...(code !== 0 && PORT_BUSY.test(out) ? { portBusy: true } : {}) })
    })
  })
}

/** Test switch REELSTUDIO_TEST_VENDOR_HOME: the vendor CLIs see a throwaway home (a fresh machine: nothing installed,
 * nobody signed in) and a bare system PATH, so a real install + sign-in can be tried without touching the developer's
 * own Claude Code and Codex apps. REELSTUDIO_TEST_BROWSER passes BROWSER through (Claude honours it). */
export function testVendorEnv(base: NodeJS.ProcessEnv, platform: NodeJS.Platform): NodeJS.ProcessEnv | null {
  const home = base.REELSTUDIO_TEST_VENDOR_HOME
  if (!home) return null
  const sr = base.SystemRoot || base.SYSTEMROOT || 'C:\\Windows'
  const path = platform === 'win32' ? [win32.join(sr, 'System32'), sr, win32.join(sr, 'System32', 'WindowsPowerShell', 'v1.0')].join(';') : '/usr/bin:/bin:/usr/sbin:/sbin'
  const P = platform === 'win32' ? win32 : posix
  return vendorEnv(base, {
    HOME: home,
    USERPROFILE: home,
    LOCALAPPDATA: P.join(home, 'AppData', 'Local'),
    APPDATA: P.join(home, 'AppData', 'Roaming'),
    CLAUDE_CONFIG_DIR: P.join(home, '.claude'),
    CODEX_HOME: P.join(home, '.codex'),
    ZDOTDIR: home,
    PATH: path,
    ...(base.REELSTUDIO_TEST_BROWSER ? { BROWSER: base.REELSTUDIO_TEST_BROWSER } : {})
  })
}
