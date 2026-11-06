// The learning loop, end to end in the built app with the stand-in engine and the mock AI: two reels whose subtitles
// the person made bigger by hand become one suggestion when My style opens; Edit keeps it in their own words as a
// rule "from your hand edits"; No thanks on another means it is never suggested again. The reels are written to
// disk as the app leaves them after "Edit it myself" (app.json versionsMade, versions/vN/version.json).
//
// Run: npm run build && npx playwright test e2e/memory-suggestions.spec.ts
import { test, expect } from '@playwright/test'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BASE, launch, passFirstRun, shot } from './helpers'

const MINE = mkdtempSync(join(BASE, 'suggest-'))
const ROOT = join(MINE, 'Documents', 'Reel Studio')

const project = (size: number, level = 'under-voice') => ({
  schemaVersion: 1, title: 'x', version: 2, captions: { enabled: true, style: { size, maxWords: 3 } }, music: { enabled: true, track: 'song.mp3', level }
})
function handMade(slug: string, title: string, before: object, after: object): void {
  const dir = join(ROOT, 'Projects', slug)
  const write = (path: string, value: unknown) => {
    mkdirSync(join(dir, path, '..'), { recursive: true })
    writeFileSync(join(dir, path), JSON.stringify(value))
  }
  write('project.json', { ...after, title })
  write('app.json', { chat: [], versionsMade: [{ version: 2, by: 'hand', summary: 'Changed it myself', at: '2026-11-05T10:00:00.000Z' }] })
  write('versions/v1/project.json', before)
  write('versions/v2/project.json', after)
  write('versions/v2/version.json', { parent: 1 })
}

test('hand edits in two reels become a suggestion; Edit keeps it in my words, No thanks never asks again', async () => {
  test.setTimeout(5 * 60_000)
  handMade('bread', 'Baking bread', project(105), project(126, 'quiet'))
  handMade('coffee', 'Pour-over coffee', project(96), project(120, 'quiet'))
  const { app, page } = await launch({ REELSTUDIO_ROOT: ROOT, REELSTUDIO_USER_DATA: join(MINE, 'user data') })
  try {
    test.skip((await page.evaluate(() => window.reel.app.info())).ai !== 'mock', 'the mock keeps My style')
    await passFirstRun(page)
    await page.getByTestId('nav-style').click()

    const card = page.getByTestId('style-suggestions')
    await expect(card).toBeVisible()
    await expect(card.getByRole('heading', { name: 'Habits worth keeping?' })).toBeVisible()
    const rows = page.getByTestId('style-suggestion')
    await expect(rows).toHaveCount(2)
    await expect(rows.filter({ hasText: 'Use bigger subtitles.' })).toContainText('You made the subtitles bigger by hand in 2 reels: “Baking bread” and “Pour-over coffee”.')
    // suggestions waiting: the page does not also say nothing was learned
    await expect(page.getByTestId('style-empty')).toHaveCount(0)
    await shot(page, 'suggest-01-card')

    await page.getByRole('button', { name: 'Edit "Use bigger subtitles" before keeping it' }).click()
    await page.getByTestId('suggestion-edit-input').fill('Use big subtitles, about 126 px')
    await shot(page, 'suggest-02-editing')
    await page.keyboard.press('Enter')
    const rule = page.getByTestId('style-rule')
    await expect(rule).toHaveCount(1)
    await expect(rule).toContainText('from your hand edits')

    await page.getByRole('button', { name: 'No thanks to "Keep the music quieter under my voice"' }).click()
    await expect(page.getByTestId('style-suggestions')).toHaveCount(0)
    await shot(page, 'suggest-03-kept')

    const saved = JSON.parse(readFileSync(join(ROOT, 'My style.json'), 'utf8'))
    expect(saved.rules).toEqual([expect.objectContaining({ text: 'Use big subtitles, about 126 px.', learned: expect.objectContaining({ from: 'edits' }) })])
    expect(saved.proposals).toEqual([])
    expect(saved.forgotten).toContain('Keep the music quieter under my voice.')
  } finally {
    await app.close().catch(() => {})
  }
})
