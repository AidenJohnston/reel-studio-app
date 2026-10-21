// What made each version: recorded by the job that made it (main/jobs.ts), read by the version menu (shared/versions.ts).
import { expect, it } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createJobManager } from '../src/main/jobs'
import { projectDir, readAppState } from '../src/main/store'
import { versionChanges } from '../src/shared/versions'
import type { JobEvent, VersionInfo } from '../src/shared/api'
import { setupPaths } from './helpers'

const version = (n: number): VersionInfo => ({ n, video: '', videoPath: '', draft: false, cover: null, createdAt: '' })

it('records what made a version when its final render made it, and the menu shows only that record', async () => {
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

it('a Stop after the final render has finished does not stop the job: it records the version and reports done', async () => {
  setupPaths()
  const slug = 'late-stop'
  mkdirSync(join(projectDir(slug), 'versions', 'v2'), { recursive: true })
  const events: JobEvent[] = []
  let videoReady = (): void => undefined
  let rendered = false
  // the final render's video is still being prepared when Stop arrives
  const jobs = createJobManager((e) => events.push(e), () => undefined, undefined, () => new Promise((r) => (videoReady = () => r(null))))
  const id = jobs.start(slug, 'rerender', async (emit) => {
    writeFileSync(join(projectDir(slug), 'versions', 'v2', 'export.mp4'), 'x')
    emit({ type: 'render', version: 2, draft: false })
    rendered = true
    return { summary: 'Version 2: new cover.', version: 2, made: { by: 'hand', summary: 'new cover' } }
  })
  await expect.poll(() => rendered).toBe(true)
  jobs.cancel(id)
  videoReady()
  await jobs.forSlug(slug)?.done
  expect((await readAppState(slug)).versionsMade).toMatchObject([{ version: 2, by: 'hand', summary: 'new cover' }])
  expect(events.map((e) => e.type)).toContain('done')
  expect(events.map((e) => e.type)).not.toContain('cancelled')
})
