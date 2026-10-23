import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import type { UpdateCheckResult, UpdateInfo } from 'electron-updater'
import { electronUpdaterBackend, macBundleCheck, type UpdaterLike } from '../src/main/updater-electron'
import type { FetchLike } from '../src/main/update-check'
import { createUpdater } from '../src/main/updater'
import { showsUpdateButton, updateAction } from '../src/shared/update'

class FakeUpdater extends EventEmitter implements UpdaterLike {
  logger: UpdaterLike['logger'] = null
  autoDownload = true
  autoInstallOnAppQuit = true
  allowDowngrade = false
  disableDifferentialDownload = false
  requestHeaders: UpdaterLike['requestHeaders'] = null
  forceDevUpdateConfig = false
  updateConfigPath: string | null = null
  constructor(private yml: UpdateInfo, private zip = '') {
    super()
  }
  setFeedURL(): void {}
  async checkForUpdates(): Promise<UpdateCheckResult> {
    return { isUpdateAvailable: true, updateInfo: this.yml, versionInfo: this.yml }
  }
  async downloadUpdate(): Promise<string[]> {
    return [this.zip]
  }
  quitAndInstall(): void {}
}

const github: FetchLike = async () => ({
  ok: true,
  status: 200,
  headers: { get: () => null },
  json: async () => [{ tag_name: 'v0.1.3', draft: false, html_url: 'https://github.com/AidenJohnston/reel-studio-app/releases/tag/v0.1.3' }]
})

describe('a release whose update feed this copy cannot use', () => {
  async function offer(updater: FakeUpdater) {
    const lines: string[] = []
    const backend = electronUpdaterBackend({
      updater,
      version: '0.1.2',
      fetch: github,
      releasesApi: 'https://api.github.com/repos/AidenJohnston/reel-studio-app/releases',
      releaseFolder: (tag) => `https://github.com/AidenJohnston/reel-studio-app/releases/download/${tag}`,
      log: (line) => void lines.push(line),
      onError: () => {},
      verifyDownload: macBundleCheck('0.1.2')
    })
    const u = createUpdater({
      version: '0.1.2', mode: 'install', disabledReason: null, backend,
      load: async () => ({ checkUpdates: true, updateCheckedAt: null, updateLatest: null, updateDismissed: null, updateHistory: null }),
      save: async () => undefined, busy: () => ({ exporting: false, working: 0 }), prepareToQuit: async () => undefined,
      openExternal: async () => undefined, send: () => {}, log: () => {}, now: () => 1000
    })
    await u.init()
    await u.check('button')
    return { s: u.state(), lines }
  }

  it('fails if a release uploaded without this platform\'s feed hides the update', async () => {
    const updater = new FakeUpdater({ version: '0.1.3', files: [], path: 'x.zip', sha512: 'x', releaseDate: '2026-10-21' })
    updater.checkForUpdates = async () => { throw new Error('Cannot find latest-mac.yml in the latest release artifacts: HttpError: 404') }
    const { s, lines } = await offer(updater)
    expect(s).toMatchObject({ status: 'available', availableVersion: '0.1.3', mode: 'page' })
    expect(updateAction(s)).toBe('open-page')
    expect(showsUpdateButton(s)).toBe(true)
    expect(lines.join('\n')).toMatch(/v0\.1\.3: its update feed could not be read.*404/)
  })

  it('fails if a feed naming another version hides the update or installs that version', async () => {
    const { s, lines } = await offer(new FakeUpdater({ version: '0.1.4', files: [], path: 'x.zip', sha512: 'x', releaseDate: '2026-10-21' }))
    expect(s).toMatchObject({ status: 'available', availableVersion: '0.1.3', mode: 'page' })
    expect(updateAction(s)).toBe('open-page')
    expect(lines.join('\n')).toMatch(/its update feed is for version 0\.1\.4/)
  })
})

it.skipIf(process.platform !== 'darwin')('fails if installation accepts a mismatched or downgraded bundle', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rs-update-bundle-'))
  try {
    const app = join(root, 'Reel Studio.app')
    mkdirSync(join(app, 'Contents'), { recursive: true })
    for (const version of ['0.1.4', '0.1.1', '0.1.3']) {
      writeFileSync(join(app, 'Contents', 'Info.plist'), `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>`)
      const zip = join(root, version + '.zip')
      execFileSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', app, zip])
      const updater = new FakeUpdater({ version: '0.1.3', files: [], path: 'x.zip', sha512: 'x', releaseDate: '2026-10-21' }, zip)
      let installed = false
      updater.quitAndInstall = () => { installed = true }
      const backend = electronUpdaterBackend({ updater, version: '0.1.2', fetch: github, releasesApi: 'https://example.test/releases', releaseFolder: () => 'https://example.test/v0.1.3', log: () => {}, onError: () => {}, verifyDownload: macBundleCheck('0.1.2') })
      await backend.check()
      await backend.download(() => {})
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

it('fails if a later check that cannot read the feed breaks Restart for an update already downloaded', async () => {
  const updater = new FakeUpdater({ version: '0.1.3', files: [], path: 'x.zip', sha512: 'x', releaseDate: '2026-10-21' }, 'update.zip')
  const verified: string[] = []
  let installed = 0
  updater.quitAndInstall = () => void installed++
  const backend = electronUpdaterBackend({
    updater, version: '0.1.2', fetch: github, releasesApi: 'https://example.test/releases', releaseFolder: () => 'https://example.test/v0.1.3',
    log: () => {}, onError: () => {}, verifyDownload: async (file, version) => void verified.push(`${file}@${version}`)
  })
  const u = createUpdater({
    version: '0.1.2', mode: 'install', disabledReason: null, backend,
    load: async () => ({ checkUpdates: true, updateCheckedAt: null, updateLatest: null, updateDismissed: null, updateHistory: null }),
    save: async () => undefined, busy: () => ({ exporting: false, working: 0 }), prepareToQuit: async () => undefined,
    openExternal: async () => undefined, send: () => {}, log: () => {}, now: () => 1000
  })
  await u.init()
  await u.check('button')
  await u.download()
  updater.checkForUpdates = async () => { throw new Error('HttpError: 404') }
  await u.check('auto')
  expect(updateAction(u.state())).toBe('install')
  await u.install()
  expect(verified).toEqual(['update.zip@0.1.3'])
  expect(installed).toBe(1)
})
