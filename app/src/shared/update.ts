export type UpdateStatus = 'disabled' | 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'installing' | 'up-to-date' | 'error'

export type UpdateErrorContext = 'check' | 'download' | 'install'

export type UpdateMode = 'install' | 'page'

export interface ReleaseNotes {
  version: string
  items: string[]
  totalItems: number
}

export interface ReleaseEntry {
  version: string
  date: string | null
  summary: string | null
  url: string
}

export const validDate = (d: unknown): string | null => (typeof d === 'string' && Number.isFinite(Date.parse(d)) ? d : null)

export interface UpdateState {
  status: UpdateStatus
  mode: UpdateMode
  autoCheck: boolean
  currentVersion: string
  availableVersion: string | null
  downloadedVersion: string | null
  /** Only releases newer than the running one, newest first. */
  releaseNotes: ReleaseNotes[]
  /** Newer releases left out of releaseNotes. */
  olderNotes: number
  releases: ReleaseEntry[]
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
    autoCheck,
    currentVersion,
    availableVersion: null,
    downloadedVersion: null,
    releaseNotes: [],
    olderNotes: 0,
    releases: [],
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

export function showsUpdateButton(s: UpdateState | null): boolean {
  return !!s && (s.status === 'downloading' || (s.autoCheck && updateAction(s) !== 'none' && !s.snoozed))
}
