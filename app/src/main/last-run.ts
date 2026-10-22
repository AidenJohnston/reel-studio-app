// At startup, before any job: settles what the last run left behind. The storage root comes first,
// because an engine list that can't be read closes every video still locked under the root this run uses.
import { basename } from 'node:path'
import type { createPidRegistry } from './orphans'
import { clearStaleLocks } from './owner'
import { setRootOverride } from './paths'
import { loadSettings, type Settings } from './settings'
import { ensureRoot, recoverInterrupted } from './store'

/** `keepClosed`: a video something of the last run's may still write to (jobs.ts). */
export async function settleLastRun(
  registry: ReturnType<typeof createPidRegistry>,
  keepClosed: (slug: string) => void,
  log: (line: string) => void
): Promise<Settings> {
  const settings = await loadSettings()
  if (settings.root) setRootOverride(settings.root)
  await ensureRoot().catch((e) => log(`[root] ${String(e)}`))
  const { stopped, stillRunning, unknown } = await registry.reap()
  if (stopped) log(`[start] stopped ${stopped} engine process(es) left over from a crash`)
  if (unknown) log('[start] the engine list from the last run could not be read, or names an engine with no video; every video left open stays closed')
  // something there would not stop and may still be writing: the project stays closed, its lock kept
  const closed = stillRunning.map((dir) => basename(dir))
  for (const slug of closed) {
    log(`[start] ${slug}: an engine process from the last run would not stop; the video stays closed`)
    keepClosed(slug)
  }
  await clearStaleLocks(stillRunning).catch((e) => log(`[locks] ${String(e)}`))
  const recovered = await recoverInterrupted(closed).catch((e) => {
    log(`[recover] ${String(e)}`)
    return []
  })
  if (recovered.length) log(`[recover] cleaned up ${recovered.join(', ')}`)
  return settings
}
