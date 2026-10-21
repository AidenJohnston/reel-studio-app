// Runs `python -m reelengine <command> ...` and speaks the JSON-lines protocol (docs/architecture.md section 4).
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { killTree } from './proctree'

export interface EngineProgress {
  stage: string
  pct: number
  message: string
}

export interface EngineError {
  code: string
  userMessage: string
  message?: string
}

export type EngineEvent =
  | { event: 'progress'; stage: string; pct: number; message: string }
  | { event: 'done'; result: unknown }
  | { event: 'error'; code: string; message?: string; userMessage: string }

/** Splits a byte stream into complete UTF-8 lines. Handles chunks that cut a line or a character. */
export class LineSplitter {
  private decoder = new StringDecoder('utf8')
  private buf = ''
  constructor(private onLine: (line: string) => void) {}
  push(chunk: Buffer | string): void {
    this.buf += typeof chunk === 'string' ? chunk : this.decoder.write(chunk)
    let i: number
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).replace(/\r$/, '')
      this.buf = this.buf.slice(i + 1)
      if (line.trim()) this.onLine(line)
    }
  }
  end(): void {
    this.buf += this.decoder.end()
    const rest = this.buf.replace(/\r$/, '')
    this.buf = ''
    if (rest.trim()) this.onLine(rest)
  }
}

/** Parses one stdout line. Returns null for anything that is not a protocol event. */
export function parseEngineLine(line: string): EngineEvent | null {
  let obj: unknown
  try {
    obj = JSON.parse(line)
  } catch {
    return null
  }
  if (!obj || typeof obj !== 'object') return null
  const o = obj as Record<string, unknown>
  switch (o.event) {
    case 'progress': {
      const pct = typeof o.pct === 'number' && isFinite(o.pct) ? Math.max(0, Math.min(100, o.pct)) : 0
      return {
        event: 'progress',
        stage: String(o.stage ?? ''),
        pct,
        message: typeof o.message === 'string' ? o.message : ''
      }
    }
    case 'done':
      return { event: 'done', result: o.result ?? null }
    case 'error':
      return {
        event: 'error',
        code: String(o.code ?? 'ENGINE_ERROR'),
        message: typeof o.message === 'string' ? o.message : undefined,
        userMessage:
          typeof o.userMessage === 'string' && o.userMessage
            ? o.userMessage
            : GENERIC_ERROR
      }
    default:
      return null
  }
}

export const GENERIC_ERROR =
  'Something went wrong while working on your video. Please try again. If it keeps happening, restart Reel Studio.'
export const MISSING_ENGINE =
  'Reel Studio is missing a part it needs to edit videos. Please reinstall the app.'

export interface RunnerConfig {
  python: () => string
  env: () => NodeJS.ProcessEnv
  cwd?: () => string
  log?: (line: string) => void
  /** Called with the engine's pid right after it starts (tests use this). */
  onSpawn?: (pid: number) => void
  /** Called when that engine process has exited. */
  onExit?: (pid: number) => void
}

const running = new Set<ChildProcess>()

/** Kills every engine process this runner started. Used when the app quits. */
export async function killAllEngines(): Promise<void> {
  await Promise.all([...running].map((c) => (c.pid ? killTree(c.pid) : Promise.resolve())))
}

