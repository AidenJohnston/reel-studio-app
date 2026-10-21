// Updates: the state main/updater.ts broadcasts, and the words every surface shows for it (sidebar button,
// its release-notes popover, Settings, the install question). Ported from T3 Code's desktop updater
// (apps/web/src/components/desktopUpdate.logic.ts) with Reel Studio's plain words. No electron, no DOM:
// the renderer, main and the tests all read the same copy from here.

export type UpdateStatus = 'disabled' | 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'up-to-date' | 'error'

/** What failed last: the check, the download or the install. */
export type UpdateErrorContext = 'check' | 'download' | 'install'

/**
 * How this copy updates. `install`: download in the app, restart to install (macOS; Windows only once the
 * installer is signed). `page`: the app only says a version is out and opens its download page.
 */
export type UpdateMode = 'install' | 'page'

/** The "What's new" list of one release, already cut down to short plain lines (main/release-notes.ts). */
export interface ReleaseNotes {
  version: string
  items: string[]
  /** How many changes the release lists in all; more than items.length = "N more changes on GitHub". */
  totalItems: number
}

export interface UpdateState {
  status: UpdateStatus
  mode: UpdateMode
  /** Settings > "Check for updates": automatic checks. A check the person asks for runs either way. */
  autoCheck: boolean
  currentVersion: string
  availableVersion: string | null
  downloadedVersion: string | null
  releaseNotes: ReleaseNotes | null
  /** The release page of the available version (only ever our GitHub releases). */
  releaseUrl: string | null
  /** 0-100 while downloading, 100 once downloaded, else null. */
  downloadPercent: number | null
  /** ms since 1970 of the last check, or null. */
  checkedAt: number | null
  /** Why updates are off (status disabled), or what went wrong, in plain words. */
  message: string | null
  errorContext: UpdateErrorContext | null
}

export interface UpdateActionResult {
  /** The updater took the request (false: nothing to do, or something else is already running). */
  accepted: boolean
  state: UpdateState
  /** Set when an install was refused on purpose. */
  refused?: 'exporting'
}

/** What would be lost by restarting now (main asks again at the moment of installing). */
export interface UpdateBusy {
  /** An export is writing its file: installing waits. */
  exporting: boolean
  /** Edits and renders in progress: installing stops them. */
  working: number
}

export function initialUpdateState(currentVersion: string, mode: UpdateMode, autoCheck: boolean, disabledReason: string | null): UpdateState {
  return {
    status: disabledReason ? 'disabled' : 'idle',
    mode,
    autoCheck,
    currentVersion,
    availableVersion: null,
    downloadedVersion: null,
    releaseNotes: null,
    releaseUrl: null,
    downloadPercent: null,
    checkedAt: null,
    message: disabledReason,
    errorContext: null
  }
}

// ---- what the button does ------------------------------------------------------------------------

export type UpdateAction = 'download' | 'open-page' | 'install' | 'none'

/** The one thing clicking the update button does right now. */
export function updateAction(s: UpdateState): UpdateAction {
  if (s.downloadedVersion && (s.status === 'downloaded' || (s.status === 'error' && s.errorContext === 'install'))) return 'install'
  const offered = s.status === 'available' || (s.status === 'error' && s.errorContext === 'download' && !!s.availableVersion)
  if (!offered) return 'none'
  return s.mode === 'page' ? 'open-page' : 'download'
}

/** The sidebar button shows only when there is an update to act on or one on its way. */
export function showsUpdateButton(s: UpdateState | null): boolean {
  return !!s && (updateAction(s) !== 'none' || s.status === 'downloading')
}

export type UpdateIcon = 'available' | 'downloading' | 'downloaded' | 'failed'

export function updateIcon(s: UpdateState): UpdateIcon {
  if (s.status === 'downloading') return 'downloading'
  if (s.status === 'error') return 'failed'
  return updateAction(s) === 'install' ? 'downloaded' : 'available'
}

const pct = (s: UpdateState): string => (typeof s.downloadPercent === 'number' ? ` ${Math.floor(s.downloadPercent)}%` : '')

/** The button's own label: what clicking it does, in two or three words. */
export function updateButtonLabel(s: UpdateState): string {
  if (s.status === 'downloading') return `Downloading${pct(s)}`
  const a = updateAction(s)
  if (a === 'install') return s.status === 'error' ? 'Try the update again' : 'Restart to update'
  if (s.status === 'error') return 'Try the download again'
  return 'Download update'
}

