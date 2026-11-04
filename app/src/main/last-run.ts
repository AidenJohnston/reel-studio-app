// At startup, before any job: settles what the last run left behind. The storage root comes first,
// because an engine list that can't be read sends the app looking for engines in the videos under
// the root this run uses.
import { basename } from 'node:path'
import { projectFolders, type createPidRegistry } from './orphans'
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
  const recovered = await recoverInterrupted(closed).catch((e) => {
    log(`[recover] ${String(e)}`)
    return []
  })
  if (recovered.length) log(`[recover] cleaned up ${recovered.join(', ')}`)
  return settings
}
