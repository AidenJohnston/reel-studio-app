// At startup, before any job: settles what the last run left behind. The storage root comes first,
// because an engine list that can't be read sends the app looking for engines in the videos under
// the root this run uses.
import { rm } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { projectFolders, type createPidRegistry } from './orphans'
import { clearStaleLocks, OWNER_LOCK } from './owner'
import { setRootOverride } from './paths'
import { loadSettings, settleLibraryRoot, type Settings } from './settings'
import { ensureRoot, recoverInterrupted } from './store'

/** `keepClosed`: a video something of the last run's may still write to (jobs.ts). `reopen`: one whose
 * leftover engine has exited since; only that video ever waited for it, never the others. */
export async function settleLastRun(
  registry: ReturnType<typeof createPidRegistry>,
  keepClosed: (slug: string) => void,
  log: (line: string) => void,
  reopen: (slug: string) => void = () => undefined
): Promise<Settings> {
  // the library folder is decided on an install's first launch, before anything else writes settings
  setRootOverride(await settleLibraryRoot())
  const settings = await loadSettings()
  // Touching the folder in Documents is what makes macOS ask, so first run explains it before it is made (permissions.ts)
  // and a first run has no videos to recover.
  const touchRoot = settings.firstRunDone
  if (touchRoot) await ensureRoot().catch((e) => log(`[root] ${String(e)}`))
  const { stopped, stillRunning, unknown } = await registry.reap().catch((e) => {
    // nothing then says which videos are safe: none opens at this start, as when processes can't be listed
    log(`[start] could not settle the engines the last run left, so every video stays closed: ${String(e)}`)
    return { stopped: 0, stillRunning: projectFolders(), unknown: false }
  })
  if (stopped) log(`[start] stopped ${stopped} engine process(es) left over from a crash`)
  if (unknown) log('[start] the engine list from the last run could not be read, names an engine with no video, or holds a process that could not be shown to be ours; looked for engines and ffmpeg still working in a video')
  // something there would not stop, or is still running, and may still be writing: the project stays closed
  const closed = stillRunning.map((dir) => basename(dir))
  for (const slug of closed) {
    log(`[start] ${slug}: an engine process from the last run is still running; the video stays closed`)
    keepClosed(slug)
  }
  for (const dir of stillRunning) {
    void registry.drained(dir)?.then(async () => {
      await rm(join(dir, OWNER_LOCK), { force: true }).catch(() => undefined)
      log(`[start] ${basename(dir)}: the engine process from the last run has exited; the video opens again`)
      reopen(basename(dir))
    })
  }
  if (!touchRoot) return settings
  await clearStaleLocks(stillRunning).catch((e) => log(`[locks] ${String(e)}`))
  const recovered = await recoverInterrupted(closed).catch((e) => {
    log(`[recover] ${String(e)}`)
    return []
  })
  if (recovered.length) log(`[recover] cleaned up ${recovered.join(', ')}`)
  return settings
}
