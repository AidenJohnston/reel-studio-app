import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { RunEngine } from '../src/main/engine'
import { runSelfTest } from '../src/main/self-test'

const root = mkdtempSync(join(tmpdir(), 'rs-self-test-'))
const locations = { python: join(root, 'python3'), ffmpeg: join(root, 'ffmpeg'), ffprobe: join(root, 'ffprobe'), engine: root }
mkdirSync(join(root, 'reelengine'))
for (const file of [locations.python, locations.ffmpeg, locations.ffprobe, join(root, 'reelengine', '__main__.py')]) writeFileSync(file, '')
afterAll(() => rmSync(root, { recursive: true, force: true }))

function doctor(checks: { ok: boolean; name: string; detail?: string; fix?: string }[]): RunEngine {
  return async (command) => {
    expect(command).toBe('doctor')
    return { ok: checks.every((c) => c.ok), checks: checks.map((c) => ({ detail: '', fix: '', ...c })) }
  }
}

describe('runSelfTest', () => {
  it('fails if a fresh install requires a speech model', async () => {
    const r = await runSelfTest({ locations, runEngine: doctor([{ ok: true, name: 'ffmpeg' }, { ok: false, name: 'speech model' }]) })
    expect(r.ok).toBe(true)
    expect(r.checks.find((c) => c.name === 'doctor: speech model')).toMatchObject({ ok: false, required: false })
  })

  it('fails if a required doctor failure is ignored', async () => {
    const r = await runSelfTest({ locations, runEngine: doctor([{ ok: false, name: 'filter subtitles', detail: 'missing', fix: 'Reinstall.' }]) })
    expect(r.ok).toBe(false)
    expect(r.checks.at(-1)).toEqual({ name: 'doctor: filter subtitles', ok: false, required: true, detail: 'missing (Reinstall.)' })
  })

  it('fails if missing bundled files are accepted', async () => {
    const r = await runSelfTest({ locations: { ...locations, ffprobe: join(root, 'missing-ffprobe') }, runEngine: doctor([]) })
    expect(r.ok).toBe(false)
    expect(r.checks.find((c) => c.name === 'bundled ffprobe')).toMatchObject({ ok: false, detail: join(root, 'missing-ffprobe') })
  })

  it('fails if a hanging doctor is not stopped', async () => {
    const run: RunEngine = (_c, _a, _p, signal) =>
      new Promise((_resolve, reject) => signal!.addEventListener('abort', () => reject({ code: 'CANCELLED', userMessage: 'Stopped.' })))
    const r = await runSelfTest({ locations, runEngine: run, timeoutMs: 50 })
    expect(r.ok).toBe(false)
    expect(r.checks.at(-1)).toMatchObject({ name: 'engine doctor', ok: false, detail: 'doctor did not finish within 0.05s' })
  })
})