/** One sentence on what is going on (T3 Code's tooltip), for the popover header and screen readers. */
export function updateSummary(s: UpdateState): string {
  const v = s.downloadedVersion ?? s.availableVersion
  switch (s.status) {
    case 'checking':
      return 'Checking for updates…'
    case 'available':
      return s.mode === 'page' ? `Reel Studio ${v} is out. Download opens its page in your browser.` : `Reel Studio ${v} is ready to download.`
    case 'downloading':
      return `Downloading Reel Studio ${v}${pct(s)}.`
    case 'downloaded':
      return `Reel Studio ${v} is downloaded. Click to restart and install it.`
    case 'error':
      if (s.errorContext === 'download' && s.availableVersion) return `The download of ${s.availableVersion} stopped. Click to try again.`
      if (s.errorContext === 'install' && s.downloadedVersion) return `Reel Studio ${s.downloadedVersion} did not install. Click to try again.`
      return s.message ?? 'I could not check for updates.'
    case 'up-to-date':
      return `You have the newest version (${s.currentVersion}).`
    case 'disabled':
      return s.message ?? 'Updates are not available in this copy of Reel Studio.'
    default:
      return 'Check for updates'
  }
}

// ---- release notes popover -----------------------------------------------------------------------

/** The popover's first line (T3 Code: "Update ready to download"). */
export function updateHeadline(s: UpdateState): string {
  if (s.status === 'downloading') return `Downloading update${typeof s.downloadPercent === 'number' ? ` (${Math.floor(s.downloadPercent)}%)` : ''}`
  if (s.status === 'error') return s.errorContext === 'install' ? 'The update did not install' : 'The download stopped'
  if (updateAction(s) === 'install') return 'Update downloaded'
  return s.mode === 'page' ? 'Update available' : 'Update ready to download'
}

/** The button's second line: which version, or what went wrong. Short: the sidebar leaves it about 120 px. */
export function updateSubline(s: UpdateState): string {
  if (s.status === 'error') return s.errorContext === 'install' ? 'It did not install' : 'Download stopped'
  if (s.mode === 'page' && updateAction(s) === 'open-page') return 'Opens your browser'
  return `Version ${s.downloadedVersion ?? s.availableVersion ?? ''}`
}

/** "Read more on GitHub", or "3 more changes on GitHub" when the list was cut. */
export function releaseLinkLabel(n: ReleaseNotes): string {
  const more = Math.max(0, n.totalItems - n.items.length)
  return more === 0 ? 'Read more on GitHub' : `${more} more ${more === 1 ? 'change' : 'changes'} on GitHub`
}

// ---- install question ----------------------------------------------------------------------------

export interface InstallQuestion {
  title: string
  body: string
  /** false: it cannot install right now (an export is writing); show OK only. */
  canInstall: boolean
}

export function installQuestion(s: Pick<UpdateState, 'availableVersion' | 'downloadedVersion'>, busy: UpdateBusy): InstallQuestion {
  const v = s.downloadedVersion ?? s.availableVersion
  if (busy.exporting) {
    return {
      title: 'Your export is still saving',
      body: 'Wait until it is done, then restart to update. Restarting now could leave a broken file.',
      canInstall: false
    }
  }
  const stops =
    busy.working > 0
      ? busy.working === 1
        ? ' A video is being made right now: restarting stops it, and you can start it again after the update.'
        : ` ${busy.working} videos are being made right now: restarting stops them, and you can start them again after the update.`
      : ''
  return {
    title: `Install update${v ? ` ${v}` : ''} and restart Reel Studio?`,
    body: `Reel Studio closes for a moment and opens again on the new version. Your videos and settings stay.${stops}`,
    canInstall: true
  }
}

// ---- Settings row --------------------------------------------------------------------------------

export interface SettingsUpdateRow {
  text: string
  button: string | null
  disabled: boolean
}

/** Settings > About: one line of status and one button (T3 Code: Download / Downloading… / Install / Up to Date / Checking…). */
export function settingsUpdateRow(s: UpdateState): SettingsUpdateRow {
  const a = updateAction(s)
  if (a !== 'none') {
    // The summary's "Click to ..." talks about the sidebar button; here the button sits next to it.
    const text = updateSummary(s).replace(/ Click to .*$/, '')
    const retry = s.status === 'error'
    return { text, button: retry ? 'Try again' : a === 'install' ? 'Restart to update' : 'Download', disabled: false }
  }
  switch (s.status) {
    case 'disabled':
      return { text: updateSummary(s), button: null, disabled: true }
    case 'checking':
      return { text: 'Checking for updates…', button: 'Checking…', disabled: true }
    case 'downloading':
      return { text: updateSummary(s), button: 'Downloading…', disabled: true }
    case 'up-to-date':
      return { text: updateSummary(s), button: 'Check again', disabled: false }
    case 'error':
      return { text: s.message ?? 'I could not check for updates.', button: 'Try again', disabled: false }
    default:
      return { text: `You have Reel Studio ${s.currentVersion}.`, button: 'Check for updates', disabled: false }
  }
}
