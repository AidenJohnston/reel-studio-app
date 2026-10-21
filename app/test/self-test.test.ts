import { describe, expect, it } from 'vitest'
import type { RunEngine } from '../src/main/engine'
import { runSelfTest, selfTestArgs } from '../src/main/self-test'

const locations = { python: '/r/python/bin/python3', ffmpeg: '/r/ffmpeg/ffmpeg', ffprobe: '/r/ffmpeg/ffprobe', engine: '/r/engine' }

function doctor(checks: { ok: boolean; name: string; detail?: string; fix?: string }[]): RunEngine {
  return async (command) => {
    expect(command).toBe('doctor')
    return { ok: checks.every((c) => c.ok), checks: checks.map((c) => ({ detail: '', fix: '', ...c })) }
  }
}

const all = { exists: () => true, engineExists: () => true }

describe('selfTestArgs', () => {
  it('reads the flag and --out like packaging/spike', () => {
    expect(selfTestArgs(['/x/Reel Studio', '--self-test', '--out', '/tmp/r s.json'])).toEqual({ selfTest: true, out: '/tmp/r s.json' })
    expect(selfTestArgs(['/x/Reel Studio', '--self-test'])).toEqual({ selfTest: true, out: null })
    expect(selfTestArgs(['/x/Reel Studio', '--out'])).toEqual({ selfTest: false, out: null })
  })
})

describe('runSelfTest', () => {
  it('passes when every doctor check passes, listing each one', async () => {
    const r = await runSelfTest({ locations, ...all, runEngine: doctor([{ ok: true, name: 'ffmpeg' }, { ok: true, name: 'speech model' }]) })
    expect(r.ok).toBe(true)
    expect(r.checks.map((c) => c.name)).toEqual([
      'bundled python', 'bundled ffmpeg', 'bundled ffprobe', 'engine files', 'engine doctor', 'doctor: ffmpeg', 'doctor: speech model'
    ])
  })

  it('passes a fresh install that has not downloaded the speech model yet', async () => {
    const r = await runSelfTest({ locations, ...all, runEngine: doctor([{ ok: true, name: 'ffmpeg' }, { ok: false, name: 'speech model' }]) })
    expect(r.ok).toBe(true)
    expect(r.checks.find((c) => c.name === 'doctor: speech model')).toMatchObject({ ok: false, required: false })
  })

  it('fails on any other failed doctor check, keeping its fix', async () => {
    const r = await runSelfTest({ locations, ...all, runEngine: doctor([{ ok: false, name: 'filter subtitles', detail: 'missing', fix: 'Reinstall.' }]) })
    expect(r.ok).toBe(false)
    expect(r.checks.at(-1)).toEqual({ name: 'doctor: filter subtitles', ok: false, required: true, detail: 'missing (Reinstall.)' })
  })

  it('fails when a bundled file is missing even if doctor passes', async () => {
    const r = await runSelfTest({ locations, exists: (p) => p !== locations.ffprobe, engineExists: () => true, runEngine: doctor([]) })
    expect(r.ok).toBe(false)
    expect(r.checks.find((c) => c.name === 'bundled ffprobe')).toMatchObject({ ok: false, detail: locations.ffprobe })
  })

  it('fails when the engine cannot start', async () => {
    const run: RunEngine = async () => {
      throw { code: 'ENGINE_MISSING', userMessage: 'x', message: '/r/python/bin/python3: spawn ENOENT' }
    }
    const r = await runSelfTest({ locations, ...all, runEngine: run })
    expect(r.ok).toBe(false)
    expect(r.checks.at(-1)).toMatchObject({ name: 'engine doctor', ok: false, detail: { code: 'ENGINE_MISSING' } })
  })

  it('fails when doctor returns something that is not a doctor report', async () => {
    const r = await runSelfTest({ locations, ...all, runEngine: async () => ({ ok: true }) })
    expect(r.ok).toBe(false)
    expect(r.checks.at(-1)).toMatchObject({ name: 'engine doctor', ok: false })
  })

  it('stops a doctor that hangs and fails with the time limit', async () => {
    const run: RunEngine = (_c, _a, _p, signal) =>
      new Promise((_resolve, reject) => signal!.addEventListener('abort', () => reject({ code: 'CANCELLED', userMessage: 'Stopped.' })))
    const r = await runSelfTest({ locations, ...all, runEngine: run, timeoutMs: 50 })
    expect(r.ok).toBe(false)
    expect(r.checks.at(-1)).toMatchObject({ name: 'engine doctor', ok: false, detail: 'doctor did not finish within 0.05s' })
  })
})
