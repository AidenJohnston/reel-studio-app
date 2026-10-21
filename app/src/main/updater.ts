// The updater behind the sidebar button, Settings and the app menu. Same shape as T3 Code's DesktopUpdates
// (apps/desktop/src/updates/DesktopUpdates.ts): checks 15 s after start and then on an interval, never
// downloads or installs by itself, downloads when the person clicks, installs when they say restart.
//
// Two backends do the network part. macOS (and Windows once its installer is signed) uses electron-updater
// (main/updater-electron.ts); unsigned Windows uses the GitHub releases page check (main/update-check.ts), where
// "Download" opens the release page. Which one runs is main/update-machine.ts updateMode.
//
// No electron import here: main/index.ts wires it up, the tests drive it with a fake backend.
import { allowedReleaseUrl, pageFor } from './update-check'
import { releaseNotesFrom } from './release-notes'
import {
  FIRST_CHECK_DELAY_MS,
  isRateLimited,
  isSnoozed,
  nextCheckIn,
  onAvailable,
  onCheckFailed,
  onCheckStart,
  onDownloadFailed,
  onDownloaded,
  onDownloadProgress,
  onDownloadStart,
  onInstallFailed,
  onUpToDate,
  plainError,
  progressWorthSending,
  SNOOZE_MS,
  stillNewer,
  validDismissal,
  type CheckOutcome,
  type Dismissal,
  type UpdateMemory
} from './update-machine'
import { initialUpdateState, updateAction, type UpdateActionResult, type UpdateBusy, type UpdateMode, type UpdateState } from '../shared/update'

export interface FoundUpdate {
  version: string
  /** Release notes as the source gives them (HTML from the atom feed, markdown from the API). */
  notes: unknown
  releaseUrl: string | null
}

export interface UpdateBackend {
  /** The newer version, or null when this one is the newest. Throws when it could not tell. */
  check(): Promise<FoundUpdate | null>
  /** Resolves once the whole file is downloaded and verified. */
  download(onProgress: (percent: number) => void): Promise<void>
  /** Hands over to the installer, which quits and reopens the app. Squirrel.Mac reports a failure later,
   * by event: main/index.ts passes it to the updater's installFailed(). */
  install(): void
}

export interface UpdaterDeps {
  version: string
  mode: UpdateMode
  /** null = updates can run (main/update-machine.ts disabledReason). */
  disabledReason: string | null
  backend: UpdateBackend | null
  /** The settings this keeps across launches (main/settings.ts). */
  load(): Promise<UpdateMemory>
  save(patch: Partial<UpdateMemory>): Promise<unknown>
  busy(): UpdateBusy
  /** Stop running work cleanly before the installer quits the app. */
  prepareToQuit(): Promise<void>
  /** shell.openExternal; only ever called with an allowedReleaseUrl() result. */
  openExternal(url: string): Promise<void>
  send(s: UpdateState): void
  log(line: string): void
  now(): number
}

type Action = 'check' | 'download' | 'install'

/** An error's text for the log, cut short (electron-updater's can carry a whole feed). */
const why = (e: unknown): string => String((e as Error)?.message ?? e).slice(0, 300)

