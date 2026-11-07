// The nightly is its own app beside the stable one (shared/channel.ts): the version alone picks the channel, the
// build gives it its own identity, its data stays apart except the shared speech models, its library never touches
// the stable app's reels, and it never takes the stable app's updates from the site's feed.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { channelOf } from '../src/shared/channel'
import { clearEngineCache } from '../src/main/engine-cache'
import { chosenRoot, engineCacheDir, engineEnv, initPaths, modelsDir, reelStudioRoot, setRootOverride, settingsFile } from '../src/main/paths'
import { settleLibraryRoot } from '../src/main/settings'
import { disabledReason } from '../src/main/update-machine'
import { APP_DIR } from './helpers'

const { channelConfig, applyOverrides } = createRequire(import.meta.url)('../../packaging/make-config.js') as {
  channelConfig(version: string): { channel: string; overrides: string[]; icons: string }
  applyOverrides(yaml: string, overrides: string[]): string
}
const TEMPLATE = readFileSync(join(APP_DIR, '..', 'packaging', 'electron-builder.yml'), 'utf8')
const NIGHTLY = '0.1.3-nightly.20261028.17'

describe('channel', () => {
  it('fails if a version lands on the wrong channel, or the build and the running app disagree', () => {
    const cases: [string, 'stable' | 'nightly'][] = [
      ['0.1.2', 'stable'],
      ['1.0.0-beta.1', 'stable'],
      [NIGHTLY, 'nightly'],
      ['0.1.4-nightly.20261231.3824', 'nightly'],
      ['0.1.3-nightly.2026102.1', 'stable'], // seven-digit date
      ['0.1.3-nightly.20261028', 'stable'], // no run number
      ['0.1.3-nightly.20261028.x', 'stable'],
      ['0.1.3-nightly.20261028.17-x', 'stable']
    ]
    for (const [version, channel] of cases) {
      expect(channelOf(version), version).toBe(channel)
      expect(channelConfig(version).channel, `make-config.js ${version}`).toBe(channel)
    }
  })

  it('fails if a nightly build shares the stable app\'s identity or install folder', () => {
    const yml = applyOverrides(TEMPLATE, channelConfig(NIGHTLY).overrides)
    expect(yml).toMatch(/^appId: dev\.reelstudio\.app\.nightly$/m)
    expect(yml).toMatch(/^productName: Reel Studio \(Nightly\)$/m)
    // the packaged package.json: Electron's userData folder, the Windows install folder, electron-updater's cache
    expect(yml).toMatch(/^extraMetadata:\n {2}name: reel-studio-nightly\n {2}productName: Reel Studio \(Nightly\)\n/m)
    expect(yml).toMatch(/^dmg:\n(?: {2}.*\n)*? {2}artifactName: Reel-Studio-Nightly-\$\{version\}-\$\{arch\}\.\$\{ext\}$/m)
    expect(yml).toMatch(/^nsis:\n(?: {2}.*\n|\s*\n)*? {2}artifactName: Reel-Studio-Nightly-Setup-\$\{version\}-\$\{arch\}\.\$\{ext\}/m)
    expect(channelConfig(NIGHTLY).icons).toBe('packaging/icons/nightly')

    expect(applyOverrides(TEMPLATE, channelConfig('0.1.2').overrides)).toBe(TEMPLATE)
  })
})

/** A computer with the stable app's data and library already there, and the nightly about to start. */
function computer(platform: NodeJS.Platform, channel: 'stable' | 'nightly' = 'nightly', env: NodeJS.ProcessEnv = {}) {
  const home = mkdtempSync(join(tmpdir(), 'rs-nightly-'))
  const appData = platform === 'win32' ? join(home, 'AppData', 'Roaming') : join(home, 'Library', 'Application Support')
  const stable = { userData: join(appData, 'Reel Studio'), documents: join(home, 'Documents', 'Reel Studio'), movies: join(home, 'Movies', 'Reel Studio') }
  const project = join(stable.documents, 'Projects', 'sourdough', 'project.json')
  mkdirSync(join(project, '..'), { recursive: true })
  writeFileSync(project, '{"title":"Sourdough"}')
  mkdirSync(join(stable.userData, 'models', 'small.en'), { recursive: true })
  writeFileSync(join(stable.userData, 'models', 'small.en', 'model.bin'), 'weights')
  writeFileSync(join(stable.userData, 'settings.json'), JSON.stringify({ firstRunDone: true, root: stable.documents }))
  const userData = join(appData, channel === 'nightly' ? 'Reel Studio (Nightly)' : 'Reel Studio')
  initPaths({
    isPackaged: true,
    resourcesPath: '',
    documentsDir: join(home, 'Documents'),
    moviesDir: join(home, 'Movies'),
    userDataDir: userData,
    appDataDir: appData,
    appDir: APP_DIR,
    channel,
    platform,
    homeDir: home,
    env: platform === 'win32' ? { LOCALAPPDATA: join(home, 'AppData', 'Local'), ...env } : env
  })
  return { home, appData, userData, stable, project }
}

