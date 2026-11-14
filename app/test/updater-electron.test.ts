// The electron-updater backend (main/updater-electron.ts) with a fake electron-updater and a fake site: which
// request carries the download key, what a 401, 403 or 404 from the update server does, and the Mac bundle check.
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import type { UpdateCheckResult, UpdateInfo } from 'electron-updater'
import { SAME_FOR_EVERYONE, STAGING_FEED_URL, UPDATE_FEED_URL, electronUpdaterBackend, installerRefusal, macBundleCheck, windowsInstaller, windowsInstallerFacts, type InstallStep, type UpdaterLike, type WindowsInstallerFacts } from '../src/main/updater-electron'
import { LATEST_URL, UPDATE_PAGE, type FetchLike } from '../src/main/update-check'
import { createUpdater } from '../src/main/updater'
import { STAGING_DESCRIPTION } from '../src/shared/channel'
import { updateAction } from '../src/shared/update'

const KEY = 'v1.eyJwIjoibW9udGhseSJ9.c2lnbmF0dXJl'
const OTHER_KEY = 'v1.eyJwIjoib25jZSJ9.b3RoZXI'
const zipName = (version: string) => `Reel-Studio-${version}-arm64-mac.zip`
const info = (version: string, file = zipName(version)): UpdateInfo => ({ version, files: [{ url: file, sha512: 'x', size: 1 }], path: file, sha512: 'x', releaseDate: '2026-11-04' })

/** electron-updater as the backend drives it. Records the headers each request would carry. */
class FakeUpdater extends EventEmitter implements UpdaterLike {
  logger: UpdaterLike['logger'] = null
  autoDownload = true
  autoInstallOnAppQuit = true
  allowDowngrade = false
  disableDifferentialDownload = false
  disableWebInstaller = false
  requestHeaders: UpdaterLike['requestHeaders'] = null
  forceDevUpdateConfig = false
  updateConfigPath: string | null = null
  feeds: unknown[] = []
  /** The headers electron-updater would send to the update server, per request. */
  sent: { request: 'yml' | 'file'; headers: UpdaterLike['requestHeaders'] }[] = []
  checkError: unknown = null
  downloadError: unknown = null
  constructor(private yml: UpdateInfo, private file = 'update.zip', private newer = true) {
    super()
  }
  setFeedURL(o: unknown): void {
    this.feeds.push(o)
  }
  async checkForUpdates(): Promise<UpdateCheckResult> {
    this.sent.push({ request: 'yml', headers: this.requestHeaders && { ...this.requestHeaders } })
    if (this.checkError) throw this.checkError
    return { isUpdateAvailable: this.newer, updateInfo: this.yml, versionInfo: this.yml }
  }
  async downloadUpdate(): Promise<string[]> {
    this.sent.push({ request: 'file', headers: this.requestHeaders && { ...this.requestHeaders } })
    if (this.downloadError) throw this.downloadError
    this.emit('download-progress', { percent: 50 })
    return [this.file]
  }
  quitAndInstall(): void {}
}

/** latest.json naming 0.1.3; records every request. */
function site(version = '0.1.3') {
  const calls: { url: string; headers: Record<string, string> }[] = []
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, headers: init.headers })
    return { ok: true, status: 200, json: async () => ({ version, url: UPDATE_PAGE, files: {}, notes: [] }) }
  }
  return { fetch, calls }
}

function keyStore(initial: string | null = KEY) {
  const store = { key: initial as string | null, cleared: 0 }
  const keys = {
    get: async () => store.key,
    isCurrent: async (k: string) => store.key === k,
    clearIfCurrent: async (k: string) => {
      if (store.key !== k) return false
      store.key = null
      store.cleared++
      return true
    }
  }
  return { store, keys }
}

const noCheck: InstallStep = { fileName: zipName, showInstaller: false, verify: async () => {} }

