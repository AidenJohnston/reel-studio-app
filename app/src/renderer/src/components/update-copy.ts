import { updateAction, type UpdateState, type UpdateBusy, type ReleaseNotes } from '../../../shared/update'

export type UpdateIcon = 'available' | 'downloading' | 'downloaded' | 'failed'

// Page mode only opens the release page in the browser, so no copy may promise a download or a retry.
const opensPage = (s: UpdateState): boolean => updateAction(s) === 'open-page'

export function updateIcon(s: UpdateState): UpdateIcon {
  if (s.status === 'downloading') return 'downloading'
  if (s.status === 'error' && !opensPage(s)) return 'failed'
  return updateAction(s) === 'install' ? 'downloaded' : 'available'
}

const pct = (s: UpdateState): string => (typeof s.downloadPercent === 'number' ? ` ${Math.floor(s.downloadPercent)}%` : '')
const offered = (s: UpdateState): string | null => s.downloadedVersion ?? s.availableVersion

export function updateButtonLabel(s: UpdateState): string {
  if (s.status === 'downloading') return `Downloading${pct(s)}`
  if (opensPage(s)) return 'Open download page'
  if (s.status === 'error') return s.errorContext === 'install' ? 'Update did not install' : 'Download stopped'
  return updateAction(s) === 'install' ? 'Restart to update' : 'Download update'
}

export function updateSummary(s: UpdateState): string {
  const v = offered(s)
  switch (s.status) {
    case 'checking':
      return 'Checking for updates…'
    case 'available':
      return s.mode === 'page' ? `Reel Studio ${v} is out. Click to open its download page in your browser.` : `Reel Studio ${v} is ready to download.`
    case 'downloading':
      return `Downloading Reel Studio ${v}${pct(s)}.`
    case 'installing':
      return 'Restarting to install the update…'
    case 'downloaded':
      return `Reel Studio ${v} is downloaded. Click to restart and install it.`
    case 'error':
      if (opensPage(s)) return `${s.message ?? `Reel Studio ${v} is out.`} Click to open its download page in your browser.`
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

export function updateHeadline(s: UpdateState): string {
  if (s.status === 'downloading') return `Downloading update${typeof s.downloadPercent === 'number' ? ` (${Math.floor(s.downloadPercent)}%)` : ''}`
  if (s.status === 'error' && !opensPage(s)) return updateButtonLabel(s)
  if (updateAction(s) === 'install') return 'Update downloaded'
  return s.mode === 'page' ? 'Update available' : 'Update ready to download'
}

export function updateSubline(s: UpdateState): string {
  if (s.status === 'error') return s.message ?? updateSummary(s)
  if (opensPage(s)) return `Reel Studio ${offered(s)}. Its download page opens in your browser.`
  return `Reel Studio ${offered(s)}`
}

export function notesHeading(n: ReleaseNotes, count: number): string {
  return count === 1 ? "What's new" : `What's new in ${n.version}`
}

export function releaseLinkLabel(n: ReleaseNotes): string {
  const more = Math.max(0, n.totalItems - n.items.length)
  return more === 0 ? 'View release on GitHub' : `${more} more ${more === 1 ? 'change' : 'changes'} on GitHub`
}

export function aboutStatus(s: UpdateState): string {
  const v = offered(s)
  const now = `Version ${s.currentVersion}`
  switch (s.status) {
    case 'checking':
      return `${now} · Checking for updates…`
    case 'up-to-date':
      return `${now} · Up to date`
    case 'available':
      return `${now} · ${v} is ${s.mode === 'page' ? 'out' : 'ready to download'}`
    case 'downloading':
      return `${now} · Downloading ${v}${pct(s)}`
    case 'downloaded':
      return `${now} · ${v} is downloaded`
    case 'installing':
      return `${now} · Restarting to update…`
    case 'error':
      return updateAction(s) === 'install' ? `${now} · ${v} is downloaded` : updateAction(s) !== 'none' ? `${now} · ${v} is out` : now
    default:
      return now
  }
}

export function aboutButton(s: UpdateState): string {
  const action = updateAction(s)
  if (action === 'open-page') return 'Open download page'
  if (action !== 'none') return s.status === 'error' ? 'Try again' : action === 'install' ? 'Restart to update' : 'Download'
  if (s.status === 'checking') return 'Checking…'
  if (s.status === 'downloading') return 'Downloading…'
  if (s.status === 'installing') return 'Restarting…'
  if (s.status === 'up-to-date') return 'Check again'
  if (s.status === 'error') return 'Try again'
  return 'Check for updates'
}

export interface InstallQuestion {
  title: string
  body: string
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
    body: `Reel Studio closes, installs the new version and opens again. Your videos and settings stay.${stops}`,
    canInstall: true
  }
}