describe('nightly data', () => {
  it('fails if the nightly downloads its own copy of the speech models instead of using the stable app\'s, on a Mac or on Windows', () => {
    for (const platform of ['darwin', 'win32'] as const) {
      const c = computer(platform)
      expect(modelsDir(), platform).toBe(join(c.appData, 'Reel Studio', 'models'))
      expect(engineEnv().REELENGINE_MODELS, platform).toBe(join(c.appData, 'Reel Studio', 'models'))
    }
    // the stable app and an isolated test profile keep their own
    const s = computer('darwin', 'stable')
    expect(modelsDir()).toBe(join(s.userData, 'models'))
    const t = computer('darwin', 'nightly', { REELSTUDIO_USER_DATA: '/isolated/profile' })
    expect(modelsDir()).toBe(join(t.userData, 'models'))
  })

  it('fails if the nightly\'s engine writes its caches into the stable app\'s folders, or Clear cache empties them', async () => {
    const s = computer('darwin', 'stable')
    const stableCache = engineCacheDir()
    mkdirSync(stableCache, { recursive: true })
    writeFileSync(join(stableCache, 'simple-icons.json'), 'stable lookups')

    initPaths(nightlyContext(s))
    expect(engineCacheDir()).not.toBe(stableCache)
    // the engine's own fallback (tools.appdata_dir) is the stable app's folder
    expect(engineEnv().REELENGINE_CACHE).toBe(join(s.appData, 'Reel Studio (Nightly)'))

    await clearEngineCache(engineCacheDir())
    expect(readFileSync(join(stableCache, 'simple-icons.json'), 'utf8')).toBe('stable lookups')
    expect(readFileSync(join(modelsDir(), 'small.en', 'model.bin'), 'utf8')).toBe('weights')
  })
})

/** The nightly on the same computer as `c`, which was set up for the stable app. */
function nightlyContext(c: ReturnType<typeof computer>) {
  return {
    isPackaged: true,
    resourcesPath: '',
    documentsDir: join(c.home, 'Documents'),
    moviesDir: join(c.home, 'Movies'),
    userDataDir: join(c.appData, 'Reel Studio (Nightly)'),
    appDataDir: c.appData,
    appDir: APP_DIR,
    channel: 'nightly' as const,
    platform: 'darwin' as const,
    homeDir: c.home,
    env: {}
  }
}

describe('nightly library', () => {
  it('fails if the nightly\'s first launch adopts the stable app\'s library in Documents or Movies', async () => {
    const c = computer('darwin')
    mkdirSync(c.stable.movies, { recursive: true })
    // a nightly settings file without a root (an older nightly, or one reset by hand) is not an install from before ~/Movies
    mkdirSync(join(settingsFile(), '..'), { recursive: true })
    writeFileSync(settingsFile(), JSON.stringify({ firstRunDone: true }))
    const root = await settleLibraryRoot()
    setRootOverride(root)
    expect(reelStudioRoot()).toBe(join(c.home, 'Movies', 'Reel Studio (Nightly)'))
    expect(readFileSync(c.project, 'utf8')).toBe('{"title":"Sourdough"}')
  })

  it('fails if Settings › Storage lets the nightly use a folder that is, holds or sits inside a stable library', () => {
    const c = computer('darwin')
    const custom = join(c.home, 'Elsewhere', 'Reel Studio')
    const stableRoots = [c.stable.documents, c.stable.movies, custom]
    for (const picked of [c.stable.documents, join(c.stable.documents, 'Projects'), custom]) {
      expect(() => chosenRoot(picked, stableRoots), picked).toThrow(/stable app's library/)
    }
    expect(chosenRoot(join(c.home, 'Documents'), stableRoots)).toBe(join(c.home, 'Documents', 'Reel Studio (Nightly)'))
    expect(existsSync(join(c.home, 'Documents', 'Reel Studio (Nightly)'))).toBe(false) // choosing only names it

    computer('darwin', 'stable')
    expect(chosenRoot(join(c.home, 'Documents'))).toBe(join(c.home, 'Documents', 'Reel Studio'))
  })

  it("fails if the nightly accepts an ordinary folder whose 'Reel Studio (Nightly)' links to the stable library", () => {
    const c = computer(process.platform)
    mkdirSync(c.stable.movies, { recursive: true })
    const elsewhere = join(c.home, 'Elsewhere')
    mkdirSync(elsewhere, { recursive: true })
    // a junction on Windows needs no special rights; a directory link elsewhere
    symlinkSync(c.stable.movies, join(elsewhere, 'Reel Studio (Nightly)'), 'junction')
    expect(() => chosenRoot(elsewhere, [c.stable.documents, c.stable.movies])).toThrow(/stable app's library/)
  })
})

describe('nightly updates', () => {
  // The site's feed (main/updater-electron.ts) has only stable releases: a nightly that checked it would offer the
  // stable installer, which installs Reel Studio itself rather than a newer nightly.
  it('fails if a nightly build turns its updater on', () => {
    const installed = { platform: 'win32' as const, isPackaged: true, test: false, hasFeed: true, inApplications: false }
    expect(disabledReason({ ...installed, channel: 'nightly' })).toMatch(/Nightly builds don't update themselves/)
    expect(disabledReason({ ...installed, platform: 'darwin', inApplications: true, channel: 'nightly' })).toMatch(/Nightly builds/)
    expect(disabledReason({ ...installed, channel: 'stable' })).toBeNull()
    expect(disabledReason(installed)).toBeNull()
  })
})
