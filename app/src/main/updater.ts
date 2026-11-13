// The update state machine behind the sidebar button, Settings and the Mac menu. It finds a newer version with
// the anonymous daily check (main/update-check.ts) and, when the person says yes, downloads and installs it
// through a backend (main/updater-electron.ts). Nothing downloads by itself.
//
// A copy that can install (a Mac app in Applications) still opens the download page when no download key is
// saved, or when the update server refuses the key: 401 (not ours) clears it, 403 (the purchase no longer
// includes updates) keeps it. Without a key the window also offers "Turn on automatic updates".
import type { MessageBoxOptions } from 'electron'
import { AUTO_UPDATES_PAGE, UPDATE_PAGE, allowedReleaseUrl, isNewer, releaseNotes, type SiteAnswer } from './update-check'
import {
  FIRST_CHECK_DELAY_MS,
  BUSY_RETRY_MS,
  UPDATE_MEMORY_DEFAULTS,
  isSnoozed,
  nextCheckIn,
  plainError,
  SNOOZE_MS,
  stillNewer,
  validDismissal,
  type CheckOutcome,
  type Dismissal,
  type UpdateMemory
} from './update-machine'
import { initialUpdateState, showsUpdateButton, updateAction, type UpdateActionResult, type UpdateBusy, type UpdateMode, type UpdateState } from '../shared/update'

/**
 * Why an update this copy could install opens the download page instead.
 * - no-key: no download key is saved.
 * - key-rejected: the server answered 401 to the saved key (the backend has cleared it).
 * - not-entitled: the server answered 403: the purchase no longer includes updates.
 * - feed: the update feed is missing for this platform or names another version.
 */
export type PageReason = 'no-key' | 'key-rejected' | 'not-entitled' | 'feed'

export interface UpdateBackend {
  /** The anonymous daily check: the newer release (or null) and the release notes. Throws when the site could
   * not tell. */
  check(): Promise<SiteAnswer>
  /** Whether a download key is saved. Asks no server. */
  hasKey(): Promise<boolean>
  /** Downloads `version` with the saved key. Resolves to null when it is downloaded, or to why it must come
   * from the download page instead. Throws on anything worth retrying (offline, damaged download). */
  download(version: string, onProgress: (percent: number) => void): Promise<PageReason | null>
  /** Checks the downloaded update. Runs before anything is stopped for the restart. */
  verify(): Promise<void>
  install(): void
}

export interface UpdaterDeps {
  version: string
  mode: UpdateMode
  disabledReason: string | null
  backend: UpdateBackend | null
  load(): Promise<UpdateMemory>
  save(patch: Partial<UpdateMemory>): Promise<unknown>
  busy(): UpdateBusy
  prepareToQuit(): Promise<void>
  openExternal(url: string): Promise<void>
  send(s: UpdateState): void
  log(line: string): void
  now(): number
}

type Action = 'check' | 'download' | 'install'

const why = (e: unknown): string => String(e instanceof Error ? e.message : e).slice(0, 300)

/** What the window says after the server or the feed sent a download to the page. no-key needs no words: the
 * "Turn on automatic updates" button says it. */
const PAGE_MESSAGE: Record<Exclude<PageReason, 'no-key'>, (version: string) => string> = {
  'key-rejected': (v) =>
    `The update server did not accept the download key saved on this computer, so automatic updates are off. Turn them on again with the link in your receipt email, or get Reel Studio ${v} from the download page.`,
  'not-entitled': (v) => `Your purchase no longer includes new versions, so Reel Studio ${v} is not downloading here. You can get it from the download page.`,
  feed: (v) => `Reel Studio ${v} cannot update itself on this computer. Get it from the download page instead.`
}