export function createUpdater(d: UpdaterDeps) {
  let state = initialUpdateState(d.version, d.mode, true, d.disabledReason)
  let active: Action | null = null
  // when GitHub last answered (kept across launches): automatic checks wait a day from it
  let lastAnswered: number | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let started = false
  let dismissed: Dismissal | null = null
  let snoozeEnd: ReturnType<typeof setTimeout> | null = null
  // A check in this run found the offered version. False when it came from memory (an offline start), and then
  // electron-updater has to read the release before it can download it.
  let fresh = false

  const set = (next: UpdateState): void => {
    state = { ...next, snoozed: isSnoozed(dismissed, next, d.now()) }
    d.send(state)
  }
  const remember = (patch: Partial<UpdateMemory>): void =>
    void d.save(patch).catch((e) => d.log(`[update] could not save: ${why(e)}`))

  /** Show the sidebar button again when "Not now" runs out, even if no check happens then. */
  function armSnoozeEnd(): void {
    if (snoozeEnd) clearTimeout(snoozeEnd)
    snoozeEnd = null
    const left = dismissed ? dismissed.at + SNOOZE_MS - d.now() : 0
    if (left <= 0) return
    snoozeEnd = setTimeout(() => set(state), left)
    snoozeEnd.unref?.()
  }

  /** What a check found becomes the state, and is remembered for the next start. */
  function applyFound(found: FoundUpdate | null): void {
    if (found) {
      const url = allowedReleaseUrl(found.releaseUrl) ?? pageFor(`v${found.version}`)
      const notes = releaseNotesFrom(found.notes, found.version)
      set(onAvailable(state, found.version, d.now(), notes, url))
      remember({ updateLatest: { version: found.version, url, notes } })
      d.log(`[update] ${found.version} is available`)
    } else {
      set(onUpToDate(state, d.now()))
      if (state.status === 'up-to-date') remember({ updateLatest: null })
      d.log('[update] up to date')
    }
    fresh = found !== null
  }
  const enabled = (): boolean => d.disabledReason === null && d.backend !== null

  function schedule(ms: number): void {
    if (timer) clearTimeout(timer)
    timer = null
    if (!started || !enabled() || !state.autoCheck) return
    timer = setTimeout(() => void tick(), ms)
    timer.unref?.()
  }

  async function tick(): Promise<void> {
    const outcome = await runCheck('auto')
    schedule(nextCheckIn(outcome ?? 'answered', lastAnswered, d.now()))
  }

  function answered(): void {
    lastAnswered = d.now()
    remember({ updateCheckedAt: lastAnswered })
  }

  /** null = skipped (busy, off, or installing). */
  async function runCheck(reason: string): Promise<CheckOutcome | null> {
    if (!enabled() || active || state.status === 'downloading') return null
    active = 'check'
    set(onCheckStart(state, d.now()))
    d.log(`[update] checking (${reason}), running ${d.version}`)
    try {
      applyFound(await d.backend!.check())
      answered()
      return 'answered'
    } catch (e) {
      set(onCheckFailed(state, plainError('check', e), d.now()))
      d.log(`[update] check failed: ${why(e)}`)
      // "slow down" is an answer: it uses up the day, as in 0.1.2
      if (!isRateLimited(e)) return 'failed'
      answered()
      return 'answered'
    } finally {
      active = null
    }
  }

  /** Never during launch; otherwise when the day since GitHub's last answer is up. */
  function start(firstDelayMs = FIRST_CHECK_DELAY_MS): void {
    started = true
    schedule(Math.max(firstDelayMs, nextCheckIn('answered', lastAnswered, d.now())))
  }

  function stop(): void {
    started = false
    if (timer) clearTimeout(timer)
    timer = null
  }

  /** The installer reported a failure (directly, or later through electron-updater's error event). */
  function installFailed(e: unknown): void {
    if (active !== 'install') return
    active = null
    set(onInstallFailed(state, plainError('install', e)))
    d.log(`[update] install failed: ${why(e)}`)
    start()
  }

  return {
    state: (): UpdateState => state,

    /** Read what was kept from the last run, then broadcast the first state. Call once before start(). */
    async init(): Promise<void> {
      const mem = await d.load().catch((e) => {
        d.log(`[update] could not read settings: ${why(e)}`)
        return { checkUpdates: true, updateCheckedAt: null, updateLatest: null, updateDismissed: null }
      })
      const at = mem.updateCheckedAt
      lastAnswered = typeof at === 'number' && Number.isFinite(at) ? at : null
      dismissed = validDismissal(mem.updateDismissed)
      const kept = stillNewer(mem.updateLatest, d.version)
      // installed since, or not ours: forget it
      if (mem.updateLatest && !kept) remember({ updateLatest: null })
      let first: UpdateState = { ...state, autoCheck: mem.checkUpdates }
      // Offered as the old update note did: only while automatic checks are on.
      if (kept && enabled() && mem.checkUpdates) first = { ...onAvailable(first, kept.version, d.now(), kept.notes ?? null, kept.url), checkedAt: null }
      set(first)
      armSnoozeEnd()
    },

    start,
    stop,
    installFailed,

    /** A check the person asked for (menu, Settings): runs even with automatic checks off. */
    async check(reason: string): Promise<{ checked: boolean; state: UpdateState }> {
      const outcome = await runCheck(reason)
      if (outcome) schedule(nextCheckIn(outcome, lastAnswered, d.now()))
      return { checked: outcome !== null, state }
    },

    async download(): Promise<UpdateActionResult> {
      if (active || updateAction(state) !== 'download' || state.mode !== 'install') return { accepted: false, state }
      active = 'download'
      const version = state.availableVersion!
      set(onDownloadStart(state))
      d.log(`[update] downloading ${version}`)
      try {
        if (!fresh) {
          // offered from memory: read the release first (offline, this fails as a stopped download)
          const found = await d.backend!.check()
          if (found?.version !== version) {
            applyFound(found)
            return { accepted: true, state }
          }
          fresh = true
        }
        await d.backend!.download((p) => {
          if (progressWorthSending(state, p)) set(onDownloadProgress(state, p))
        })
        set(onDownloaded(state, version))
        d.log(`[update] downloaded ${version}`)
      } catch (e) {
        set(onDownloadFailed(state, plainError('download', e)))
        d.log(`[update] download failed: ${why(e)}`)
      } finally {
        active = null
      }
      return { accepted: true, state }
    },

    /** Quit and install. Refused while an export is writing its file. */
    async install(): Promise<UpdateActionResult> {
      if (active || updateAction(state) !== 'install') return { accepted: false, state }
      if (d.busy().exporting) return { accepted: false, state, refused: 'exporting' }
      active = 'install'
      d.log(`[update] installing ${state.downloadedVersion}`)
      stop()
      try {
        await d.prepareToQuit()
        d.backend!.install()
      } catch (e) {
        installFailed(e)
      }
      return { accepted: true, state }
    },

    /** The available version's page (Windows "Download", popover links, "install it yourself"). */
    async openRelease(): Promise<void> {
      const v = state.downloadedVersion ?? state.availableVersion
      const url = allowedReleaseUrl(state.releaseUrl) ?? (v ? pageFor(`v${v}`) : null)
      if (url) await d.openExternal(url)
    },

    /** "Not now" in the popover: hide the sidebar button for 24 h for this version (or until a newer one). */
    async dismiss(version: unknown): Promise<UpdateState> {
      if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) return state
      dismissed = { version, at: d.now() }
      await d.save({ updateDismissed: dismissed })
      set(state)
      armSnoozeEnd()
      d.log(`[update] not now: ${version}`)
      return state
    },

    /** Settings > "Check for updates" (`enabled` = automatic checks on). */
    status: (): { enabled: boolean } => ({ enabled: state.autoCheck }),

    async setEnabled(on: unknown): Promise<{ enabled: boolean }> {
      const autoCheck = on === true
      await d.save({ checkUpdates: autoCheck })
      set({ ...state, autoCheck })
      // on: look if a day has passed since the last answer. off: schedule() only clears the next look.
      schedule(nextCheckIn('answered', lastAnswered, d.now()))
      return { enabled: autoCheck }
    }
  }
}

