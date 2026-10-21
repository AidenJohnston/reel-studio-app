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
  nextCheckDelay,
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
  type CheckOutcome
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
  /** Settings > "Check for updates" */
  loadAutoCheck(): Promise<boolean>
  saveAutoCheck(on: boolean): Promise<unknown>
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
  let failures = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  let started = false

  const set = (next: UpdateState): void => {
    state = next
    d.send(state)
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
    schedule(nextCheckDelay(outcome ?? 'ok', failures))
  }

  /** null = skipped (busy, off, or installing). */
  async function runCheck(reason: string): Promise<CheckOutcome | null> {
    if (!enabled() || active || state.status === 'downloading') return null
    active = 'check'
    set(onCheckStart(state, d.now()))
    d.log(`[update] checking (${reason}), running ${d.version}`)
    try {
      const found = await d.backend!.check()
      if (found) {
        const url = allowedReleaseUrl(found.releaseUrl) ?? pageFor(`v${found.version}`)
        set(onAvailable(state, found.version, d.now(), releaseNotesFrom(found.notes, found.version), url))
        d.log(`[update] ${found.version} is available`)
      } else {
        set(onUpToDate(state, d.now()))
        d.log('[update] up to date')
      }
      failures = 0
      return 'ok'
    } catch (e) {
      failures++
      set(onCheckFailed(state, plainError('check', e), d.now()))
      d.log(`[update] check failed: ${why(e)}`)
      return isRateLimited(e) ? 'rate-limited' : 'failed'
    } finally {
      active = null
    }
  }

  function start(firstDelayMs = FIRST_CHECK_DELAY_MS): void {
    started = true
    schedule(firstDelayMs)
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
    start(nextCheckDelay('ok', 0))
  }

  return {
    state: (): UpdateState => state,

    /** Read the saved setting, then broadcast the first state. Call once before start(). */
    async init(): Promise<void> {
      const autoCheck = await d.loadAutoCheck().catch(() => true)
      set({ ...state, autoCheck })
    },

    start,
    stop,
    installFailed,

    /** A check the person asked for (menu, Settings): runs even with automatic checks off. */
    async check(reason: string): Promise<{ checked: boolean; state: UpdateState }> {
      const outcome = await runCheck(reason)
      if (outcome) schedule(nextCheckDelay(outcome, failures))
      return { checked: outcome !== null, state }
    },

    async download(): Promise<UpdateActionResult> {
      if (active || updateAction(state) !== 'download' || state.mode !== 'install') return { accepted: false, state }
      active = 'download'
      const version = state.availableVersion!
      set(onDownloadStart(state))
      d.log(`[update] downloading ${version}`)
      try {
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

    /** Settings > "Check for updates" (`enabled` = automatic checks on). */
    status: (): { enabled: boolean } => ({ enabled: state.autoCheck }),

    async setEnabled(on: unknown): Promise<{ enabled: boolean }> {
      const autoCheck = on === true
      await d.saveAutoCheck(autoCheck)
      set({ ...state, autoCheck })
      // on: look right away. off: schedule() only clears the next look.
      schedule(0)
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
