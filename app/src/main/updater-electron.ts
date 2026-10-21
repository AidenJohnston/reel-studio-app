// electron-updater as an UpdateBackend (main/updater.ts). Configured like T3 Code's desktop app: never
// downloads or installs on its own (autoDownload and autoInstallOnAppQuit off), stable releases only.
//
// Where it asks: the feed in resources/app-update.yml, which electron-builder writes from the `publish`
// block in packaging/electron-builder.yml (GitHub, AidenJohnston/reel-studio-app). A check is two GETs to
// github.com (the releases.atom feed and /releases/latest) plus latest-mac.yml from the release; a download
// is the Mac zip named in latest-mac.yml, checked against its sha512 before Squirrel.Mac installs it.
import { autoUpdater, type ProgressInfo } from 'electron-updater'
import type { UpdateBackend } from './updater'

/**
 * electron-updater sends `x-user-staging-id` on every request: a random id it creates per install and keeps
 * in userData/.updaterId, so a server could tell one copy from another. Reel Studio promises that nothing
 * about the person is sent, so every copy sends the same all-zero id. (It is only used for staged rollouts,
 * which Reel Studio does not do.)
 */
export const SAME_FOR_EVERYONE = { 'x-user-staging-id': '00000000-0000-0000-0000-000000000000' }

export function electronUpdaterBackend(opts: {
  log(line: string): void
  /** Test runs only: a dev-app-update.yml pointing at a local server (app/e2e/update.spec.ts). */
  devFeedFile?: string
  /** Errors electron-updater reports by event, not by promise (Squirrel.Mac's install). */
  onError(e: unknown): void
}): UpdateBackend {
  const u = autoUpdater
  u.logger = {
    info: (m: unknown) => opts.log(`[updater] ${String(m)}`),
    warn: (m: unknown) => opts.log(`[updater] warn: ${String(m)}`),
    error: (m: unknown) => opts.log(`[updater] error: ${String(m)}`)
  }
  u.autoDownload = false
  u.autoInstallOnAppQuit = false
  u.allowPrerelease = false
  u.allowDowngrade = false
  u.fullChangelog = false
  // Releases carry no .blockmap files (packaging/sign-mac.sh zips the signed app itself), so a differential
  // download could only fail first and then fetch the whole zip.
  u.disableDifferentialDownload = true
  u.requestHeaders = { ...SAME_FOR_EVERYONE }
  if (opts.devFeedFile) {
    u.forceDevUpdateConfig = true
    u.updateConfigPath = opts.devFeedFile
  }
  // Without a listener an 'error' event would throw. Check and download errors also reject their promise,
  // which main/updater.ts handles; this one matters for the install.
  u.on('error', (e) => opts.onError(e))

  return {
    async check() {
      const r = await u.checkForUpdates()
      if (!r) throw new Error('The updater is not active in this build.')
      if (!r.isUpdateAvailable) return null
      return { version: r.updateInfo.version, notes: r.updateInfo.releaseNotes ?? null, releaseUrl: null }
    },
    async download(onProgress) {
      const progress = (p: ProgressInfo): void => onProgress(p.percent)
      u.on('download-progress', progress)
      try {
        await u.downloadUpdate()
      } finally {
        u.removeListener('download-progress', progress)
      }
    },
    install() {
      // silent + run after: Windows runs the installer without its pages and reopens the app; macOS ignores both
      u.quitAndInstall(true, true)
    }
  }
}
