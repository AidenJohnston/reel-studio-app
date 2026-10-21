import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { RunEngine } from '../src/main/engine'
import { runSelfTest } from '../src/main/self-test'

const root = mkdtempSync(join(tmpdir(), 'rs-self-test-'))
const locations = {
  python: join(root, 'python3'), ffmpeg: join(root, 'ffmpeg'), engine: root,
  ffprobe: execFileSync(process.platform === 'win32' ? 'where' : 'which', ['ffprobe'], { encoding: 'utf8' }).trim().split(/\r?\n/)[0]
}
mkdirSync(join(root, 'reelengine'))
for (const file of [locations.python, locations.ffmpeg, join(root, 'reelengine', '__main__.py')]) writeFileSync(file, '')
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

  it.each(['non-executable', 'broken', 'wrong-version'])('fails if a %s ffprobe passes', async (kind) => {
    const ffprobe = kind === 'non-executable' ? join(root, 'not-executable')
      : kind === 'broken' ? process.execPath
        : execFileSync(process.platform === 'win32' ? 'where' : 'which', ['ffmpeg'], { encoding: 'utf8' }).trim().split(/\r?\n/)[0]
    if (kind === 'non-executable') writeFileSync(ffprobe, 'not an executable')
    const result = await runSelfTest({ locations: { ...locations, ffprobe }, runEngine: doctor([]) })
    expect(result.ok).toBe(false)
    expect(result.checks.find((check) => check.name === 'bundled ffprobe')?.ok).toBe(false)
  })
})
