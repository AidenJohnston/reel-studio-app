// Runs `python -m reelengine <command> ...` and speaks the JSON-lines protocol (docs/architecture.md section 4).
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { groupAlive, killTree } from './proctree'

/** Something finished that the app can show now, carried on a progress line (engine `moments`). */
export type EngineReady =
  | { kind: 'still'; t: number; file: string }
  | { kind: 'window'; from: number; to: number; file: string }

export interface EngineProgress {
  stage: string
  pct: number
  message: string
  ready?: EngineReady
  /** a line to show beside the current step (engine proto.progress), e.g. why listening is slow */
  note?: string
}

export interface EngineError {
  code: string
  userMessage: string
  message?: string
}

export type EngineEvent =
  | { event: 'progress'; stage: string; pct: number; message: string; ready?: EngineReady; note?: string }
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
      const ready = parseReady(o.ready)
      return {
        event: 'progress',
        stage: String(o.stage ?? ''),
        pct,
        message: typeof o.message === 'string' ? o.message : '',
        ...(ready ? { ready } : {}),
        ...(typeof o.note === 'string' && o.note ? { note: o.note } : {})
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

const num = (v: unknown): v is number => typeof v === 'number' && isFinite(v)

/** A `ready` payload, or null when it is missing or not one of the two shapes the engine writes. */
function parseReady(r: unknown): EngineReady | null {
  if (!r || typeof r !== 'object') return null
  const o = r as Record<string, unknown>
  if (typeof o.file !== 'string' || !o.file) return null
  if (o.kind === 'still' && num(o.t)) return { kind: 'still', t: o.t, file: o.file }
  if (o.kind === 'window' && num(o.from) && num(o.to)) return { kind: 'window', from: o.from, to: o.to, file: o.file }
  return null
}

export const GENERIC_ERROR =
  'Something went wrong while working on your reel, so try again, and restart Reel Studio if it keeps happening.'
export const MISSING_ENGINE =
  'Reel Studio is missing a part it needs to make reels, so reinstall the app.'

export interface RunnerConfig {
  python: () => string
  env: () => NodeJS.ProcessEnv
  cwd?: () => string
  log?: (line: string) => void
  /** Called with the engine's pid and its `--project` right after it starts. */
  onSpawn?: (pid: number, project: string | null) => void
  /** Called once that engine and everything it started have exited; never for a group that would not die. */
  onExit?: (pid: number) => void
}

// How long an engine that has exited may keep its pipes open before it counts as gone. 5 s is the figure the PR review
// suggested; it was not measured.
const CLOSE_WAIT_MS = 5000

const running = new Set<ChildProcess>()

/** Kills every engine process this runner started. Used when the app quits. */
export async function killAllEngines(): Promise<void> {
  await Promise.all([...running].map((c) => (c.pid ? killTree(c.pid) : Promise.resolve())))
}

/** Settles once the engine has exited and nothing it started is left in its process group (false
 * when something survived SIGKILL): an engine that died early must not leave an ffmpeg writing into
 * a project its job has let go of. Windows has no groups; there the engine's Job Object ends its
 * children with it (engine/reelengine/contain.py). */
function ended(child: ChildProcess, pipesHeld: () => void): Promise<boolean> {
  return new Promise<void>((resolve) => {
    child.once('close', () => resolve())
    // `close` waits for every copy of the stdio pipes. A grandchild that left the process group can hold one open
    // forever, and then a cancel, quitting and --self-test would hang, so stop waiting CLOSE_WAIT_MS after the exit.
    const bound = (): void => {
      const timer = setTimeout(() => {
        pipesHeld()
        resolve()
      }, CLOSE_WAIT_MS)
      child.once('close', () => clearTimeout(timer))
    }
    if (child.exitCode !== null || child.signalCode !== null) bound()
    else child.once('exit', bound)
  }).then(() => !child.pid || process.platform === 'win32' || !groupAlive(child.pid) || killTree(child.pid))
}

export function createEngineRunner(cfg: RunnerConfig) {
  return function runEngine(
    command: string,
    args: string[],
    onProgress?: (p: EngineProgress) => void,
    signal?: AbortSignal,
    /** Called once the process is gone, or at once when it never started. */
    onExit?: () => void
  ): Promise<unknown> {
    return new Promise((resolvePromise, rejectPromise) => {
      if (signal?.aborted) {
        onExit?.()
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
      if (child.pid) cfg.onSpawn?.(child.pid, args.includes('--project') ? args[args.indexOf('--project') + 1] : null)
      let exitReported = false
      const markGone = (): void => {
        if (exitReported) return
        exitReported = true
        onExit?.()
      }

      const gone = ended(child, () => log(`[engine ${command}] pipes still open ${CLOSE_WAIT_MS} ms after it exited`))
      void gone.then((clean) => {
        running.delete(child)
        markGone()
        // a group that would not die stays registered, so the next start finds it (orphans.ts)
        if (clean && child.pid) cfg.onExit?.(child.pid)
      })
      const finish = (fn: () => void): void => {
        if (settled) return
        settled = true
        signal?.removeEventListener('abort', onAbort)
        fn()
      }

      // Every outcome settles only once the engine and everything it started have exited: whoever runs
      // next on this project (a new note, a cleanup) must never share its files with a dying render.
      const onAbort = (): void => {
        if (settled) return
        settled = true
        signal?.removeEventListener('abort', onAbort)
        // Windows kills by pid, and an engine that has already exited may have handed its pid on
        const exited = child.exitCode !== null || child.signalCode !== null
        const kill = child.pid && !(exited && process.platform === 'win32') ? killTree(child.pid) : true
        // An engine that outlives SIGKILL (stuck in disk or device I/O) never exits, so `gone` would never settle and
        // Stop would hang: once the kill has failed, the job ends as ENGINE_STUCK, which keeps the project closed (jobs.ts).
        void Promise.resolve(kill).then((killed) =>
          killed ? gone.then((clean) => rejectPromise(clean ? cancelled() : stuck(child.pid))) : rejectPromise(stuck(child.pid)))
      }
      signal?.addEventListener('abort', onAbort, { once: true })

      const out = new LineSplitter((line) => {
        const ev = parseEngineLine(line)
        if (!ev) {
          log(`[engine ${command} stdout] ${line}`)
          return
        }
        if (ev.event === 'progress')
          onProgress?.({ stage: ev.stage, pct: ev.pct, message: ev.message, ...(ev.ready ? { ready: ev.ready } : {}), ...(ev.note ? { note: ev.note } : {}) })
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
        if (!child.pid) markGone() // never started, so no 'close' follows
        finish(() =>
          rejectPromise({
            code: e.code === 'ENOENT' ? 'ENGINE_MISSING' : 'ENGINE_START_FAILED',
            userMessage: MISSING_ENGINE,
            message: `${cfg.python()}: ${e.message}`
          } satisfies EngineError)
        )
      })
      child.on('close', (code, exitSignal) => {
        out.end()
        err.end()
        log(`[engine ${command}] closed exitCode=${code} signal=${exitSignal ?? 'none'}`)
        void gone.then((clean) => finish(() => {
          const r = result as typeof result
          if (!clean) rejectPromise(stuck(child.pid))
          else if (r?.ok === true) resolvePromise(r.value)
          else if (r?.ok === false) rejectPromise(r.err)
          else
            rejectPromise({
              code: 'ENGINE_CRASHED',
              userMessage: GENERIC_ERROR,
              message: `${exitSignal ? `signal ${exitSignal}` : `exit ${code}`}: ${stderrTail.slice(-8).join('\n')}`
            } satisfies EngineError)
        }))
      })
    })
  }
}

export type RunEngine = ReturnType<typeof createEngineRunner>

function cancelled(): EngineError {
  return { code: 'CANCELLED', userMessage: 'Stopped.' }
}

/** Something the engine started would not stop: it may still be writing (jobs.ts keeps the project closed). */
function stuck(pid: number | undefined): EngineError {
  return {
    code: 'ENGINE_STUCK',
    userMessage: "Part of Reel Studio wouldn't stop, so restart Reel Studio before you change this reel again.",
    message: `process group ${pid} is still alive after SIGKILL`
  }
}

export function isEngineError(e: unknown): e is EngineError {
  return !!e && typeof e === 'object' && 'code' in e && 'userMessage' in e
}

export function toUserError(e: unknown): EngineError {
  if (isEngineError(e)) return { code: e.code, userMessage: e.userMessage, message: e.message }
  const msg = e instanceof Error ? e.message : String(e)
  return { code: 'UNEXPECTED', userMessage: GENERIC_ERROR, message: msg }
}
