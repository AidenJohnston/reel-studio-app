import type { RunEngine } from './engine'

/**
 * The preview copy of each 4K or HDR take (engine `proxy`, engine/reelengine/proxy.py), made in the
 * background after import so drafts stop decoding 4K on every edit. Nothing waits for it: until it
 * is finished, previews read the original. One build per project at a time; a failure is logged and
 * otherwise ignored (the engine already falls back). A project's build is stopped before the
 * project is removed, because Windows cannot delete a file FFmpeg still has open.
 */
interface Build {
  abort: AbortController
  done: Promise<void>
}

export function createProxyBuilds(runEngine: RunEngine, log: (line: string) => void) {
  const running = new Map<string, Build>()

  function start(slug: string, projectDir: string): void {
    if (running.has(slug)) return
    const abort = new AbortController()
    const build: Build = {
      abort,
      done: runEngine('proxy', ['--project', projectDir], undefined, abort.signal)
        .then((r) => log(`[proxy] ${slug}: ${JSON.stringify((r as { sources?: unknown })?.sources ?? r)}`))
        .catch((e) => {
          if (!abort.signal.aborted) log(`[proxy] ${slug} failed: ${(e as { message?: string })?.message ?? String(e)}`)
        })
        .finally(() => {
          if (running.get(slug) === build) running.delete(slug)
        })
    }
    running.set(slug, build)
  }

  async function stop(slug: string): Promise<void> {
    const b = running.get(slug)
    if (!b) return
    b.abort.abort()
    await b.done
  }

  return { start, stop }
}

export type ProxyBuilds = ReturnType<typeof createProxyBuilds>
