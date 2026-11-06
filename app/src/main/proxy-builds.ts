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
  /** the engine has exited (or never started) */
  gone: () => boolean
  stopping?: Promise<void>
}

// How long `stop` waits for a cancelled build's engine to exit before letting the caller go on.
const STOP_WAIT_MS = 15_000

/**
 * The preview copy of each 4K or HDR take (engine `proxy`, engine/reelengine/proxy.py), made in the
 * background after import so drafts stop decoding 4K on every edit. Nothing waits for it: until it
 * is finished, previews read the original. One build per project at a time; a failure is logged and
 * otherwise ignored (the engine already falls back).
 *
 * Each build gets its own runner, so `stop` can wait for that engine process to exit: a cancelled
 * runEngine call rejects as soon as the kill is sent, and Windows refuses to delete a project whose
 * files FFmpeg still has open.
 */
/** stop() could not see the build's engine exit: its FFmpeg may still hold the project's files open. */
export const PROXY_STILL_RUNNING = {
  code: 'PROXY_STILL_RUNNING',
  userMessage: 'Reel Studio is still finishing a preview copy of this reel and it would not stop. Restart Reel Studio, then remove the reel.'
}

export function createProxyBuilds(makeRunner: (hooks: ExitHooks) => RunEngine, log: (line: string) => void, { stopWaitMs = STOP_WAIT_MS } = {}) {
  const running = new Map<string, Build>()

  function start(slug: string, projectDir: string): void {
    if (running.has(slug)) return
    const abort = new AbortController()
    let spawned = false
    let gone = false
    let markExited = (): void => {}
    const exited = new Promise<void>((resolve) => (markExited = () => ((gone = true), resolve())))
    const run = makeRunner({ onSpawn: () => (spawned = true), onExit: () => markExited() })
    const build: Build = {
      abort,
      exited,
      gone: () => gone,
      done: run('proxy', ['--project', projectDir], undefined, abort.signal)
        .then((r) => log(`[proxy] ${slug}: ${JSON.stringify((r as { sources?: unknown })?.sources ?? r)}`))
        .catch((e) => {
          if (!abort.signal.aborted) log(`[proxy] ${slug} failed: ${(e as { message?: string })?.message ?? String(e)}`)
        })
        .finally(() => {
          if (!spawned) markExited() // never started: nothing to wait for
        })
    }
    running.set(slug, build)
    // The project counts as building until its engine has exited, not merely until the call settled.
    void exited.then(() => forget(slug, build))
  }

  function forget(slug: string, build: Build): void {
    if (running.get(slug) === build) running.delete(slug)
  }

  /** Cancels the project's build and resolves once its engine has exited. Every caller during that wait gets the same
   * promise. An engine not seen to exit within STOP_WAIT_MS (one that would not die: engine.ts ENGINE_STUCK) rejects
   * with PROXY_STILL_RUNNING and stays registered, so no second build starts and a later stop waits for it again. */
  function stop(slug: string): Promise<void> {
    const b = running.get(slug)
    if (!b) return Promise.resolve()
    b.stopping ??= (async () => {
      b.abort.abort()
      await b.done
      let timer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([b.exited, new Promise<void>((resolve) => (timer = setTimeout(resolve, stopWaitMs)))])
      clearTimeout(timer)
      if (!b.gone()) {
        b.stopping = undefined
        throw PROXY_STILL_RUNNING
      }
      forget(slug, b)
    })()
    return b.stopping
  }

  return { start, stop }
}

export type ProxyBuilds = ReturnType<typeof createProxyBuilds>
