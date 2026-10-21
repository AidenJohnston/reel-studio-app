// App settings (not user content): first-run flag and storage location.
import { promises as fs } from 'node:fs'
import { dirname } from 'node:path'
import { settingsFile } from './paths'
import { writeJson } from './store'
import { UPDATE_DEFAULTS, type UpdateState } from './update-check'
import type { SpeechCheckResult } from './models'

export interface Settings extends UpdateState {
  firstRunDone: boolean
  root: string | null
  /** Written by the 0.1.0/0.1.1 local-Claude-Code builds (a one-time automatic AI pick); read once by ai-carryover.ts. */
  aiAutoPicked: boolean
  /** ai-carryover.ts already ran (it kept, or left alone, what an old local-Claude-Code install was using) */
  aiCarriedOver: boolean
  /** "Tell me when a video is ready". null = never chosen (main/permissions.ts notificationsWanted). */
  notifications: boolean | null
  /** The listening model's timing check on this computer (main/models.ts runCheck). null = never run. */
  speechCheck: SpeechCheckResult | null
}

const DEFAULTS: Settings = {
  firstRunDone: false,
  root: null,
  aiAutoPicked: false,
  aiCarriedOver: false,
  notifications: null,
  speechCheck: null,
  ...UPDATE_DEFAULTS
}

export async function loadSettings(): Promise<Settings> {
  try {
    return { ...DEFAULTS, ...JSON.parse(await fs.readFile(settingsFile(), 'utf8')) }
  } catch {
    return { ...DEFAULTS }
  }
}

// One save at a time: each is read-modify-write, and the update check (main/update-check.ts) saves in the
// background, so two overlapping saves must not drop each other's change (e.g. firstRunDone).
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
