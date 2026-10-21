// App settings (not user content): first-run flag and storage location.
import { promises as fs } from 'node:fs'
import { dirname } from 'node:path'
import { settingsFile } from './paths'
import { writeJson } from './store'
import type { Dismissal, RememberedRelease } from './update-machine'

export interface Settings {
  /** Settings > "Check for updates": automatic update checks (main/updater.ts). Default on. */
  checkUpdates: boolean
  /** The newest release the last check found, so a start without internet still offers it. */
  updateLatest: RememberedRelease | null
  /** "Not now" in the update popover: which version, and when. */
  updateDismissed: Dismissal | null
  firstRunDone: boolean
  root: string | null
  /** Written by the 0.1.0/0.1.1 local-Claude-Code builds (a one-time automatic AI pick); read once by ai-carryover.ts. */
  aiAutoPicked: boolean
  /** ai-carryover.ts already ran (it kept, or left alone, what an old local-Claude-Code install was using) */
  aiCarriedOver: boolean
}

const DEFAULTS: Settings = { firstRunDone: false, root: null, aiAutoPicked: false, aiCarriedOver: false, checkUpdates: true, updateLatest: null, updateDismissed: null }

export async function loadSettings(): Promise<Settings> {
  try {
    return { ...DEFAULTS, ...JSON.parse(await fs.readFile(settingsFile(), 'utf8')) }
  } catch {
    return { ...DEFAULTS }
  }
}

// One save at a time: each is read-modify-write, and saves from different places can overlap (start-up
// bookkeeping, a Settings toggle), so two overlapping saves must not drop each other's change (e.g. firstRunDone).
let queue: Promise<unknown> = Promise.resolve()

export function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const run = async (): Promise<Settings> => {
    const next = { ...(await loadSettings()), ...patch }
    await fs.mkdir(dirname(settingsFile()), { recursive: true })
    // Same writer as projects: unique temp file + rename that retries on Windows locks (review 32).
    await writeJson(settingsFile(), next)
    return next
  }
  const p = queue.then(run, run)
  queue = p.catch(() => undefined)
  return p
}