export function createEngineRunner(cfg: RunnerConfig) {
  return function runEngine(
    command: string,
    args: string[],
    onProgress?: (p: EngineProgress) => void,
    signal?: AbortSignal
  ): Promise<unknown> {
    return new Promise((resolvePromise, rejectPromise) => {
      if (signal?.aborted) {
        rejectPromise(cancelled())
        return
      }
      const log = cfg.log ?? (() => {})
      let settled = false
      let result: { ok: true; value: unknown } | { ok: false; err: EngineError } | null = null
      const stderrTail: string[] = []

      // Isolated from the user's Python setup: -s no user site-packages, -E ignore
      // PYTHON* variables (a stale PYTHONHOME breaks start-up), -X utf8 + -u replace PYTHONUTF8 and
      // PYTHONUNBUFFERED (ignored under -E), -B replaces PYTHONDONTWRITEBYTECODE (no .pyc written into
      // the install). `-m` puts the cwd first on sys.path, so cwd = the folder
      // holding our `reelengine` package, never wherever Electron was started.
      const env = cfg.env()
      const cwd = cfg.cwd?.() ?? env.PYTHONPATH?.split(delimiter)[0]
      const child = spawn(cfg.python(), ['-s', '-E', '-B', '-X', 'utf8', '-u', '-m', 'reelengine', command, ...args], {
        env,
        cwd: cwd && existsSync(cwd) ? cwd : undefined,
        windowsHide: true,
        // Own process group on macOS/Linux so cancel can kill grandchildren (ffmpeg).
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe']
      })
      running.add(child)
      if (child.pid) cfg.onSpawn?.(child.pid)

      const finish = (fn: () => void): void => {
        if (settled) return
        settled = true
        running.delete(child)
        signal?.removeEventListener('abort', onAbort)
        fn()
      }

      const onAbort = (): void => {
        if (child.pid) void killTree(child.pid)
        finish(() => rejectPromise(cancelled()))
      }
      signal?.addEventListener('abort', onAbort, { once: true })

      const out = new LineSplitter((line) => {
        const ev = parseEngineLine(line)
        if (!ev) {
          log(`[engine ${command} stdout] ${line}`)
          return
        }
        if (ev.event === 'progress') onProgress?.({ stage: ev.stage, pct: ev.pct, message: ev.message })
        else if (ev.event === 'done') result = { ok: true, value: ev.result }
        else result = { ok: false, err: { code: ev.code, userMessage: ev.userMessage, message: ev.message } }
      })
      const err = new LineSplitter((line) => {
        log(`[engine ${command}] ${line}`)
        stderrTail.push(line)
        if (stderrTail.length > 30) stderrTail.shift()
      })
      child.stdout!.on('data', (c: Buffer) => out.push(c))
      child.stderr!.on('data', (c: Buffer) => err.push(c))

      child.on('error', (e: NodeJS.ErrnoException) => {
        finish(() =>
          rejectPromise({
            code: e.code === 'ENOENT' ? 'ENGINE_MISSING' : 'ENGINE_START_FAILED',
            userMessage: MISSING_ENGINE,
            message: `${cfg.python()}: ${e.message}`
          } satisfies EngineError)
        )
      })
      child.on('close', (code, exitSignal) => {
        if (child.pid) cfg.onExit?.(child.pid)
        out.end()
        err.end()
        log(`[engine ${command}] closed exitCode=${code} signal=${exitSignal ?? 'none'}`)
        finish(() => {
          const r = result as typeof result
          if (exitSignal) {
            rejectPromise({
              code: 'ENGINE_CRASHED',
              userMessage: GENERIC_ERROR,
              message: `signal ${exitSignal}: ${stderrTail.slice(-8).join('\n')}`
            } satisfies EngineError)
          } else if (r?.ok === true && code === 0) resolvePromise(r.value)
          else if (r?.ok === false) rejectPromise(r.err)
          else if (r?.ok === true) resolvePromise(r.value)
          else
            rejectPromise({
              code: 'ENGINE_CRASHED',
              userMessage: GENERIC_ERROR,
              message: `exit ${code}: ${stderrTail.slice(-8).join('\n')}`
            } satisfies EngineError)
        })
      })
    })
  }
}

export type RunEngine = ReturnType<typeof createEngineRunner>

function cancelled(): EngineError {
  return { code: 'CANCELLED', userMessage: 'Stopped.' }
}

export function isEngineError(e: unknown): e is EngineError {
  return !!e && typeof e === 'object' && 'code' in e && 'userMessage' in e
}

export function toUserError(e: unknown): EngineError {
  if (isEngineError(e)) return { code: e.code, userMessage: e.userMessage, message: e.message }
  const msg = e instanceof Error ? e.message : String(e)
  return { code: 'UNEXPECTED', userMessage: GENERIC_ERROR, message: msg }
}
