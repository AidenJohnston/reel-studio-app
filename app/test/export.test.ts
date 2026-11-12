// A hand edit ends at its draft, saved as the version; the full-quality file is made once, at Export
// (main/export.ts), against the stand-in engine. The real engine's side is engine/tests/test_versions.py.
import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createEngineRunner } from '../src/main/engine'
import { engineEnv } from '../src/main/paths'
import { makeExport, saveHandEdit } from '../src/main/export'
import { exportFacts } from '../src/shared/describe'
import type { JobUpdate } from '../src/shared/api'
import { FAKE_ENGINE, makeClip, PYTHON, setupPaths } from './helpers'

async function project() {
  const { home, root } = setupPaths()
  const run = createEngineRunner({ python: () => PYTHON, env: () => ({ ...engineEnv(), PYTHONPATH: FAKE_ENGINE }) })
  const dir = join(root, 'Projects', 'my reel')
  mkdirSync(dir, { recursive: true })
  await run('init', ['--project', dir, '--title', 'My reel', '--slug', 'my-reel', makeClip(join(home, 'take.mp4'))])
  await run('transcribe', ['--project', dir])
  await run('autocut', ['--project', dir])
  const events: JobUpdate[] = []
  const emit = (e: JobUpdate): void => void events.push(e)
  const signal = new AbortController().signal
  const edit = (patch: Record<string, unknown>): void => {
    const p = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8'))
    writeFileSync(join(dir, 'project.json'), JSON.stringify({ ...p, ...patch }))
  }
  return { run, dir, events, emit, signal, edit, v: (n: number, f: string) => join(dir, 'versions', `v${n}`, f) }
}

describe('a hand edit and Export', () => {
  it('a hand edit saves its draft as the version, with no full-quality render', async () => {
    const { run, dir, events, emit, signal, v } = await project()
    const version = await saveHandEdit(run, dir, 'Updating your subtitles', emit, signal)
    expect(version).toBe(1)
    expect(existsSync(v(1, 'draft.mp4'))).toBe(true)
    expect(existsSync(v(1, 'export.mp4'))).toBe(false)
    expect(JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')).version).toBe(1)
    // called what it is the whole way, and never past 100
    const statuses = events.filter((e) => e.type === 'status')
    expect(new Set(statuses.map((e) => e.message))).toEqual(new Set(['Updating your subtitles']))
    expect(statuses.every((e) => e.phase === 'final' && e.pct! >= 0 && e.pct! <= 100)).toBe(true)
  }, 60_000)

  it('Export renders the full-quality file once and hands back the same file while nothing changed', async () => {
    const { run, dir, emit, signal, edit, v } = await project()
    await saveHandEdit(run, dir, 'Updating your video', emit, signal)
    const first = await makeExport(run, dir, null, emit, signal)
    expect(first).toMatchObject({ version: 1, file: v(1, 'export.mp4'), reused: false })
    expect(existsSync(v(1, 'draft.mp4'))).toBe(false)
    const made = statSync(first.file).mtimeMs
    const again = await makeExport(run, dir, null, emit, signal)
    expect(again).toMatchObject({ version: 1, file: first.file, reused: true })
    expect(statSync(first.file).mtimeMs).toBe(made)
    // a changed edit is the next version, made in full only when it is exported
    edit({ captions: { enabled: false } })
    expect(await saveHandEdit(run, dir, 'Updating your subtitles', emit, signal)).toBe(2)
    expect((await makeExport(run, dir, null, emit, signal)).version).toBe(2)
    // the earlier version still has its own file
    expect(await makeExport(run, dir, 1, emit, signal)).toMatchObject({ version: 1, file: first.file, reused: true })
  }, 120_000)

  it('an earlier version that was only a preview says so instead of exporting another video', async () => {
    const { run, dir, emit, signal, edit } = await project()
    await saveHandEdit(run, dir, 'Updating your video', emit, signal)
    edit({ captions: { enabled: false } })
    await saveHandEdit(run, dir, 'Updating your subtitles', emit, signal)
    await expect(makeExport(run, dir, 1, emit, signal)).rejects.toMatchObject({
      code: 'ONLY_A_PREVIEW',
      userMessage: expect.stringContaining('Version 1')
    })
  }, 60_000)

  it("the facts are read from the exported file and say what people ask before they post", async () => {
    const { run, dir, emit, signal } = await project()
    await saveHandEdit(run, dir, 'Updating your video', emit, signal)
    const { facts, file } = await makeExport(run, dir, null, emit, signal)
    expect(facts).toMatchObject({ width: 1080, height: 1920, fps: 30, bytes: statSync(file).size, fullResolution: true })
  }, 60_000)
})

describe('the export facts line', () => {
  const facts = { width: 1080, height: 1920, fps: 30, bytes: 24_300_000, duration: 58.2, fullResolution: true }
  it('leads with the size, frame rate and file size, and says this is the file to post', () => {
    expect(exportFacts(facts)).toBe('1080x1920, 30 fps, full resolution, 24 MB. This is the file to post.')
  })
  it('keeps a fractional frame rate and a small file readable', () => {
    expect(exportFacts({ ...facts, fps: 29.97003, bytes: 4_210_000 })).toBe('1080x1920, 29.97 fps, full resolution, 4.2 MB. This is the file to post.')
    expect(exportFacts({ ...facts, bytes: 1_250_000_000 })).toBe('1080x1920, 30 fps, full resolution, 1.3 GB. This is the file to post.')
  })
  it('never calls a smaller file the one to post', () => {
    expect(exportFacts({ ...facts, width: 540, height: 960, fullResolution: false })).toBe('540x960, 30 fps, 24 MB. This is smaller than full resolution.')
  })
})
