// electron-updater as an UpdateBackend (main/updater.ts). Configured like T3 Code's desktop app: never
// downloads or installs on its own (autoDownload and autoInstallOnAppQuit off).
//
// Which release: main's rule, not electron-updater's (main/update-check.ts newestRelease): the highest vX.Y.Z
// tag among published releases, GitHub pre-releases included, other tags such as ffmpeg-7.1.1-rs2 ignored.
// electron-updater's GitHub provider follows /releases/latest, which skips pre-releases; with allowPrerelease
// it takes the newest release of any tag instead, so an ffmpeg source release published after an app release
// would make every check fail. So each check reads GitHub's releases list once (the same request the old
// update note made), then points electron-updater at that release's folder, where it reads latest-mac.yml
// and later downloads the zip it names, checked against its sha512 before Squirrel.Mac installs it.
//
// resources/app-update.yml (electron-builder writes it from the `publish` block) still has to exist:
// electron-updater reads its download cache folder name from it.
import { autoUpdater, type ProgressInfo } from 'electron-updater'
import { newerRelease, type FetchLike } from './update-check'
import type { UpdateBackend } from './updater'

/**
 * electron-updater sends `x-user-staging-id` on every request: a random id it creates per install and keeps
 * in userData/.updaterId, so a server could tell one copy from another. Reel Studio promises that nothing
 * about the person is sent, so every copy sends the same all-zero id. (It is only used for staged rollouts,
 * which Reel Studio does not do.)
 */
export const SAME_FOR_EVERYONE = { 'x-user-staging-id': '00000000-0000-0000-0000-000000000000' }

export function electronUpdaterBackend(opts: {
  version: string
  fetch: FetchLike
  /** GitHub's releases list (a local server in the update e2e). */
  releasesApi: string
  /** The folder holding a release's files, e.g. https://github.com/<repo>/releases/download/v0.1.3 */
  releaseFolder(tag: string): string
  log(line: string): void
  /** Test runs only: a dev-app-update.yml (app/e2e/update.spec.ts). */
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
  u.allowDowngrade = false
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
      const found = await newerRelease(opts.fetch, opts.version, opts.releasesApi)
      if (!found) return null
      u.setFeedURL({ provider: 'generic', url: opts.releaseFolder(`v${found.version}`) })
      const r = await u.checkForUpdates()
      if (!r) throw new Error('The updater is not active in this build.')
      // latest-mac.yml names an older version than its release tag: nothing to install
      if (!r.isUpdateAvailable) return null
      return { version: r.updateInfo.version, notes: found.notes, releaseUrl: found.url }
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