function wire(updater: FakeUpdater, opts: { key?: string | null; install?: InstallStep } = {}) {
  const s = site()
  const { store, keys } = keyStore(opts.key === undefined ? KEY : opts.key)
  const lines: string[] = []
  const backend = electronUpdaterBackend({
    updater, version: '0.1.2', fetch: s.fetch, latestUrl: LATEST_URL, feedUrl: UPDATE_FEED_URL, keys,
    log: (l) => void lines.push(l), onError: () => {}, install: opts.install ?? noCheck
  })
  const u = createUpdater({
    version: '0.1.2', mode: 'install', disabledReason: null, backend,
    load: async () => ({ checkUpdates: true, updateCheckedAt: null, updateLatest: null, updateDismissed: null, updateNotes: [] }),
    save: async () => undefined, busy: () => ({ exporting: false, working: 0 }), prepareToQuit: async () => undefined,
    openExternal: async () => undefined, send: () => {}, log: () => {}, now: () => 1000
  })
  return { u, backend, site: s, store, keys, lines }
}

/** builder-util-runtime 9.7.0's errors: reading the yml rejects with an HttpError (statusCode, JSON body in the
 * message); a 404 there is rewrapped by electron-updater; a file download rejects with a plain Error. */
const ymlRefused = (statusCode: number, body: string) => Object.assign(new Error(`${statusCode} \n\nData:\n${body}`), { name: 'HttpError', statusCode, code: `HTTP_ERROR_${statusCode}` })
const ymlMissing = () => Object.assign(new Error('Cannot find channel "latest-mac.yml" update info: HttpError: 404'), { code: 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND' })
const fileRefused = (status: number, text: string) => new Error(`Cannot download "https://dl.getreelstudio.com/u/Reel-Studio-0.1.3-arm64-mac.zip", status ${status}: ${text}`)

describe('the download key goes only with the update download', () => {
  it('fails if the daily check sends the key, or the update download goes without it, or it outlives the download', async () => {
    const updater = new FakeUpdater(info('0.1.3'))
    const { u, site: s } = wire(updater)
    await u.init()
    await u.check('auto')
    expect(s.calls).toEqual([{ url: LATEST_URL, headers: { 'User-Agent': 'ReelStudio/0.1.2', Accept: 'application/json' } }])
    expect(updater.sent).toEqual([]) // nothing reaches the update server until the person says yes
    expect(updater.requestHeaders).toEqual(SAME_FOR_EVERYONE)

    await u.download()
    expect(u.state().status).toBe('downloaded')
    expect(updater.feeds).toEqual([{ provider: 'generic', url: 'https://dl.getreelstudio.com/u/' }])
    const withKey = { ...SAME_FOR_EVERYONE, Authorization: `Bearer ${KEY}` }
    expect(updater.sent).toEqual([{ request: 'yml', headers: withKey }, { request: 'file', headers: withKey }])
    expect(updater.requestHeaders).toEqual(SAME_FOR_EVERYONE)
    expect(s.calls.every((c) => !JSON.stringify(c).includes(KEY))).toBe(true)
  })

  it('fails if electron-updater is left free to download or install by itself, or tries a differential download', () => {
    const updater = new FakeUpdater(info('0.1.3'))
    wire(updater)
    expect(updater).toMatchObject({ autoDownload: false, autoInstallOnAppQuit: false, allowDowngrade: false, disableDifferentialDownload: true, disableWebInstaller: true })
  })

  it('fails if a copy with no key asks the update server anything', async () => {
    const updater = new FakeUpdater(info('0.1.3'))
    const { u } = wire(updater, { key: null })
    await u.check('button')
    expect(u.state()).toMatchObject({ mode: 'page', keyNeeded: true })
    expect(updater.sent).toEqual([])
  })
})

describe('what the update server answers', () => {
  it.each([
    ['the yml', (f: FakeUpdater) => void (f.checkError = ymlRefused(401, '{"error":"bad key"}'))],
    ['the file', (f: FakeUpdater) => void (f.downloadError = fileRefused(401, 'Unauthorized'))]
  ])('fails if a 401 for %s keeps the key or keeps offering the download', async (_where, refuse) => {
    const updater = new FakeUpdater(info('0.1.3'))
    refuse(updater)
    const { u, store } = wire(updater)
    await u.check('button')
    await u.download()
    expect(store).toMatchObject({ key: null, cleared: 1 })
    expect(u.state()).toMatchObject({ mode: 'page', keyNeeded: true, downloadedVersion: null })
    expect(updateAction(u.state())).toBe('open-page')
  })

  it.each([
    ['the yml', (f: FakeUpdater) => void (f.checkError = ymlRefused(403, '{"error":"not entitled","reason":"subscription ended"}'))],
    ['the file', (f: FakeUpdater) => void (f.downloadError = fileRefused(403, 'Forbidden'))]
  ])('fails if a 403 for %s clears the key, asks for a new one, or keeps offering the download', async (_where, refuse) => {
    const updater = new FakeUpdater(info('0.1.3'))
    refuse(updater)
    const { u, store } = wire(updater)
    await u.check('button')
    await u.download()
    expect(store).toMatchObject({ key: KEY, cleared: 0 })
    expect(u.state()).toMatchObject({ mode: 'page', keyNeeded: false, downloadedVersion: null })
    expect(updateAction(u.state())).toBe('open-page')
  })

  it('fails if a server error or a dropped connection sends the person to the page instead of offering a retry', async () => {
    const updater = new FakeUpdater(info('0.1.3'))
    updater.checkError = ymlRefused(503, '{"error":"no release"}')
    const { u, store } = wire(updater)
    await u.check('button')
    await u.download()
    expect(u.state()).toMatchObject({ status: 'error', errorContext: 'download', mode: 'install' })
    expect(updateAction(u.state())).toBe('download')
    updater.checkError = null
    updater.downloadError = new Error('net::ERR_INTERNET_DISCONNECTED')
    await u.download()
    expect(updateAction(u.state())).toBe('download')
    expect(store.key).toBe(KEY)
  })

  it('fails if a 401 or 403 for a key replaced during the download clears the new key or sends the person to the page', async () => {
    for (const status of [401, 403]) {
      const updater = new FakeUpdater(info('0.1.3'))
      const { u, store } = wire(updater)
      await u.check('button')
      // The person pastes another key while the request with the old one is out; the old one is then refused.
      updater.checkForUpdates = async () => {
        store.key = OTHER_KEY
        throw ymlRefused(status, '{}')
      }
      await u.download()
      expect(store).toMatchObject({ key: OTHER_KEY, cleared: 0 })
      expect(u.state()).toMatchObject({ status: 'error', errorContext: 'download', mode: 'install' })
      expect(updateAction(u.state())).toBe('download')
    }
  })

  it('fails if a release with no update for this platform, or a feed naming another version or file, downloads or hides the update', async () => {
    for (const updater of [
      Object.assign(new FakeUpdater(info('0.1.3')), { checkError: ymlMissing() }),
      new FakeUpdater(info('0.1.4')),
      new FakeUpdater(info('0.1.3'), 'update.zip', false),
      // A yml naming a file anywhere else would take the key with it.
      new FakeUpdater(info('0.1.3', 'https://elsewhere.example/Reel-Studio-0.1.3-arm64-mac.zip')),
      new FakeUpdater(info('0.1.3', '../d/Reel-Studio-0.1.3-arm64-mac.zip'))
    ]) {
      const { u, lines } = wire(updater)
      await u.check('button')
      await u.download()
      expect(u.state()).toMatchObject({ status: 'error', mode: 'page', keyNeeded: false, availableVersion: '0.1.3' })
      expect(updater.sent.filter((r) => r.request === 'file')).toEqual([])
      expect(lines.join('\n')).toMatch(/0\.1\.3: the update feed (offers|names)|refused 0\.1\.3: HTTP 404/)
    }
  })
})

it.skipIf(process.platform !== 'darwin')('fails if installation accepts a mismatched or downgraded bundle', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rs-update-bundle-'))
  try {
    const app = join(root, 'Reel Studio.app')
    mkdirSync(join(app, 'Contents', 'Resources'), { recursive: true })
    writeFileSync(join(app, 'Contents', 'Resources', 'app-update.yml'), appUpdateYml(UPDATE_FEED_URL))
    for (const version of ['0.1.4', '0.1.1', '0.1.3']) {
      writeFileSync(join(app, 'Contents', 'Info.plist'), `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>`)
      const zip = join(root, version + '.zip')
      execFileSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', app, zip])
      const updater = new FakeUpdater(info('0.1.3'), zip)
      let installed = false
      updater.quitAndInstall = () => { installed = true }
      const { backend } = wire(updater, { install: macBundleCheck('0.1.2') })
      expect(await backend.download('0.1.3', () => {})).toBeNull()
      if (version === '0.1.3') {
        await backend.verify()
        backend.install()
      } else await expect(backend.verify()).rejects.toThrow(/bundle version/)
      expect(installed).toBe(version === '0.1.3')
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

/** What electron-builder writes into the bundle from packaging/electron-builder.yml `publish`. */
const appUpdateYml = (url: string) => `provider: generic\nurl: ${url}\nupdaterCacheDirName: reel-studio-updater\n`

it.skipIf(process.platform !== 'darwin')('fails if a signed update of the right version moves this copy between the production and staging servers', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rs-update-feed-'))
  try {
    const bundle = (name: string, yml: string | null): string => {
      const app = join(root, name, 'Reel Studio.app')
      mkdirSync(join(app, 'Contents', 'Resources'), { recursive: true })
      writeFileSync(join(app, 'Contents', 'Info.plist'), '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>0.1.3</string></dict></plist>')
      if (yml !== null) writeFileSync(join(app, 'Contents', 'Resources', 'app-update.yml'), yml)
      const zip = join(root, `${name}.zip`)
      execFileSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', app, zip])
      return zip
    }
    const production = bundle('production', appUpdateYml(UPDATE_FEED_URL))
    const staging = bundle('staging', appUpdateYml(STAGING_FEED_URL))
    // a feed one path segment off staging's is neither server
    const elsewhere = bundle('elsewhere', appUpdateYml(`${STAGING_FEED_URL}x/`))
    const none = bundle('none', null)
    await expect(macBundleCheck('0.1.2').verify(production, '0.1.3')).resolves.toBeUndefined()
    await expect(macBundleCheck('0.1.2').verify(staging, '0.1.3')).rejects.toThrow(/staging build, and this copy updates from production/)
    await expect(macBundleCheck('0.1.2', true).verify(staging, '0.1.3')).resolves.toBeUndefined()
    await expect(macBundleCheck('0.1.2', true).verify(production, '0.1.3')).rejects.toThrow(/production build, and this copy updates from staging/)
    for (const zip of [elsewhere, none]) {
      await expect(macBundleCheck('0.1.2').verify(zip, '0.1.3')).rejects.toThrow(/no known update server/)
      await expect(macBundleCheck('0.1.2', true).verify(zip, '0.1.3')).rejects.toThrow(/no known update server/)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('Windows installer check', () => {
  const signed = { status: 'Valid', subject: 'CN=Reel Studio, O=Reel Studio' }
  const facts = (installer: Partial<WindowsInstallerFacts['installer']>, running: WindowsInstallerFacts['running'] = signed): WindowsInstallerFacts => ({
    running,
    installer: { ...signed, productVersion: '0.1.3', ...installer }
  })

  it('fails if an unsigned installer, one from another publisher, or an older one labelled newer would be run', () => {
    expect(installerRefusal(facts({}), '0.1.3', '0.1.2')).toBeNull()
    expect(installerRefusal(facts({ productVersion: '0.1.3.0' }), '0.1.3', '0.1.2')).toBeNull()
    // no publisher pin in an unsigned build: electron-updater would accept anything, so this copy updates from the page
    expect(installerRefusal(facts({}, { status: 'NotSigned', subject: null }), '0.1.3', '0.1.2')).toMatch(/not signed/)
    expect(installerRefusal(facts({ status: 'NotSigned', subject: null }), '0.1.3', '0.1.2')).toMatch(/not signed/)
    expect(installerRefusal(facts({ status: 'HashMismatch' }), '0.1.3', '0.1.2')).toMatch(/not signed/)
    expect(installerRefusal(facts({ subject: 'CN=Someone Else' }), '0.1.3', '0.1.2')).toMatch(/someone else/)
    // the feed says 0.1.3, the installer inside is 0.1.1 from the same publisher
    expect(installerRefusal(facts({ productVersion: '0.1.1' }), '0.1.3', '0.1.2')).toMatch(/0\.1\.1/)
    expect(installerRefusal(facts({ productVersion: '0.1.2' }), '0.1.2', '0.1.2')).toMatch(/not the newer/)
  })

  it('fails if a signed installer of the right version moves this copy between the production and staging servers', () => {
    const staging = facts({ description: STAGING_DESCRIPTION })
    const production = facts({ description: 'Turn a raw talking-head video into a finished Reel.' })
    expect(installerRefusal(production, '0.1.3', '0.1.2')).toBeNull()
    expect(installerRefusal(staging, '0.1.3', '0.1.2')).toMatch(/staging build, and this copy updates from production/)
    expect(installerRefusal(staging, '0.1.3', '0.1.2', true)).toBeNull()
    expect(installerRefusal(production, '0.1.3', '0.1.2', true)).toMatch(/production build, and this copy updates from staging/)
    // an installer whose description Windows won't give is no staging build
    expect(installerRefusal(facts({ description: null }), '0.1.3', '0.1.2', true)).toMatch(/production build/)
  })

  // Windows' own answers: node.exe is signed by its publisher, a plain file is not.
  it.runIf(process.platform === 'win32')('fails if the real check accepts an unsigned file, or misreads a signed one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rs-win-installer-'))
    try {
      const unsigned = join(dir, 'Reel-Studio-Setup-0.1.3-x64.exe')
      writeFileSync(unsigned, 'MZ not really a program')
      const copy = join(dir, 'node copy.exe')
      copyFileSync(process.execPath, copy)
      const plain = await windowsInstallerFacts(unsigned)
      expect(plain.running.status).toBe('Valid')
      expect(plain.installer.status).not.toBe('Valid')
      await expect(windowsInstaller('0.0.1').verify(unsigned, '0.1.3')).rejects.toThrow(/not signed/)
      // the same publisher as this node.exe: accepted when the release names the version the file carries
      const own = (await windowsInstallerFacts(copy)).installer.productVersion!
      await expect(windowsInstaller('0.0.1').verify(copy, own)).resolves.toBeUndefined()
      await expect(windowsInstaller('0.0.1').verify(copy, '999.0.0')).rejects.toThrow(/not the newer release/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)
})

it('fails if Windows installs without its progress window or the Mac hands Squirrel an unchecked bundle', async () => {
  const calls: { platform: string; args: unknown[] }[] = []
  const checked: string[] = []
  const mac = { ...macBundleCheck('0.1.2'), verify: async (file: string) => void checked.push(file) }
  const signed = { status: 'Valid', subject: 'CN=Reel Studio' }
  const win = windowsInstaller('0.1.2', async () => ({ running: signed, installer: { ...signed, productVersion: '0.1.3' } }))
  for (const [platform, install] of [['win32', win], ['darwin', mac]] as const) {
    const updater = new FakeUpdater(info('0.1.3', install.fileName('0.1.3')), `${platform}-download`)
    updater.quitAndInstall = (...args: unknown[]) => void calls.push({ platform, args })
    const { backend } = wire(updater, { install })
    await backend.download('0.1.3', () => {})
    await backend.verify()
    backend.install()
  }
  // quitAndInstall(isSilent, isForceRunAfter): NSIS shows its window and reopens the app; Squirrel.Mac has no window.
  expect(calls).toEqual([
    { platform: 'win32', args: [false, true] },
    { platform: 'darwin', args: [true, true] }
  ])
  expect(checked).toEqual(['darwin-download'])
})