export type Updater = ReturnType<typeof createUpdater>

export interface MenuDialog {
  type: 'info' | 'warning'
  title: string
  message: string
  detail?: string
  buttons: string[]
  defaultId?: number
  cancelId?: number
}

/**
 * Reel Studio > "Check for Updates...": T3 Code's dialogs ("You're up to date", "Update check failed",
 * "Updates unavailable"), plus one it leaves to the sidebar: when a version is out, say so and offer the
 * download here, so the menu never answers with silence. macOS shows a message box's `message` as its
 * headline and ignores `title`, so both carry the headline and `detail` the sentence.
 */
export async function menuCheckForUpdates(
  u: Pick<Updater, 'check' | 'state' | 'download' | 'openRelease'>,
  ui: { focus(): void; show(o: MenuDialog): Promise<{ response: number }> }
): Promise<void> {
  const before = u.state()
  if (before.status === 'disabled') {
    await ui.show({ type: 'info', title: 'Updates unavailable', message: 'Updates unavailable', detail: before.message ?? undefined, buttons: ['OK'] })
    return
  }
  ui.focus()
  const { state: s } = await u.check('menu')
  const v = s.downloadedVersion ?? s.availableVersion
  const action = updateAction(s)
  if (action === 'download' || action === 'open-page') {
    const page = action === 'open-page'
    const r = await ui.show({
      type: 'info',
      title: 'Update available',
      message: `Reel Studio ${v} is available`,
      detail: page ? 'Download opens its page in your browser.' : 'It downloads in the background. When it is done, restart from the update button in the sidebar.',
      buttons: ['Download', 'Not now'],
      defaultId: 0,
      cancelId: 1
    })
    if (r.response === 0) await (page ? u.openRelease() : u.download())
  } else if (action === 'install') {
    await ui.show({ type: 'info', title: 'Update ready', message: `Reel Studio ${v} is downloaded`, detail: 'Restart from the update button in the sidebar to install it.', buttons: ['OK'] })
  } else if (s.status === 'up-to-date') {
    await ui.show({ type: 'info', title: "You're up to date", message: "You're up to date", detail: `Reel Studio ${s.currentVersion} is the newest version.`, buttons: ['OK'] })
  } else if (s.status === 'error') {
    await ui.show({ type: 'warning', title: 'Update check failed', message: 'Update check failed', detail: s.message ?? 'Try again later.', buttons: ['OK'] })
  }
}
