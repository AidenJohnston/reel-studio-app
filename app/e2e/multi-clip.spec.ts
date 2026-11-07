// One reel from several videos (tracker multi-clip-editing): three videos dropped on a new reel together become one
// project with three sources in the order they were dropped, Version 1 is made from them, and the Reel screen shows
// it. With the stand-in engine this checks the app's path; with REELSTUDIO_E2E_EXE=<packaged Reel Studio.exe> and
// REELSTUDIO_E2E_CLIPS=<take>;<take>;<take> (real takes with speech) the bundled engine cuts and renders them, and
// the spec also requires the cut to use more than one of them. It writes multi-clip.json next to the screenshots:
// the project folder, its sources and keep list, for the frame check made outside the app.
import { test, expect } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { BASE, SHOTS, launch, newProjectFolder, passFirstRun, projectFolders, root, shot } from './helpers'

const REAL = (process.env.REELSTUDIO_E2E_CLIPS ?? '').split(';').filter(Boolean)

/** Three short takes, each its own colour and tone, so a frame or a second of sound says which one it came from. */
function takes(): string[] {
  if (REAL.length) return REAL
  const dir = join(BASE, 'three takes')
  mkdirSync(dir, { recursive: true })
  return (['red', 'green', 'blue'] as const).map((c, i) => {
    const out = join(dir, `take ${i + 1} ${c}.mp4`)
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `color=c=${c}:size=540x960:rate=30:duration=6`,
      '-f', 'lavfi', '-i', `sine=frequency=${220 * (i + 1)}:duration=6`, '-c:v', 'libx264', '-preset', 'ultrafast',
      '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', out])
    return out
  })
}

interface Source { id: string; path: string; originalName?: string }
interface Keep { clip?: string; source?: string; from?: string; to?: string }

test('several videos dropped on a new reel make one reel from all of them', async () => {
  test.setTimeout(REAL.length ? 60 * 60_000 : 300_000)
  const files = takes()
  const { app, page } = await launch()
  await passFirstRun(page)
  const before = projectFolders(root())

  await page.getByTestId('new-reel').click()
  await page.getByTestId('planned-stage').getByTestId('file-input').setInputFiles(files)
  await expect(page.getByTestId('log-play-1')).toBeVisible({ timeout: REAL.length ? 55 * 60_000 : 240_000 })

  const dir = newProjectFolder(root(), before)
  const project = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as { sources: Source[]; cut: { keep: Keep[] } }
  // one project, every video in it, in the order they were dropped; fails if only the first video is kept
  expect(project.sources.map((s) => s.originalName)).toEqual(files.map((f) => basename(f)))
  expect(new Set(project.sources.map((s) => s.id)).size).toBe(files.length)

  if (REAL.length) {
    // the bundled engine cut across the takes: a keep list from one take alone means the others were dropped
    const words = JSON.parse(readFileSync(join(dir, 'work', 'transcript.json'), 'utf8')) as { words: { id: string; source?: string }[] }
    const sourceOf = new Map(words.words.map((w) => [w.id, w.source]))
    const used = new Set(project.cut.keep.map((k) => k.source ?? (k.from ? sourceOf.get(k.from) : undefined)).filter(Boolean))
    expect(used.size).toBeGreaterThan(1)
  }
  await expect(page.getByTestId('timeline')).toBeVisible()
  await shot(page, 'multi-clip-reel')

  mkdirSync(SHOTS, { recursive: true })
  writeFileSync(join(SHOTS, 'multi-clip.json'), JSON.stringify({
    packaged: !!process.env.REELSTUDIO_E2E_EXE, project: dir, files,
    sources: project.sources, keep: project.cut.keep
  }, null, 2))
  await app.close()
})
