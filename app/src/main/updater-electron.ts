import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { AppUpdater, ProgressInfo } from 'electron-updater'
import { isNewer, newerOnSite, type FetchLike } from './update-check'
import type { PageReason, UpdateBackend } from './updater'

/** The update feed (site worker): /u/latest.yml, /u/latest-mac.yml and the files they name. Every request needs
 * `Authorization: Bearer <download key>`. */
export const UPDATE_FEED_URL = 'https://dl.getreelstudio.com/u/'

// A shared staging ID preserves the promise that update requests identify no individual install: electron-updater
// would otherwise send a random ID it keeps per install.
export const SAME_FOR_EVERYONE = { 'x-user-staging-id': '00000000-0000-0000-0000-000000000000' }

export type UpdaterLike = Pick<
  AppUpdater,
  | 'logger'
  | 'autoDownload'
  | 'autoInstallOnAppQuit'
  | 'allowDowngrade'
  | 'disableDifferentialDownload'
  | 'disableWebInstaller'
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

export interface InstallStep {
  /** The one file the feed may name for `version`. The download key goes with that request, so a yml naming any
   * other file (or another host) is refused before anything is downloaded. */
  fileName(version: string): string
  /** Throws if the downloaded file must not be installed as `version`. */
  verify(file: string, version: string): Promise<void>
  /** Windows: show the NSIS progress window while it installs. Squirrel.Mac ignores it. */
  showInstaller: boolean
}

/** The download key store (main/update-key.ts). */
export interface KeyStore {
  get(): Promise<string | null>
  isCurrent(key: string): Promise<boolean>
  clearIfCurrent(key: string): Promise<boolean>
}

/** The HTTP status of an electron-updater failure, or null. Reading the yml fails with an HttpError carrying
 * `statusCode`, except a 404, which electron-updater rewraps as ERR_UPDATER_CHANNEL_FILE_NOT_FOUND; downloading
 * a file fails with a plain Error whose message says `status 403: Forbidden` (builder-util-runtime 9.7.0). */
