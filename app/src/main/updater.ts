import type { MessageBoxOptions } from 'electron'
import { allowedReleaseUrl, pageFor, type ReleaseCheck } from './update-check'
import { notesSince } from './release-notes'
import {
  FIRST_CHECK_DELAY_MS,
  isRateLimited,
  BUSY_RETRY_MS,
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
import { initialUpdateState, updateAction, type UpdateActionResult, type UpdateBusy, type UpdateMode, type UpdateState } from '../shared/update'

export interface UpdateBackend {
  check(): Promise<ReleaseCheck>
  download(onProgress: (percent: number) => void): Promise<void>
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
  // A persisted notice has no electron-updater download target until its release is checked again.
  let fresh = false

  const set = (next: UpdateState): void => {
    state = { ...next, snoozed: isSnoozed(dismissed, next, d.now()) }
    d.send(state)
  }
  const remember = (patch: Partial<UpdateMemory>): void =>
    void d.save(patch).catch((e) => d.log(`[update] could not save: ${why(e)}`))

  function armSnoozeEnd(): void {
    if (snoozeEnd) clearTimeout(snoozeEnd)
    snoozeEnd = null
    const left = dismissed ? dismissed.at + SNOOZE_MS - d.now() : 0
    if (left <= 0) return
    snoozeEnd = setTimeout(() => set(state), left)
    snoozeEnd.unref?.()
  }

  function applyFound({ update: found, releases: all, pageOnly }: ReleaseCheck): void {
    if (found) {
      const url = allowedReleaseUrl(found.releaseUrl) ?? pageFor(`v${found.version}`)
      const { notes, older } = notesSince(all, d.version)
      const downloaded = state.downloadedVersion === found.version
      set({
        ...state, status: downloaded ? 'downloaded' : 'available', mode: downloaded ? state.mode : pageOnly ? 'page' : d.mode, availableVersion: found.version,
        downloadedVersion: downloaded ? found.version : null, releaseNotes: notes, olderNotes: older,
        releaseUrl: url, downloadPercent: downloaded ? 100 : null, message: null, errorContext: null
      })
      remember({ updateLatest: { version: found.version, url, notes, older } })
      d.log(`[update] ${found.version} is available`)
    } else {
      set(state.downloadedVersion
        ? { ...state, status: 'downloaded', availableVersion: state.downloadedVersion, downloadPercent: 100, message: null, errorContext: null }
        : { ...initialUpdateState(d.version, d.mode, state.autoCheck, null), status: 'up-to-date' })
      if (state.status === 'up-to-date') remember({ updateLatest: null })
      d.log('[update] up to date')
    }
    fresh = found !== null && !pageOnly
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
    schedule(outcome ? nextCheckIn(outcome, lastAnswered, d.now()) : BUSY_RETRY_MS)
  }

  function offerRemembered(base: UpdateState, latest: unknown): UpdateState {
    const kept = stillNewer(latest, d.version)
    if (!kept || !enabled()) return base
    return { ...base, status: 'available', availableVersion: kept.version, releaseNotes: kept.notes ?? [], olderNotes: kept.older ?? 0, releaseUrl: kept.url }
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
    fresh = false
    if (!state.availableVersion) set({ ...state, status: 'checking', message: null, errorContext: null })
    d.log(`[update] checking (${reason}), running ${d.version}`)
    try {
      const result = await d.backend!.check()
      if (!manualCheck && (generation !== automaticGeneration || !state.autoCheck)) return null
      applyFound(result)
      answered()
      return 'answered'
    } catch (e) {
      if (!manualCheck && (generation !== automaticGeneration || !state.autoCheck)) return null
      if (!state.availableVersion) set({ ...state, status: 'error', message: plainError('check', e), errorContext: 'check' })
      d.log(`[update] check failed: ${why(e)}`)
      if (!isRateLimited(e)) return 'failed'
      answered()
      return 'answered'
    } finally {
      active = null
    }
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

  return {
    state: (): UpdateState => state,

    async init(): Promise<void> {
      const mem = await d.load().catch((e) => {
        d.log(`[update] could not read settings: ${why(e)}`)
        return { checkUpdates: true, updateCheckedAt: null, updateLatest: null, updateDismissed: null }
      })
      const at = mem.updateCheckedAt
      lastAnswered = typeof at === 'number' && Number.isFinite(at) ? at : null
      dismissed = validDismissal(mem.updateDismissed)
      const kept = stillNewer(mem.updateLatest, d.version)
      if (mem.updateLatest && !kept) remember({ updateLatest: null })
      const first: UpdateState = { ...state, autoCheck: mem.checkUpdates }
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
        if (!fresh) {
          const result = await d.backend!.check()
          if (result.update?.version !== version || result.pageOnly) {
            applyFound(result)
            return { accepted: true, state }
          }
          fresh = true
        }
        await d.backend!.download((p) => {
          const percent = Number.isFinite(p) ? Math.min(100, Math.max(0, p)) : 0
          if (Math.floor(percent) !== Math.floor(state.downloadPercent ?? -1)) set({ ...state, downloadPercent: percent })
        })
        set({ ...state, status: 'downloaded', availableVersion: version, downloadedVersion: version, downloadPercent: 100, message: null, errorContext: null })
        d.log(`[update] downloaded ${version}`)
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
        // The file itself is wrong (or gone): offer a fresh download instead of retrying the same install.
        active = null
        fresh = false
        set({ ...state, status: 'error', downloadedVersion: null, downloadPercent: null, message: 'The downloaded update did not pass its check. Download it again.', errorContext: 'download' })
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

    async openRelease(version?: unknown): Promise<void> {
      if (version !== undefined) {
        if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) return
        await d.openExternal(pageFor(`v${version}`))
        return
      }
      const v = state.downloadedVersion ?? state.availableVersion
      const url = allowedReleaseUrl(state.releaseUrl) ?? (v ? pageFor(`v${v}`) : null)
      if (url) await d.openExternal(url)
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

export async function menuCheckForUpdates(
  u: Pick<Updater, 'check' | 'state' | 'download' | 'openRelease'>,
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
