// App settings (not user content): first-run flag and storage location.
import { promises as fs } from 'node:fs'
import { dirname } from 'node:path'
import { settingsFile } from './paths'
import { writeJson } from './store'

export interface Settings {
  firstRunDone: boolean
  root: string | null
  /** Local Claude Code build: the one-time "use Claude Code on this computer" pick has happened. */
  aiAutoPicked: boolean
}

const DEFAULTS: Settings = { firstRunDone: false, root: null, aiAutoPicked: false }

export async function loadSettings(): Promise<Settings> {
  try {
    return { ...DEFAULTS, ...JSON.parse(await fs.readFile(settingsFile(), 'utf8')) }
  } catch {
    return { ...DEFAULTS }
  }
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await loadSettings()), ...patch }
  await fs.mkdir(dirname(settingsFile()), { recursive: true })
  // Same writer as projects: unique temp file + rename that retries on Windows locks (review 32).
  await writeJson(settingsFile(), next)
  return next
}
