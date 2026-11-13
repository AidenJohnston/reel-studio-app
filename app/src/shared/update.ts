// What main/updater.ts tells the window about updates, and the one rule both sides use to pick the action.
export type UpdateStatus = 'disabled' | 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'installing' | 'up-to-date' | 'error'

export type UpdateErrorContext = 'check' | 'download' | 'install'

/** install: this copy can download and install the update itself. page: it opens the download page instead. */
export type UpdateMode = 'install' | 'page'

export interface UpdateState {
  status: UpdateStatus
  mode: UpdateMode
  /** Page mode only because no download key is saved (or the server refused the saved one): the window also
   * offers "Turn on automatic updates". */
  keyNeeded: boolean
  autoCheck: boolean
  currentVersion: string
  availableVersion: string | null
  downloadedVersion: string | null
  /** The download page on getreelstudio.com that latest.json names. */
  releaseUrl: string | null
  downloadPercent: number | null
  message: string | null
  errorContext: UpdateErrorContext | null
  snoozed: boolean
}

export interface UpdateActionResult {
  accepted: boolean
  state: UpdateState
  refused?: 'exporting'
}

export interface UpdateBusy {
  exporting: boolean
  working: number
}

export function initialUpdateState(currentVersion: string, mode: UpdateMode, autoCheck: boolean, disabledReason: string | null): UpdateState {
  return {
    status: disabledReason ? 'disabled' : 'idle',
    mode,
    keyNeeded: false,
    autoCheck,
    currentVersion,
    availableVersion: null,
    downloadedVersion: null,
    releaseUrl: null,
    downloadPercent: null,
    message: disabledReason,
    errorContext: null,
    snoozed: false
  }
}

export type UpdateAction = 'download' | 'open-page' | 'install' | 'none'

export function updateAction(s: UpdateState): UpdateAction {
  if (s.downloadedVersion && (s.status === 'downloaded' || (s.status === 'error' && s.errorContext === 'install'))) return 'install'
  const offered = s.status === 'available' || (s.status === 'error' && s.errorContext === 'download' && !!s.availableVersion)
  if (!offered) return 'none'
  return s.mode === 'page' ? 'open-page' : 'download'
}

// Nothing downloads by itself, so a download in any state was started by the person: its strip stays even with
// automatic checks off, because the "Restart from the update button in the sidebar" copy points at it.
export function showsUpdateButton(s: UpdateState | null): boolean {
  if (!s) return false
  if (s.status === 'downloading') return true
  const started = !!s.downloadedVersion || (s.status === 'error' && s.errorContext !== 'check')
  return (s.autoCheck || started) && updateAction(s) !== 'none' && !s.snoozed
}
