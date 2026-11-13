import type { RunEngine } from './engine'

/** The hooks a runner calls when its engine process starts and when it has exited (RunnerConfig). */
export interface ExitHooks {
  onSpawn: (pid: number) => void
  onExit: (pid: number) => void
}

interface Build {
  abort: AbortController
  done: Promise<void>
  exited: Promise<void>
  stopping?: Promise<void>
  /** The runner's ENGINE_STUCK: Stop could not end this build's engine, which may still use the files. */
  stuck?: unknown
}

// How long `stop` waits for a cancelled build's engine to exit before refusing the caller.
const STOP_WAIT_MS = 15_000

/** `stop` timed out: the cancelled engine has not exited yet, so its files may still be open. */
export const STILL_STOPPING = {
  code: 'BUSY',
  userMessage: 'Still stopping a background job on this video. Try again in a moment.'
}

/**
 * The preview copy of each 4K or HDR take (engine `proxy`, engine/reelengine/proxy.py), made in the
 * background after import so drafts stop decoding 4K on every edit. Nothing waits for it: until it
 * is finished, previews read the original. One build per project at a time; a failure is logged and
 * otherwise ignored (the engine already falls back).
 *
 * It is started from inside a job, which has already written work/.owner.lock (owner.ts), so the
 * command carries that job's token (`--owner`) or the engine refuses it with PROJECT_OPEN (owner.py).
 * The engine checks the token only as the command starts, so a build that outlives its job goes on.
 *
 * Each build gets its own runner, so `stop` can wait for that engine process to exit: a cancelled
 * runEngine call rejects as soon as the kill is sent, and Windows refuses to delete a project whose
 * files FFmpeg still has open.
 */
export function createProxyBuilds(makeRunner: (hooks: ExitHooks) => RunEngine, log: (line: string) => void) {
  const running = new Map<string, Build>()

  function start(slug: string, projectDir: string, owner: string | null): void {
    if (running.has(slug)) return
    const abort = new AbortController()
    let spawned = false
    let markExited = (): void => {}
    const exited = new Promise<void>((resolve) => (markExited = () => resolve()))
    const run = makeRunner({ onSpawn: () => (spawned = true), onExit: () => markExited() })
    const build: Build = { abort, exited, done: Promise.resolve() }
    build.done = run('proxy', ['--project', projectDir, ...(owner ? ['--owner', owner] : [])], undefined, abort.signal)
      .then((r) => log(`[proxy] ${slug}: ${JSON.stringify((r as { sources?: unknown })?.sources ?? r)}`))
      .catch((e) => {
        // ENGINE_STUCK comes after Stop has aborted the signal, so it is kept, not dropped with the cancel
        if ((e as { code?: string })?.code === 'ENGINE_STUCK') build.stuck = e
        if (!abort.signal.aborted || build.stuck) log(`[proxy] ${slug} failed: ${(e as { message?: string })?.message ?? String(e)}`)
      })
      .finally(() => {
        if (!spawned) markExited() // never started: nothing to wait for
      })
    running.set(slug, build)
    // The project counts as building until its engine has exited, not merely until the call settled.
    void exited.then(() => forget(slug, build))
  }

  function forget(slug: string, build: Build): void {
    if (running.get(slug) === build) running.delete(slug)
  }

  /** Cancels the project's build and resolves once its engine has exited. Every caller during that
   * wait gets the same promise. It rejects, and the build stays registered, while the engine may still
   * have the project's files open: with the runner's ENGINE_STUCK when Stop could not end it, or with
   * STILL_STOPPING when it has not exited within STOP_WAIT_MS (a later call waits again). */
  function stop(slug: string): Promise<void> {
    const b = running.get(slug)
    if (!b) return Promise.resolve()
    if (b.stuck) return Promise.reject(b.stuck)
    b.stopping ??= (async () => {
      b.abort.abort()
      await b.done
      if (b.stuck) throw b.stuck
      let timer: ReturnType<typeof setTimeout> | undefined
      const exited = await Promise.race([
        b.exited.then(() => true),
        new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), STOP_WAIT_MS)))
      ])
      clearTimeout(timer)
      if (!exited) throw STILL_STOPPING
      forget(slug, b)
    })().finally(() => {
      b.stopping = undefined
    })
    return b.stopping
  }

  return { start, stop }
}

export type ProxyBuilds = ReturnType<typeof createProxyBuilds>
