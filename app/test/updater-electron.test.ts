import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import type { UpdateCheckResult, UpdateInfo } from 'electron-updater'
import { electronUpdaterBackend, type UpdaterLike } from '../src/main/updater-electron'
import type { FetchLike } from '../src/main/update-check'

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

describe('the Mac backend', () => {
  it('fails if a manifest names a different version than its release tag', async () => {
    const updater = new FakeUpdater({ version: '0.1.4', files: [], path: 'x.zip', sha512: 'x', releaseDate: '2026-10-21' })
    const backend = electronUpdaterBackend({
      updater,
      version: '0.1.2',
      fetch: github,
      releasesApi: 'https://api.github.com/repos/AidenJohnston/reel-studio-app/releases',
      releaseFolder: (tag) => `https://github.com/AidenJohnston/reel-studio-app/releases/download/${tag}`,
      log: () => {},
      onError: () => {}
    })
    await expect(backend.check()).rejects.toThrow(/0\.1\.4/)
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
      const backend = electronUpdaterBackend({ updater, version: '0.1.2', fetch: github, releasesApi: 'https://example.test/releases', releaseFolder: () => 'https://example.test/v0.1.3', log: () => {}, onError: () => {} })
      await backend.check()
      await backend.download(() => {})
      if (version === '0.1.3') await backend.install()
      else await expect(Promise.resolve().then(() => backend.install())).rejects.toThrow(/bundle version/)
      expect(installed).toBe(version === '0.1.3')
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
