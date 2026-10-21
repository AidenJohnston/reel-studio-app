// What made each version: recorded by the job that made it (main/jobs.ts), read by the version menu (shared/versions.ts).
import { expect, it } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createJobManager } from '../src/main/jobs'
import { projectDir, readAppState } from '../src/main/store'
import { versionChanges } from '../src/shared/versions'
import type { ProjectJson, VersionInfo } from '../src/shared/api'
import { setupPaths } from './helpers'

const version = (n: number): VersionInfo => ({ n, video: '', videoPath: '', draft: false, cover: null, createdAt: '' })

it('records what made a version when its final render made it, and the menu shows only that record', async () => {
  setupPaths()
  const slug = 'made'
  // what a final render leaves behind: versions/vN/export.mp4, and project.json's `version` set to N
  const finalRender = (n: number): void => {
    mkdirSync(join(projectDir(slug), 'versions', `v${n}`), { recursive: true })
    writeFileSync(join(projectDir(slug), 'versions', `v${n}`, 'export.mp4'), 'x')
    const project: ProjectJson = { schemaVersion: 1, id: slug, title: 'Made', slug, createdAt: '2026-10-21T09:00:00.000Z', updatedAt: '2026-10-21T09:00:00.000Z', version: n }
    writeFileSync(join(projectDir(slug), 'project.json'), JSON.stringify(project, null, 2))
  }
  finalRender(1) // the first edit
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

  expect((await readAppState(slug)).versionsMade).toMatchObject([{ version: 2, by: 'hand', summary: 'bigger subtitles' }])
  // Version 2 deleted, then a different Version 2 made from a note: its record replaces the old one
  rmSync(join(projectDir(slug), 'versions', 'v2'), { recursive: true })
  await run(slug, 'note', async (emit) => {
    finalRender(2)
    emit({ type: 'render', version: 2, draft: false })
    return { summary: 'Done.', version: 2, made: { by: 'note', summary: 'music too loud' } }
  })

  const made = (await readAppState(slug)).versionsMade ?? []
  expect(made).toMatchObject([{ version: 2, by: 'note', summary: 'music too loud' }])
  // Version 3 has no record (made before records existed, or by a failed run): nothing is guessed for it
  expect([...versionChanges([1, 2, 3].map(version), made)]).toEqual([
    [1, 'First edit'],
    [2, '“music too loud”'],
    [3, 'Changes not recorded']
  ])
})
