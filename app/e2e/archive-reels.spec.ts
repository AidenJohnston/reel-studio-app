// Reels in your footage (tracker raw-to-many-reels): with footage read, the editor suggests reels across the files,
// one of them made from two videos; Make starts that reel from both files, cut to the proposed parts as clips. The
// stand-in engine gives each file a placeholder line every 4 s (dev/fake-engine footage digest) and the practice
// editor (ai-mock.ts proposeFromArchive) joins lines in file order until a reel plays for 15 s.
import { test, expect, type ElectronApplication } from '@playwright/test'
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { BASE, launch, makeMedia, passFirstRun, projectFolders, newProjectFolder, root, shot } from './helpers'

async function answerFolderPicker(app: ElectronApplication, folder: string): Promise<void> {
  await app.evaluate(({ dialog }, f) => {
    ;(dialog as any).showOpenDialog = async () => ({ canceled: false, filePaths: [f] })
  }, folder)
}

test('reels found across the footage are made from the files they came from', async () => {
  test.setTimeout(300_000)
  const media = makeMedia()   // a 12 s take: three 3.5 s placeholder lines
  const drive = join(BASE, 'Shoots ü')
  mkdirSync(drive, { recursive: true })
  copyFileSync(media.video, join(drive, 'a monday.mp4'))
  copyFileSync(media.video, join(drive, 'b tuesday.mp4'))
  const { app, page } = await launch({ REELSTUDIO_TEST_INDEX: '1', FAKE_ENGINE_INDEX_STEP: '0.1', REELSTUDIO_MOCK_NOTE: '300' })
  await passFirstRun(page)
  await page.getByTestId('nav-library').click()
  await page.getByTestId('library-tab-videos').click()

  // ---- read the folder, then ask ----
  await answerFolderPicker(app, drive)
  await page.getByTestId('footage-add').click()
  await expect(page.getByTestId('footage-folder')).toContainText('2 videos', { timeout: 30_000 })
  const archive = page.getByTestId('archive-reels')
  await archive.getByTestId('archive-find').click()
  const rows = archive.getByTestId('archive-row')
  // the first file (0.5 to 12 s) is short of a reel, so it runs on into the second; what is left is too short for another
  await expect(rows).toHaveCount(1, { timeout: 30_000 })
  await expect(rows).toContainText('The one fold that fixed my crumb')
  await expect(rows.getByTestId('archive-spans')).toHaveText('a monday.mp4 0:00 to 0:12 · b tuesday.mp4 0:00 to 0:04 · 15 s')
  await shot(page, 'archive-reels')

  // ---- make it: one reel from both files, cut to those parts ----
  const before = projectFolders(root())
  await archive.getByTestId('archive-tick').check()
  await archive.getByTestId('archive-make').click()
  await expect(page.getByTestId('library-result')).toHaveText('Making 1 reel. It is on Reels.')
  await expect(rows).toContainText('Made')
  await expect(archive.getByTestId('archive-tick')).toHaveCount(0)
  await expect.poll(() => projectFolders(root()).length, { timeout: 60_000 }).toBe(before.length + 1)
  const dir = newProjectFolder(root(), before)
  const project = () => JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8'))
  await expect.poll(() => existsSync(join(dir, 'project.json')) && project().proposal?.archive === true, { timeout: 120_000 }).toBe(true)
  const p = project()
  expect(p.sources.map((s: { originalName: string }) => s.originalName)).toEqual(['a monday.mp4', 'b tuesday.mp4'])
  expect(p.cut.keep).toEqual([{ clip: 'c1', source: 's1', in: 0.5, out: 12 }, { clip: 'c2', source: 's2', in: 0.5, out: 4 }])
  // the files on the drive are where they were
  expect(existsSync(join(drive, 'a monday.mp4'))).toBe(true)
  await app.close()
})