export function httpStatus(e: unknown): number | null {
  if (e && typeof e === 'object') {
    if ('statusCode' in e && typeof e.statusCode === 'number') return e.statusCode
    if ('code' in e && e.code === 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND') return 404
  }
  const m = /\bstatus (\d{3})\b/.exec(String(e instanceof Error ? e.message : e))
  return m ? Number(m[1]) : null
}

export function electronUpdaterBackend(opts: {
  updater: UpdaterLike
  version: string
  fetch: FetchLike
  /** latest.json (a local server in the update e2e). */
  latestUrl: string
  /** UPDATE_FEED_URL (a local server in the update e2e). */
  feedUrl: string
  keys: KeyStore
  log(line: string): void
  devFeedFile?: string
  onError(e: unknown): void
  install: InstallStep
}): UpdateBackend {
  const u = opts.updater
  let downloaded: { file: string; version: string } | null = null
  u.logger = {
    info: (m: unknown) => opts.log(`[updater] ${String(m)}`),
    warn: (m: unknown) => opts.log(`[updater] warn: ${String(m)}`),
    error: (m: unknown) => opts.log(`[updater] error: ${String(m)}`)
  }
  u.autoDownload = false
  u.autoInstallOnAppQuit = false
  u.allowDowngrade = false
  // The feed serves no .blockmap files, so a differential download could only fail first and then fetch the
  // whole file.
  u.disableDifferentialDownload = true
  u.disableWebInstaller = true
  u.requestHeaders = { ...SAME_FOR_EVERYONE }
  if (opts.devFeedFile) {
    u.forceDevUpdateConfig = true
    u.updateConfigPath = opts.devFeedFile
  }
  // Without a listener an 'error' event would throw. Check and download errors also reject their promise,
  // which download() below handles; this one matters for the install.
  u.on('error', (e) => opts.onError(e))

  /** A refusal from the update server for `key`, as the updater handles it, or null for any other failure. */
  async function refusal(e: unknown, key: string): Promise<PageReason | null> {
    const status = httpStatus(e)
    if (status === 404) return 'feed' // no update for this platform in the current release
    if (status !== 401 && status !== 403) return null
    // A key saved while this request was out is not the one the server refused: offer the download again.
    const changed = new Error('The download key changed while the update was downloading. Try again.')
    if (status === 403) {
      if (!(await opts.keys.isCurrent(key))) throw changed
      return 'not-entitled'
    }
    // No key or not ours: it can never work, so automatic updates are off until a new key arrives.
    if (!(await opts.keys.clearIfCurrent(key))) throw changed
    return 'key-rejected'
  }

  return {
    // latest.json only. The key never goes with it.
    check: () => newerOnSite(opts.fetch, opts.version, opts.latestUrl),

    hasKey: async () => (await opts.keys.get()) !== null,

    async download(version, onProgress) {
      const key = await opts.keys.get()
      if (!key) return 'no-key'
      u.setFeedURL({ provider: 'generic', url: opts.feedUrl })
      // electron-updater copies these headers into the feed reader when checkForUpdates() runs, and the download
      // reuses that reader, so the key is set only for this one check and download.
      u.requestHeaders = { ...SAME_FOR_EVERYONE, Authorization: `Bearer ${key}` }
      const progress = (p: ProgressInfo): void => onProgress(p.percent)
      try {
        let r: Awaited<ReturnType<UpdaterLike['checkForUpdates']>>
        try {
          r = await u.checkForUpdates()
        } catch (e) {
          const refused = await refusal(e, key)
          if (!refused) throw e
          opts.log(`[update] the update feed refused ${version}: HTTP ${httpStatus(e)}`)
          return refused
        }
        if (!r) throw new Error('the updater is not active in this build')
        // The checksum only proves the download matches the yml, not that the yml is the release latest.json named:
        // a yml naming another version (mid-release, or stale) would install that version instead.
        if (r.updateInfo.version !== version || !r.isUpdateAvailable) {
          opts.log(`[update] ${version}: the update feed offers ${r.updateInfo.version}${r.isUpdateAvailable ? '' : ', which is not newer than this copy'}`)
          return 'feed'
        }
        // electron-updater resolves each file against the feed URL and sends the key with it, so only the expected
        // plain file name may pass (a full URL would take the key to another host). Redirects to another origin
        // drop the Authorization header (builder-util-runtime 9.7.0, prepareRedirectUrlOptions).
        const expected = opts.install.fileName(version)
        const named = r.updateInfo.files?.length ? r.updateInfo.files.map((f) => f.url) : [r.updateInfo.path]
        if (!named.every((url) => url === expected)) {
          opts.log(`[update] ${version}: the update feed names ${named.map((u) => String(u).slice(0, 120)).join(', ')}, not ${expected}`)
          return 'feed'
        }
        u.on('download-progress', progress)
        try {
          const files = await u.downloadUpdate()
          downloaded = { file: files[0], version }
          return null
        } catch (e) {
          const refused = await refusal(e, key)
          if (!refused) throw e
          opts.log(`[update] the update server refused the download of ${version}: HTTP ${httpStatus(e)}`)
          return refused
        }
      } finally {
        u.removeListener('download-progress', progress)
        u.requestHeaders = { ...SAME_FOR_EVERYONE }
      }
    },

    async verify() {
      if (!downloaded) throw new Error('No update is downloaded.')
      try {
        await opts.install.verify(downloaded.file, downloaded.version)
      } catch (e) {
        downloaded = null
        throw e
      }
    },

    install() {
      u.quitAndInstall(!opts.install.showInstaller, true)
    }
  }
}

/** Squirrel.Mac installs whatever app the ZIP holds, so read its version before handing it over. */
export function macBundleCheck(running: string): InstallStep {
  return {
    // packaging/sign-mac.sh writes it; the update server's latest-mac.yml names it
    fileName: (version) => `Reel-Studio-${version}-arm64-mac.zip`,
    showInstaller: false,
    async verify(zip, selected) {
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
}
