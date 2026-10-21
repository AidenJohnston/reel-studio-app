import type { AppUpdater, ProgressInfo } from 'electron-updater'
import { newerRelease, type FetchLike } from './update-check'
import type { UpdateBackend } from './updater'

// A shared staging ID preserves the promise that update requests identify no individual install.
export const SAME_FOR_EVERYONE = { 'x-user-staging-id': '00000000-0000-0000-0000-000000000000' }

export type UpdaterLike = Pick<
  AppUpdater,
  | 'logger'
  | 'autoDownload'
  | 'autoInstallOnAppQuit'
  | 'allowDowngrade'
  | 'disableDifferentialDownload'
  | 'requestHeaders'
  | 'forceDevUpdateConfig'
  | 'updateConfigPath'
  | 'setFeedURL'
  | 'checkForUpdates'
  | 'downloadUpdate'
  | 'quitAndInstall'
> & {
  on(event: 'error', listener: (e: Error) => void): unknown
  on(event: 'download-progress', listener: (p: ProgressInfo) => void): unknown
  removeListener(event: 'download-progress', listener: (p: ProgressInfo) => void): unknown
}

export function electronUpdaterBackend(opts: {
  updater: UpdaterLike
  version: string
  fetch: FetchLike
  releasesApi: string
  releaseFolder(tag: string): string
  log(line: string): void
  devFeedFile?: string
  onError(e: unknown): void
}): UpdateBackend {
  const u = opts.updater
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
      // Main accepts published vX.Y.Z prereleases and ignores ffmpeg tags; the GitHub provider does neither.
      const found = await newerRelease(opts.fetch, opts.version, opts.releasesApi)
      if (!found) return null
      u.setFeedURL({ provider: 'generic', url: opts.releaseFolder(`v${found.version}`) })
      const r = await u.checkForUpdates()
      if (!r) throw new Error('The updater is not active in this build.')
      // The checksum only proves the zip matches latest-mac.yml, not that the yml belongs to this release: a yml
      // naming another version (a stale or mixed-up upload) would install that version instead.
      if (r.updateInfo.version !== found.version) {
        throw new Error(`latest-mac.yml in release v${found.version} is for version ${r.updateInfo.version}`)
      }
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
      u.quitAndInstall(true, true)
    }
  }
}