export function createUpdater(d: UpdaterDeps) {
  let state = initialUpdateState(d.version, d.mode, true, d.disabledReason)
  let active: Action | null = null
  let checking: Promise<CheckOutcome | null> | null = null
  let automaticGeneration = 0
  let manualCheck = false
  let lastAnswered: number | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let started = false
  let dismissed: Dismissal | null = null
  let snoozeEnd: ReturnType<typeof setTimeout> | null = null
  /** A download key is saved. Read at start and before each check; index.ts reports changes (keyChanged). */
  let keyed = false
  // electron-updater hands back its cached file while its SHA-512 still matches the feed, so downloading a release
  // whose file failed verify() again would fail the same way. Until the app restarts, that release opens its page.
  let rejected: string | null = null
  /** The server refused the key's purchase (403) or the feed did not fit, for this version, until the app restarts
   * or (for a refusal) another key is saved. */
  let pageOnly: { version: string; reason: 'not-entitled' | 'feed' } | null = null
  /** The version the last check in this run found. One remembered from an earlier run is checked again before it
   * downloads, so the keyed request goes out only for the release latest.json names now. */
  let confirmed: string | null = null

  const set = (next: UpdateState): void => {
    state = { ...next, snoozed: isSnoozed(dismissed, next, d.now()) }
    d.send(state)
  }
  const remember = (patch: Partial<UpdateMemory>): void =>
    void d.save(patch).catch((e) => d.log(`[update] could not save: ${why(e)}`))
  const enabled = (): boolean => d.disabledReason === null && d.backend !== null
  const withNotes = (notes: unknown): UpdateState['notes'] => releaseNotes(notes).map((n) => ({ ...n, newer: isNewer(n.version, d.version) }))

  /** How `version` is offered: installed here, or its download page (with "Turn on automatic updates" when only
   * a key is missing). */
  function offer(version: string): Pick<UpdateState, 'mode' | 'keyNeeded'> {
    if (d.mode !== 'install' || version === rejected || pageOnly?.version === version) return { mode: 'page', keyNeeded: false }
    return keyed ? { mode: 'install', keyNeeded: false } : { mode: 'page', keyNeeded: true }
  }

  async function readKey(): Promise<void> {
    if (!enabled()) return
    keyed = await d.backend!.hasKey().catch((e) => {
      d.log(`[update] could not read the download key: ${why(e)}`)
      return false
    })
  }

  function armSnoozeEnd(): void {
    if (snoozeEnd) clearTimeout(snoozeEnd)
    snoozeEnd = null
    const left = dismissed ? dismissed.at + SNOOZE_MS - d.now() : 0
    if (left <= 0) return
    snoozeEnd = setTimeout(() => set(state), left)
    snoozeEnd.unref?.()
  }

  function applyFound({ update: found, notes }: SiteAnswer): void {
    confirmed = found?.version ?? null
    state = { ...state, notes: withNotes(notes) }
    remember({ updateNotes: notes })
    if (found) {
      const url = allowedReleaseUrl(found.url) ?? UPDATE_PAGE
      const downloaded = state.downloadedVersion === found.version
      set({
        ...state,
        ...(downloaded ? { status: 'downloaded', mode: state.mode, keyNeeded: false } : { status: 'available', ...offer(found.version) }),
        availableVersion: found.version, downloadedVersion: downloaded ? found.version : null,
        releaseUrl: url, downloadPercent: downloaded ? 100 : null, message: null, errorContext: null
      })
      remember({ updateLatest: { version: found.version, url } })
      d.log(`[update] ${found.version} is available`)
    } else {
      set(state.downloadedVersion
        ? { ...state, status: 'downloaded', availableVersion: state.downloadedVersion, downloadPercent: 100, message: null, errorContext: null }
        : { ...initialUpdateState(d.version, d.mode, state.autoCheck, null), status: 'up-to-date', notes: state.notes })
      if (state.status === 'up-to-date') remember({ updateLatest: null })
      d.log('[update] up to date')
    }
  }

  function schedule(ms: number): void {
    if (timer) clearTimeout(timer)
    timer = null
    if (!started || !enabled() || !state.autoCheck) return
    timer = setTimeout(() => void tick(), ms)
    timer.unref?.()
  }

  async function tick(): Promise<void> {
    const outcome = await runCheck('auto')
    schedule(outcome ? nextCheckIn(outcome, lastAnswered, d.now()) : BUSY_RETRY_MS)
  }

  function offerRemembered(base: UpdateState, latest: unknown): UpdateState {
    const kept = stillNewer(latest, d.version)
    if (!kept || !enabled()) return base
    return { ...base, status: 'available', ...offer(kept.version), availableVersion: kept.version, releaseUrl: kept.url }
  }

  function answered(): void {
    lastAnswered = d.now()
    remember({ updateCheckedAt: lastAnswered })
  }

  function runCheck(reason: string): Promise<CheckOutcome | null> {
    if (checking) {
      // A manual request may join the fetch without inheriting automatic opt-out cancellation.
      if (reason !== 'auto') manualCheck = true
      return checking
    }
    manualCheck = reason !== 'auto'
    checking = performCheck(reason).finally(() => { checking = null })
    return checking
  }

  async function performCheck(reason: string): Promise<CheckOutcome | null> {
    if (!enabled() || active || (reason === 'auto' && !state.autoCheck)) return null
    const generation = automaticGeneration
    active = 'check'
    if (!state.availableVersion) set({ ...state, status: 'checking', message: null, errorContext: null })
    d.log(`[update] checking (${reason}), running ${d.version}`)
    try {
      const found = await d.backend!.check()
      await readKey()
      if (!manualCheck && (generation !== automaticGeneration || !state.autoCheck)) return null
      applyFound(found)
      answered()
      return 'answered'
    } catch (e) {
      if (!manualCheck && (generation !== automaticGeneration || !state.autoCheck)) return null
      if (!state.availableVersion) set({ ...state, status: 'error', message: plainError('check', e), errorContext: 'check' })
      d.log(`[update] check failed: ${why(e)}`)
      return 'failed'
    } finally {
      active = null
    }
  }

  /** The server or the feed sent this download to the page. */
  function fallBack(version: string, reason: PageReason): void {
    if (reason === 'no-key' || reason === 'key-rejected') keyed = false
    else pageOnly = { version, reason }
    const base: UpdateState = { ...state, availableVersion: version, downloadedVersion: null, downloadPercent: null, ...offer(version) }
    set(reason === 'no-key'
      ? { ...base, status: 'available', message: null, errorContext: null }
      : { ...base, status: 'error', message: PAGE_MESSAGE[reason](version), errorContext: 'download' })
    d.log(`[update] ${version} opens its download page (${reason})`)
  }

  function start(firstDelayMs = FIRST_CHECK_DELAY_MS): void {
    started = true
    schedule(Math.max(firstDelayMs, nextCheckIn('answered', lastAnswered, d.now())))
  }

  function stop(): void {
    started = false
    if (timer) clearTimeout(timer)
    timer = null
  }

  function installFailed(e: unknown): void {
    if (active !== 'install') return
    active = null
    set({ ...state, status: 'error', message: plainError('install', e), errorContext: 'install' })
    d.log(`[update] install failed: ${why(e)}`)
    start()
  }

  const open = (url: string): Promise<void> => d.openExternal(url)

  return {
    state: (): UpdateState => state,

    async init(): Promise<void> {
      const mem = await d.load().catch((e) => {
        d.log(`[update] could not read settings: ${why(e)}`)
        return UPDATE_MEMORY_DEFAULTS
      })
      const at = mem.updateCheckedAt
      lastAnswered = typeof at === 'number' && Number.isFinite(at) ? at : null
      dismissed = validDismissal(mem.updateDismissed)
      await readKey()
      const kept = stillNewer(mem.updateLatest, d.version)
      if (mem.updateLatest && !kept) remember({ updateLatest: null })
      const first: UpdateState = { ...state, autoCheck: mem.checkUpdates, notes: enabled() ? withNotes(mem.updateNotes) : [] }
      set(mem.checkUpdates ? offerRemembered(first, mem.updateLatest) : first)
      armSnoozeEnd()
    },

    start,
    stop,
    installFailed,

    async check(reason: string): Promise<{ checked: boolean; state: UpdateState }> {
      const outcome = await runCheck(reason)
      if (outcome) schedule(nextCheckIn(outcome, lastAnswered, d.now()))
      return { checked: outcome !== null, state }
    },

    async download(): Promise<UpdateActionResult> {
      if (checking) await checking
      if (active || updateAction(state) !== 'download' || state.mode !== 'install') return { accepted: false, state }
      active = 'download'
      const version = state.availableVersion!
      if (dismissed) {
        dismissed = null
        remember({ updateDismissed: null })
        armSnoozeEnd()
      }
      set({ ...state, status: 'downloading', downloadPercent: 0, message: null, errorContext: null })
      d.log(`[update] downloading ${version}`)
      try {
        if (confirmed !== version) {
          const answer = await d.backend!.check()
          if (answer.update?.version !== version) {
            applyFound(answer)
            return { accepted: true, state }
          }
          state = { ...state, notes: withNotes(answer.notes) }
          remember({ updateNotes: answer.notes })
          confirmed = version
        }
        const page = await d.backend!.download(version, (p) => {
          const percent = Number.isFinite(p) ? Math.min(100, Math.max(0, p)) : 0
          if (Math.floor(percent) !== Math.floor(state.downloadPercent ?? -1)) set({ ...state, downloadPercent: percent })
        })
        if (page) fallBack(version, page)
        else {
          set({ ...state, status: 'downloaded', availableVersion: version, downloadedVersion: version, downloadPercent: 100, message: null, errorContext: null })
          d.log(`[update] downloaded ${version}`)
        }
      } catch (e) {
        set({ ...state, status: 'error', message: plainError('download', e), downloadPercent: null, errorContext: 'download' })
        d.log(`[update] download failed: ${why(e)}`)
      } finally {
        active = null
      }
      return { accepted: true, state }
    },

    async install(): Promise<UpdateActionResult> {
      if (checking) await checking
      if (active || updateAction(state) !== 'install') return { accepted: false, state }
      if (d.busy().exporting) return { accepted: false, state, refused: 'exporting' }
      active = 'install'
      set({ ...state, status: 'installing' })
      d.log(`[update] installing ${state.downloadedVersion}`)
      stop()
      try {
        await d.backend!.verify()
      } catch (e) {
        // The file itself is wrong (or gone), and a new download would return the same cached file.
        const version = state.downloadedVersion!
        active = null
        rejected = version
        set({
          ...state, status: 'error', mode: 'page', keyNeeded: false, availableVersion: version, downloadedVersion: null, downloadPercent: null, errorContext: 'download',
          message: `The downloaded update did not pass its check, so it was not installed. Get Reel Studio ${version} from its download page instead.`
        })
        d.log(`[update] downloaded update rejected: ${why(e)}`)
        start()
        return { accepted: true, state }
      }
      try {
        await d.prepareToQuit()
        d.backend!.install()
      } catch (e) {
        installFailed(e)
      }
      return { accepted: true, state }
    },

    /** The download page latest.json named; never a page off the site. */
    openRelease: (): Promise<void> => open(allowedReleaseUrl(state.releaseUrl) ?? UPDATE_PAGE),

    /** "Turn on automatic updates": the site page that emails a link carrying the person's key. */
    openAutoUpdatesPage: (): Promise<void> => open(AUTO_UPDATES_PAGE),

    /** A download key was saved or removed (Settings, a reelstudio:// link, or a 401). */
    keyChanged(on: boolean): void {
      keyed = on
      if (on && pageOnly?.reason === 'not-entitled') pageOnly = null // another key may belong to another purchase
      const v = state.availableVersion
      const waiting = state.status === 'available' || (state.status === 'error' && state.errorContext === 'download')
      // A download or install under way keeps its state; the next download reads the key again.
      if (active || !v || state.downloadedVersion || !waiting) return
      set({ ...state, status: 'available', ...offer(v), message: null, errorContext: null })
    },

    async dismiss(version: unknown): Promise<UpdateState> {
      if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) return state
      dismissed = { version, at: d.now() }
      await d.save({ updateDismissed: dismissed })
      set(state)
      armSnoozeEnd()
      d.log(`[update] not now: ${version}`)
      return state
    },

    assertCanStartWork(): void {
      if (active === 'install') throw { code: 'UPDATING', userMessage: 'Reel Studio is restarting to install an update. Try again after it opens.' }
    },

    async setEnabled(on: unknown): Promise<void> {
      const autoCheck = on === true
      if (!autoCheck) automaticGeneration++
      await d.save({ checkUpdates: autoCheck })
      const latest = autoCheck && state.availableVersion === null ? (await d.load().catch(() => null))?.updateLatest : null
      const next: UpdateState = { ...state, autoCheck }
      if (!autoCheck && next.status === 'checking') next.status = 'idle'
      set(autoCheck && next.availableVersion === null ? offerRemembered(next, latest) : next)
      schedule(nextCheckIn('answered', lastAnswered, d.now()))
    }
  }
}

