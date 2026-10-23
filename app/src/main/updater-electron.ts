import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { AppUpdater, ProgressInfo } from 'electron-updater'
import { isNewer, newerRelease, type FetchLike } from './update-check'
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

/** Throws if the downloaded file must not be installed as `selected`. */
export type VerifyDownload = (file: string, selected: string) => Promise<void>

export function electronUpdaterBackend(opts: {
  updater: UpdaterLike
  version: string
  fetch: FetchLike
  releasesApi: string
  releaseFolder(tag: string): string
  log(line: string): void
  devFeedFile?: string
  onError(e: unknown): void
  verifyDownload: VerifyDownload
}): UpdateBackend {
  const u = opts.updater
  let selected: string | null = null
  let downloaded: string | undefined
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
      const result = await newerRelease(opts.fetch, opts.version, opts.releasesApi)
      const found = result.update
      selected = null
      if (!found) return result
      let problem: string
      try {
        u.setFeedURL({ provider: 'generic', url: opts.releaseFolder(`v${found.version}`) })
        const r = await u.checkForUpdates()
        if (!r) throw new Error('the updater is not active in this build')
        // The checksum only proves the zip matches latest-mac.yml, not that the yml belongs to this release: a yml
        // naming another version (a stale or mixed-up upload) would install that version instead.
        if (r.updateInfo.version === found.version) {
          if (!r.isUpdateAvailable) return { ...result, update: null }
          selected = found.version
          return result
        }
        problem = `its update feed is for version ${r.updateInfo.version}`
      } catch (e) {
        problem = `its update feed could not be read (${String(e instanceof Error ? e.message : e).slice(0, 200)})`
      }
      // A release uploaded without this platform's feed, or with it late, must not hide the update.
      opts.log(`[update] v${found.version}: ${problem}; offering its release page instead`)
      return { ...result, pageOnly: true }
    },
    async download(onProgress) {
      const progress = (p: ProgressInfo): void => onProgress(p.percent)
      u.on('download-progress', progress)
      try {
        const files = await u.downloadUpdate()
        downloaded = files[0]
      } finally {
        u.removeListener('download-progress', progress)
      }
    },
    async verify() {
      if (!downloaded || !selected) throw new Error('No downloaded update is selected.')
      await opts.verifyDownload(downloaded, selected)
    },
    install() {
      u.quitAndInstall(true, true)
    }
  }
}

/** Squirrel.Mac installs whatever app the ZIP holds, so read its version before handing it over. */
export function macBundleCheck(running: string): VerifyDownload {
  return async (zip, selected) => {
    const exec = promisify(execFile)
    const { stdout: listing } = await exec('/usr/bin/unzip', ['-Z1', zip, '*.app/Contents/Info.plist'])
    const plists = listing.split('\n').filter((name) => /^[^/]+\.app\/Contents\/Info\.plist$/.test(name))
    if (plists.length !== 1) throw new Error('The update must contain one app bundle version.')
    // Read only the bundle plist, without unpacking executable code or trusting ZIP paths.
    const { stdout: plist } = await exec('/usr/bin/unzip', ['-p', zip, plists[0]], { encoding: 'buffer', maxBuffer: 1024 * 1024 })
    const dir = await fs.mkdtemp(join(tmpdir(), 'rs-update-plist-'))
    try {
      const file = join(dir, 'Info.plist')
      await fs.writeFile(file, plist)
      const { stdout } = await exec('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', file])
      const version = stdout.trim()
      if (version !== selected || !isNewer(version, running)) throw new Error(`Update bundle version ${version} does not match the newer release ${selected}.`)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  }
}
