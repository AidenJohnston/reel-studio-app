// What made each version: recorded by the job that made it (main/jobs.ts), read by the version menu (shared/versions.ts).
import { expect, it } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createJobManager } from '../src/main/jobs'
import { projectDir, readAppState } from '../src/main/store'
import { versionChanges, type ProjectNote } from '../src/shared/versions'
import type { VersionInfo } from '../src/shared/api'
import { setupPaths } from './helpers'

const version = (n: number): VersionInfo => ({ n, video: '', videoPath: '', draft: false, cover: null, createdAt: '' })

it('records what made a version once, when its final render made it, and the menu reads that record first', async () => {
  setupPaths()
  const slug = 'made'
  const finalRender = (n: number): void => {
    mkdirSync(join(projectDir(slug), 'versions', `v${n}`), { recursive: true })
    writeFileSync(join(projectDir(slug), 'versions', `v${n}`, 'export.mp4'), 'x')
  }
  mkdirSync(projectDir(slug), { recursive: true })
  const jobs = createJobManager(() => undefined, () => undefined)
  const run = async (...args: Parameters<typeof jobs.start>): Promise<void> => {
    jobs.start(...args)
    await jobs.forSlug(slug)?.done
  }

  await run(slug, 'rerender', async (emit) => {
    finalRender(2)
    emit({ type: 'render', version: 2, draft: false })
    return { summary: 'Version 2: bigger subtitles.', version: 2, made: { by: 'hand', summary: 'bigger subtitles' } }
  })
  // an AI note whose final render failed: only a preview, and a reply that reads like a change made by hand
  await run(slug, 'note', async (emit) => {
    emit({ type: 'render', version: 3, draft: true })
    return { summary: 'Version 3: I made the subtitles pop.', version: 3, made: { by: 'note', summary: 'make the subtitles pop' } }
  })
  // an unchanged edit re-renders, and so reuses, Version 2
  await run(slug, 'note', async (emit) => {
    finalRender(2)
    emit({ type: 'render', version: 2, draft: false })
    return { summary: 'Done.', version: 2, made: { by: 'note', summary: 'make it nicer' } }
  })

  const made = (await readAppState(slug)).versionsMade ?? []
  expect(made).toMatchObject([{ version: 2, by: 'hand', summary: 'bigger subtitles' }])
  // The project.json copies alone would credit Version 2 to this note: tagged 2, missing from Version 2's copy.
  const louder: ProjectNote = { version: 2, text: 'louder voice', applied: ['music'], at: 'a' }
  expect([...versionChanges([1, 2, 3].map(version), made, [louder], { 1: [], 2: [], 3: [] })]).toEqual([
    [1, 'First edit'],
    [2, 'Bigger subtitles'],
    [3, 'Changes not recorded']
  ])
})