export type Updater = ReturnType<typeof createUpdater>

/** The Mac menu's "Check for Updates…". */
export async function menuCheckForUpdates(
  u: Pick<Updater, 'check' | 'state' | 'download' | 'openRelease' | 'openAutoUpdatesPage'>,
  ui: { focus(): void; show(o: MessageBoxOptions): Promise<{ response: number }> }
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
    const buttons = page ? ['Open download page', ...(s.keyNeeded ? ['Turn on automatic updates'] : []), 'Not now'] : ['Download', 'Not now']
    const r = await ui.show({
      type: 'info',
      title: 'Update available',
      message: `Reel Studio ${v} is available`,
      detail: page
        ? s.message ?? (s.keyNeeded
          ? 'Its download page opens in your browser. With automatic updates on, Reel Studio offers to update itself: say yes and it downloads the new version and installs it when you restart.'
          : 'Its download page opens in your browser.')
        : 'It downloads in the background. When it is done, restart from the update button in the sidebar.',
      buttons,
      defaultId: 0,
      cancelId: buttons.length - 1
    })
    if (r.response === 0) await (page ? u.openRelease() : u.download())
    else if (page && s.keyNeeded && r.response === 1) await u.openAutoUpdatesPage()
  } else if (action === 'install') {
    // After "Not now" the sidebar button stays hidden, even through this check; Settings always offers the restart.
    const detail = showsUpdateButton(s) ? 'Restart from the update button in the sidebar to install it.' : 'To install it, open Settings and choose Restart to update.'
    await ui.show({ type: 'info', title: 'Update ready', message: `Reel Studio ${v} is downloaded`, detail, buttons: ['OK'] })
  } else if (s.status === 'up-to-date') {
    await ui.show({ type: 'info', title: "You're up to date", message: "You're up to date", detail: `Reel Studio ${s.currentVersion} is the newest version.`, buttons: ['OK'] })
  } else if (s.status === 'error') {
    await ui.show({ type: 'warning', title: 'Update check failed', message: 'Update check failed', detail: s.message ?? 'Try again later.', buttons: ['OK'] })
  }
}
