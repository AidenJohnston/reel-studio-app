// The Mac backend (main/updater-electron.ts) with a fake electron-updater: it installs only the release it chose.
import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import type { UpdateCheckResult, UpdateInfo } from 'electron-updater'
import { electronUpdaterBackend, type UpdaterLike } from '../src/main/updater-electron'
import type { FetchLike } from '../src/main/update-check'

/** electron-updater's autoUpdater, answering every check with `yml` (the release's latest-mac.yml). */
class FakeUpdater extends EventEmitter implements UpdaterLike {
  logger: UpdaterLike['logger'] = null
  autoDownload = true
  autoInstallOnAppQuit = true
  allowDowngrade = false
  disableDifferentialDownload = false
  requestHeaders: UpdaterLike['requestHeaders'] = null
  forceDevUpdateConfig = false
  updateConfigPath: string | null = null
  feeds: unknown[] = []
  downloads = 0
  constructor(private yml: UpdateInfo) {
    super()
  }
  setFeedURL(options: Parameters<UpdaterLike['setFeedURL']>[0]): void {
    this.feeds.push(options)
  }
  async checkForUpdates(): Promise<UpdateCheckResult> {
    return { isUpdateAvailable: true, updateInfo: this.yml, versionInfo: this.yml }
  }
  async downloadUpdate(): Promise<string[]> {
    this.downloads++
    return []
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
  it('refuses a latest-mac.yml whose version is not the release it was read from', async () => {
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
    expect(updater.feeds).toEqual([{ provider: 'generic', url: 'https://github.com/AidenJohnston/reel-studio-app/releases/download/v0.1.3' }])
  })
})
