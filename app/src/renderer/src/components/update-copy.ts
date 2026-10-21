import { updateAction, type UpdateState, type UpdateBusy, type ReleaseNotes } from '../../../shared/update'

export type UpdateIcon = 'available' | 'downloading' | 'downloaded' | 'failed'

export function updateIcon(s: UpdateState): UpdateIcon {
  if (s.status === 'downloading') return 'downloading'
  if (s.status === 'error') return 'failed'
  return updateAction(s) === 'install' ? 'downloaded' : 'available'
}

const pct = (s: UpdateState): string => (typeof s.downloadPercent === 'number' ? ` ${Math.floor(s.downloadPercent)}%` : '')

export function updateButtonLabel(s: UpdateState): string {
  if (s.status === 'downloading') return `Downloading${pct(s)}`
  const a = updateAction(s)
  if (a === 'install') return s.status === 'error' ? 'Try again' : 'Restart to update'
  if (s.status === 'error') return 'Try again'
  return 'Download update'
}

export function updateSummary(s: UpdateState): string {
  const v = s.downloadedVersion ?? s.availableVersion
  switch (s.status) {
    case 'checking':
      return 'Checking for updates…'
    case 'available':
      return s.mode === 'page' ? `Reel Studio ${v} is out. Download opens its page in your browser.` : `Reel Studio ${v} is ready to download.`
    case 'downloading':
      return `Downloading Reel Studio ${v}${pct(s)}.`
    case 'installing':
      return 'Restarting to install the update…'
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

export function updateHeadline(s: UpdateState): string {
  if (s.status === 'downloading') return `Downloading update${typeof s.downloadPercent === 'number' ? ` (${Math.floor(s.downloadPercent)}%)` : ''}`
  if (s.status === 'error') return s.errorContext === 'install' ? 'The update did not install' : 'The download stopped'
  if (updateAction(s) === 'install') return 'Update downloaded'
  return s.mode === 'page' ? 'Update available' : 'Update ready to download'
}

export function updateSubline(s: UpdateState): string {
  if (s.status === 'error') return s.errorContext === 'install' ? 'It did not install' : 'Download stopped'
  if (s.mode === 'page' && updateAction(s) === 'open-page') return 'Opens your browser'
  return `Version ${s.downloadedVersion ?? s.availableVersion ?? ''}`
}

export function releaseLinkLabel(n: ReleaseNotes): string {
  const more = Math.max(0, n.totalItems - n.items.length)
  return more === 0 ? 'Read more on GitHub' : `${more} more ${more === 1 ? 'change' : 'changes'} on GitHub`
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
    body: `Reel Studio closes for a moment and opens again on the new version. Your videos and settings stay.${stops}`,
    canInstall: true
  }
}
