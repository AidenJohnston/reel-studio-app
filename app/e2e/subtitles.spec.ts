// The Subtitles list in "Edit it myself": a fix typed over a word and an Enter in a line go into the project,
// anchored on word ids, and the next version's lines show them. Same env as smoke.spec.ts.
import { test, expect } from '@playwright/test'
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { BASE, launch, makeMedia, passFirstRun } from './helpers'

const MINE = mkdtempSync(join(BASE, 'subs-'))
const ROOT = join(MINE, 'Documents', 'Reel Studio')

function projectJson(): any {
  const dir = join(ROOT, 'Projects')
  return JSON.parse(readFileSync(join(dir, readdirSync(dir)[0], 'project.json'), 'utf8'))
}

test('fix a word and break a line in the Subtitles list', async () => {
  test.setTimeout(10 * 60_000)
  const media = makeMedia()
  const { app, page } = await launch({ REELSTUDIO_ROOT: ROOT, REELSTUDIO_USER_DATA: join(MINE, 'user data') })
  await passFirstRun(page)
  await page.getByTestId('new-video').click()
  await page.getByTestId('file-input').setInputFiles([media.video])
  await expect(page.getByTestId('player')).toBeVisible({ timeout: 10 * 60_000 })
  await page.getByTestId('edit-myself').click()
  await page.getByTestId('tab-captions').click()

  const first = page.getByLabel('Subtitle line 1')
  await expect(first).toHaveValue('this is placeholder')
  await first.click()
  await expect(page.getByTestId('sub-preview')).toHaveText(/this is placeholder/i) // the clicked line, on the phone
  await first.fill('this is Placeholders')
  await first.evaluate((el: HTMLInputElement) => el.setSelectionRange(5, 5)) // the caret before "is"
  await page.keyboard.press('Enter')
  await expect(first).toHaveValue('this')
  await expect(page.getByLabel('Subtitle line 2')).toHaveValue('is Placeholders')
  await expect(page.getByLabel('Subtitle line 2')).toBeFocused()

  await page.getByTestId('make-version').click()
  await expect(page.getByTestId('versions').getByText('Version 2')).toBeVisible({ timeout: 10 * 60_000 })
  const cap = projectJson().captions
  expect(cap.split).toEqual(['w1'])
  expect(cap.corrections).toEqual([{ from: 'placeholder', to: 'Placeholders', at: 'w2' }])
  await expect(page.getByTestId('bubble-editor').last()).toContainText('fixed a word, new subtitle lines')

  await page.getByTestId('edit-myself').click()
  await page.getByTestId('tab-captions').click()
  await expect(page.getByLabel('Subtitle line 1')).toHaveValue('this')
  await expect(page.getByLabel('Subtitle line 2')).toHaveValue('is Placeholders')
  await app.close()
})
