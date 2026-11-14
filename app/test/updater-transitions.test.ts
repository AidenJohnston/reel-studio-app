// The update state machine (main/updater.ts) as the window sees it: every state it is sent, in order, from the
// check to the restart, and where each failure leaves the person (what the update button does next).
import { describe, expect, it } from 'vitest'
import { createUpdater, type UpdateBackend } from '../src/main/updater'
import { UPDATE_PAGE } from '../src/main/update-check'
import { updateAction, type UpdateState } from '../src/shared/update'
import type { UpdateNotice } from '../src/shared/api'

const NEWER: UpdateNotice = { version: '0.2.1', url: `${UPDATE_PAGE}?v=0.2.1` }

type Step = 'check' | 'download' | 'install' | 'installFailed'

/** A backend whose answers the test scripts, one per call; `true` fails that call. */
function machine(script: { check?: (boolean | null)[]; download?: boolean[]; verify?: boolean[]; prepare?: boolean[] }) {
  const sent: UpdateState[] = []
  const happened: string[] = []
  const next = (list: (boolean | null)[] | undefined): boolean | null | undefined => list?.shift()
  const backend: UpdateBackend = {
    check: async () => {
      const r = next(script.check)
      if (r === true) throw new Error('getaddrinfo ENOTFOUND dl.getreelstudio.com')
      return { update: r === null ? null : NEWER, notes: [] }
    },
    hasKey: async () => true,
    download: async (_v, progress) => {
      if (next(script.download)) throw new Error('sha512 checksum mismatch')
      for (const p of [0, 50, 100]) progress(p)
      return null
    },
    verify: async () => {
      if (next(script.verify)) throw new Error('Update bundle version 0.1.9 does not match the newer release 0.2.1.')
      happened.push('verified')
    },
    install: () => void happened.push('installed')
  }
  const u = createUpdater({
    version: '0.2.0',
    mode: 'install',
    disabledReason: null,
    backend,
    load: async () => ({ checkUpdates: true, updateCheckedAt: null, updateLatest: null, updateDismissed: null, updateNotes: [] }),
    save: async () => undefined,
    busy: () => ({ exporting: false, working: 0 }),
    prepareToQuit: async () => {
      if (next(script.prepare)) throw new Error('A video would not stop')
      happened.push('work happened')
    },
    openExternal: async () => undefined,
    send: (s) => void sent.push(s),
    log: () => undefined,
    now: () => 1000
  })
  async function run(steps: Step[]): Promise<void> {
    for (const step of steps) {
      if (step === 'installFailed') u.installFailed(new Error('Code signature did not match'))
      else if (step === 'check') await u.check('button')
      else await u[step]()
    }
  }
  // the statuses in the order the window got them; download progress repeats "downloading", so runs collapse
  const statuses = (): string[] =>
    sent.map((s) => (s.status === 'error' ? `error:${s.errorContext}` : s.status)).filter((s, i, all) => s !== all[i - 1])
  return { u, run, statuses, happened }
}

describe('update state machine, step by step', () => {
  it('fails if the way to a restart skips, repeats or reorders a step', async () => {
    const m = machine({ check: [false] })
    await m.run(['check', 'download', 'install'])
    expect(m.statuses()).toEqual(['checking', 'available', 'downloading', 'downloaded', 'installing'])
    // the download is checked before any work stops, and the app restarts only after both
    expect(m.happened).toEqual(['verified', 'work happened', 'installed'])
    expect(m.u.state()).toMatchObject({ availableVersion: '0.2.1', downloadedVersion: '0.2.1', downloadPercent: 100 })
  })

  it('fails if an up-to-date check offers anything', async () => {
    const m = machine({ check: [null] })
    await m.run(['check'])
    expect(m.statuses()).toEqual(['checking', 'up-to-date'])
    expect(updateAction(m.u.state())).toBe('none')
  })

  it('fails if a failed check is not tried again, or the next one that answers offers nothing', async () => {
    const m = machine({ check: [true, false] })
    await m.run(['check'])
    expect(m.statuses()).toEqual(['checking', 'error:check'])
    expect(updateAction(m.u.state())).toBe('none')
    await m.run(['check'])
    expect(m.statuses()).toEqual(['checking', 'error:check', 'checking', 'available'])
    expect(updateAction(m.u.state())).toBe('download')
  })

  it('fails if a failed download does not offer Download again, or the retry does not finish', async () => {
    const m = machine({ check: [false], download: [true, false] })
    await m.run(['check', 'download'])
    expect(m.statuses().slice(-2)).toEqual(['downloading', 'error:download'])
    expect(m.u.state()).toMatchObject({ availableVersion: '0.2.1', downloadedVersion: null, downloadPercent: null })
    expect(updateAction(m.u.state())).toBe('download')
    await m.run(['download'])
    expect(m.statuses().slice(-3)).toEqual(['error:download', 'downloading', 'downloaded'])
  })

  it('fails if a download that fails its check stops work, restarts, or is offered again instead of its page', async () => {
    const m = machine({ check: [false], verify: [true] })
    await m.run(['check', 'download', 'install'])
    expect(m.statuses().slice(-3)).toEqual(['downloaded', 'installing', 'error:download'])
    expect(m.happened).toEqual([])
    expect(m.u.state()).toMatchObject({ mode: 'page', availableVersion: '0.2.1', downloadedVersion: null })
    expect(updateAction(m.u.state())).toBe('open-page')
    expect(() => m.u.assertCanStartWork()).not.toThrow()
  })

  it('fails if a restart that cannot stop the work, or that the installer refuses, loses the download or blocks new work', async () => {
    for (const failure of ['work would not stop', 'installer refused'] as const) {
      const m = machine({ check: [false], prepare: failure === 'work would not stop' ? [true, false] : [] })
      await m.run(failure === 'work would not stop' ? ['check', 'download', 'install'] : ['check', 'download', 'install', 'installFailed'])
      expect(m.statuses().slice(-3), failure).toEqual(['downloaded', 'installing', 'error:install'])
      expect(m.u.state(), failure).toMatchObject({ downloadedVersion: '0.2.1' })
      expect(updateAction(m.u.state()), failure).toBe('install')
      expect(() => m.u.assertCanStartWork(), failure).not.toThrow()
      // Restart again: the same download, no new one
      const installedBefore = m.happened.filter((s) => s === 'installed').length
      await m.run(['install'])
      expect(m.statuses().slice(-2), failure).toEqual(['error:install', 'installing'])
      expect(m.happened.filter((s) => s === 'installed').length, failure).toBe(installedBefore + 1)
    }
  })
})
