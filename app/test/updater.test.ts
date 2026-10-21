// The updater's state machine (main/updater.ts + main/update-machine.ts) driven through a fake backend, and
// the Windows decision: an unsigned installer never self-updates.
import { describe, expect, it } from 'vitest'
import { createUpdater, type FoundUpdate, type UpdateBackend } from '../src/main/updater'
import { parseFeedFile, updateMode } from '../src/main/update-machine'
import { updateAction, type UpdateState } from '../src/shared/update'

function setup(found: () => Promise<FoundUpdate | null>, opts: { download?: (p: (n: number) => void) => Promise<void>; exporting?: boolean } = {}) {
  const installs: number[] = []
  const backend: UpdateBackend = {
    check: found,
    download: opts.download ?? (async (p) => [0, 40, 100].forEach(p)),
    install: () => void installs.push(1)
  }
  const sent: UpdateState[] = []
  const u = createUpdater({
    version: '0.1.2',
    mode: 'install',
    disabledReason: null,
    backend,
    loadAutoCheck: async () => true,
    saveAutoCheck: async () => undefined,
    busy: () => ({ exporting: !!opts.exporting, working: 0 }),
    prepareToQuit: async () => undefined,
    openExternal: async () => undefined,
    send: (s) => void sent.push(s),
    log: () => {},
    now: () => 1000
  })
  return { u, sent, installs }
}

const v013: FoundUpdate = { version: '0.1.3', notes: '## What\'s new\n\n* **Updates install themselves.** More text.\n', releaseUrl: null }

describe('state machine', () => {
  it('checking, available, downloading, downloaded, install', async () => {
    const { u, sent, installs } = setup(async () => v013)
    await u.check('test')
    expect(sent.map((s) => s.status)).toEqual(['checking', 'available'])
    expect(u.state()).toMatchObject({
      availableVersion: '0.1.3',
      releaseUrl: 'https://github.com/AidenJohnston/reel-studio-app/releases/tag/v0.1.3',
      releaseNotes: { version: '0.1.3', items: ['Updates install themselves.'], totalItems: 1 }
    })
    expect(updateAction(u.state())).toBe('download')

    await u.download()
    expect(sent.slice(2).map((s) => [s.status, s.downloadPercent])).toEqual([
      ['downloading', 0],
      ['downloading', 40],
      ['downloading', 100],
      ['downloaded', 100]
    ])
    expect(u.state().downloadedVersion).toBe('0.1.3')

    // a later check that finds nothing newer keeps the downloaded update ready
    await u.check('again')
    expect(u.state().status).toBe('downloaded')

    expect((await u.install()).accepted).toBe(true)
    expect(installs).toHaveLength(1)
  })

  it('up to date, then a failed check', async () => {
    let fail = false
    const { u } = setup(async () => {
      if (fail) throw new Error('getaddrinfo ENOTFOUND github.com')
      return null
    })
    await u.check('test')
    expect(u.state().status).toBe('up-to-date')
    fail = true
    await u.check('test')
    expect(u.state()).toMatchObject({ status: 'error', errorContext: 'check' })
    expect(u.state().message).toMatch(/internet connection/)
    expect(updateAction(u.state())).toBe('none')
  })

  it('a stopped download offers to try again; a failed install keeps the download', async () => {
    let broken = true
    const { u } = setup(async () => v013, {
      download: async () => {
        if (broken) throw new Error('sha512 checksum mismatch')
      }
    })
    await u.check('test')
    await u.download()
    expect(u.state()).toMatchObject({ status: 'error', errorContext: 'download', availableVersion: '0.1.3' })
    expect(updateAction(u.state())).toBe('download')

    broken = false
    await u.download()
    expect(u.state().status).toBe('downloaded')
    await u.install()
    u.installFailed(new Error('Code signature did not match'))
    expect(u.state()).toMatchObject({ status: 'error', errorContext: 'install', downloadedVersion: '0.1.3' })
    expect(updateAction(u.state())).toBe('install')
  })

  it('will not restart while an export is writing', async () => {
    const { u, installs } = setup(async () => v013, { exporting: true })
    await u.check('test')
    await u.download()
    expect(await u.install()).toMatchObject({ accepted: false, refused: 'exporting' })
    expect(installs).toHaveLength(0)
  })
})

describe('Windows without a signed installer', () => {
  it('only points at the download page; a publisher name in app-update.yml switches installing on', () => {
    const unsigned = parseFeedFile('owner: AidenJohnston\nrepo: reel-studio-app\nprovider: github\nupdaterCacheDirName: reel-studio-updater\n')
    const signed = parseFeedFile('owner: AidenJohnston\npublisherName:\n  - Reel Studio Ltd\nrepo: reel-studio-app\nprovider: github\n')
    expect(signed.publisherName).toEqual(['Reel Studio Ltd'])
    expect(updateMode({ platform: 'win32', feed: unsigned, inApplications: false })).toBe('page')
    expect(updateMode({ platform: 'win32', feed: null, inApplications: false })).toBe('page')
    expect(updateMode({ platform: 'win32', feed: signed, inApplications: false })).toBe('install')
  })
})
