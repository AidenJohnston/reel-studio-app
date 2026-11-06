// TikTok API v2: https://developers.tiktok.com/doc/login-kit-desktop/
// Instagram API v26.0: https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/business-login
// App settings (not user content): first-run flag and storage location.
import { existsSync, promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import { PRODUCT_NAME } from '../shared/channel'
import { channel, defaultRoot, legacyRoot, settingsFile, stableLibraryRoots } from './paths'
import { writeJson } from './store'
import type { SpeechCheckResult } from './models'
import { UPDATE_MEMORY_DEFAULTS, type UpdateMemory } from './update-machine'
import { MODEL_ROLES, type DataSharing, type ModelChoice, type PhoneView } from '../shared/api'
import type { TikTokSettings } from '../shared/tiktok'
import type { InstagramSettings } from '../shared/instagram'
import { UPDATE_KEY_DEFAULTS, type UpdateKeyState } from './update-key'

// Instagram and TikTok (insights-data): off until a developer configures them, with no UI yet
export interface Settings extends InstagramSettings, TikTokSettings, UpdateMemory, UpdateKeyState {
  firstRunDone: boolean
  /**
   * Settings › Advanced › Reset first run: the next launch shows the first run again. firstRunDone stays true, so
   * that launch still recovers interrupted reels; finishing the first run clears this.
   */
  firstRunAgain: boolean
  root: string | null
  fasterExports: boolean
  /** Written by the 0.1.0/0.1.1 local-Claude-Code builds (a one-time automatic AI pick); read once by ai-carryover.ts. */
  aiAutoPicked: boolean
  /** ai-carryover.ts already ran (it kept, or left alone, what an old local-Claude-Code install was using) */
  aiCarriedOver: boolean
  /** null = never chosen (main/permissions.ts notificationsWanted) */
  notifications: boolean | null
  speechCheck: SpeechCheckResult | null
  /** Settings > "Double-check each edit": passed to every AI note as `checkEdit`. Off by default until
   * the eval harness measures the tokens and time it adds. */
  checkEdits: boolean
  /** Settings > "Look things up in parallel": a note may hand searches to a second AI (ai helpers.ts) as
   * `helpers`. Off by default: what it adds in tokens and time is not measured yet. */
  lookUps: boolean
  models: ModelChoice
  sharing: DataSharing
  phoneView: PhoneView
  /** the Reel screen shows its timeline under the phone (View › Show Timeline); off gives the phone its height */
  timeline: boolean
  /** the first run's sample plays its two sounds */
  soundEffects: boolean
}

const DEFAULTS: Settings = {
  firstRunDone: false,
  firstRunAgain: false,
  root: null,
  fasterExports: false,
  aiAutoPicked: false,
  aiCarriedOver: false,
  notifications: null,
  speechCheck: null,
  checkEdits: false,
  lookUps: false,
  models: Object.fromEntries(MODEL_ROLES.map((r) => [r, 'auto'])) as ModelChoice,
  sharing: { asked: false, on: false, usage: true, quality: true, posts: true },
  phoneView: 'instagram',
  // Sam asked for the timeline as a toggle that starts on (spec §7)
  timeline: true,
  soundEffects: true,
  // Connection and publishing stay opt-in until the broker and Meta app have been configured.
  instagramEnabled: false, instagramAppId: null, instagramBrokerUrl: null, instagramUploadOrigins: [],
  // Posting requires explicit developer configuration and approval of the requested scopes.
  tiktokEnabled: false, tiktokClientKey: null, tiktokBrokerUrl: null, tiktokAudited: false, tiktokDirectPost: false,
  ...UPDATE_MEMORY_DEFAULTS,
  ...UPDATE_KEY_DEFAULTS
}

/** Whether this launch shows the first run. `againAtLaunch`: firstRunAgain as it was when the app started, so a
 * reset takes effect on the next launch and never in the middle of this one. */
export function showsFirstRun(s: Pick<Settings, 'firstRunDone' | 'firstRunAgain'>, againAtLaunch: boolean): boolean {
  return !s.firstRunDone || (againAtLaunch && s.firstRunAgain)
}

export async function loadSettings(): Promise<Settings> {
  try {
    const saved = JSON.parse(await fs.readFile(settingsFile(), 'utf8'))
    // a model choice saved before a stage existed: the new stage starts on Auto
    return { ...DEFAULTS, ...saved, models: { ...DEFAULTS.models, ...(saved?.models ?? {}) } }
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

/**
 * The library folder, decided on an install's first launch and saved, so it never moves by itself. An install made
 * before ~/Movies became the default already has a settings file and keeps its library in Documents. The nightly always
 * starts in its own folder (paths.ts defaultRoot). Call it before
 * anything else in this launch writes settings.
 */
export async function settleLibraryRoot(): Promise<string> {
  const installedBefore = existsSync(settingsFile())
  const saved = (await loadSettings()).root
  if (saved) return saved
  // The nightly has no older installs of its own, and the legacy folder is the stable app's library.
  const root = installedBefore && channel() === 'stable' ? legacyRoot() : defaultRoot()
  await saveSettings({ root })
  return root
}

/** The stable app's libraries as the nightly sees them: both defaults, and the folder its settings saved (read only). */
export async function stableLibraries(appDataDir: string): Promise<string[]> {
  const saved: unknown = await fs
    .readFile(join(appDataDir, PRODUCT_NAME.stable, 'settings.json'), 'utf8')
    .then((t) => (JSON.parse(t) as { root?: unknown }).root)
    .catch(() => null)
  return [...stableLibraryRoots(), ...(typeof saved === 'string' && saved ? [saved] : [])]
}
