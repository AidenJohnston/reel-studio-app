// Series (tracker series-grouping): a reel whose words match an earlier reel's joins it in a series named after the
// earlier reel once Version 1 is made, and the person's own pick in More › Series… sticks when later reels are
// grouped. The stand-in engine gives every reel the same placeholder words, so every reel matches here.
import { test, expect, type Page } from '@playwright/test'
import { copyFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { BASE, launch, makeMedia, makeReel, newProjectFolder, passFirstRun, projectFolders, root, shot } from './helpers'

const series = (dir: string): string | undefined => JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')).series

async function reelFrom(page: Page, video: string): Promise<string> {
  const before = projectFolders(root())
  await makeReel(page, video)
  return newProjectFolder(root(), before)
}

test('reels that talk alike are grouped, and the person moving one out is kept', async () => {
  test.setTimeout(300_000)
  const media = makeMedia()
  const takes = ['bread one', 'bread two', 'bread three'].map((n) => {
    const out = join(BASE, `${n}.mp4`)
    copyFileSync(media.video, out)
    return out
  })
  const { app, page } = await launch()
  await passFirstRun(page)

  const first = await reelFrom(page, takes[0])
  // alone, nothing to group with
  expect(series(first)).toBeUndefined()
  const second = await reelFrom(page, takes[1])
  // named after the older reel, as More reels names its series (its title may be the editor's, not the file's)
  const name = series(first)!
  expect(name).toBeTruthy()
  expect(series(second)).toBe(name)

  // the person takes the second reel out of the series
  await page.getByTestId('more').click()
  await expect(page.getByTestId('series')).toHaveText(`Series: ${name}`)
  await page.getByTestId('series').click()
  const picker = page.getByTestId('series-picker')
  await expect(picker.getByRole('radio', { name })).toBeChecked()
  await shot(page, 'series-picker')
  await picker.getByRole('radio', { name: 'Not in a series' }).check()
  await picker.getByTestId('series-save').click()
  await expect(picker).toHaveCount(0)
  expect(series(second)).toBeUndefined()

  // a third reel joins the first one's series; the second stays where the person put it
  const third = await reelFrom(page, takes[2])
  expect(series(third)).toBe(name)
  expect(series(second)).toBeUndefined()
  await page.getByTestId('more').click()
  await expect(page.getByTestId('series')).toHaveText(`Series: ${name}`)

  // a new series by name
  await page.getByTestId('series').click()
  await picker.getByRole('radio', { name: 'A new series' }).check()
  await picker.getByTestId('series-save').click()
  await expect(picker.getByRole('alert')).toHaveText('Give the new series a name.')
  await picker.getByTestId('series-name').fill('Sourdough week')
  await picker.getByTestId('series-save').click()
  await expect(picker).toHaveCount(0)
  expect(series(third)).toBe('Sourdough week')
  await app.close()
})
