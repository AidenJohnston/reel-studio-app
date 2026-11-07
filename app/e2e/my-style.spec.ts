// My style in the built app. With the mock AI this is the stand-in the app runs when the AI package fails to load;
// REELSTUDIO_E2E_AI=package runs it against the real package.
//
// Run: npm run build && npx playwright test e2e/my-style.spec.ts
import { test, expect } from '@playwright/test'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BASE, launch, passFirstRun, shot } from './helpers'
import { makePastEditsHome, videoFolder } from './past-edits-home'

const MAC = process.platform === 'darwin'

test('a damaged My style file is kept next to a new one, and My style says so in one line', async () => {
  const mine = mkdtempSync(join(BASE, 'style-'))
  const root = join(mine, 'Documents', 'Reel Studio')
  mkdirSync(root, { recursive: true })
  const damaged = '{"version":1,"rules":[{"id":"a","text":"Keep music quieter under talk'
  writeFileSync(join(root, 'My style.json'), damaged)
  const { app, page } = await launch({ REELSTUDIO_ROOT: root, REELSTUDIO_USER_DATA: join(mine, 'user data') })
  try {
    await passFirstRun(page)
    await page.getByTestId('nav-style').click()
    await expect(page.getByTestId('style-damaged')).toHaveText(
      'Your saved style file was damaged, so a new one was started. The old one is kept next to it.'
    )
    await expect(page.getByTestId('style-empty')).toBeVisible()
    await shot(page, 'style-damaged')
    expect(readFileSync(join(root, 'My style.damaged.json'), 'utf8')).toBe(damaged)
  } finally {
    await app.close().catch(() => {})
  }
})

test('Edit changes a rule\'s words, and Pause keeps it listed but off until Resume', async () => {
  const mine = mkdtempSync(join(BASE, 'style-'))
  const root = join(mine, 'Documents', 'Reel Studio')
  const file = join(root, 'My style.json')
  mkdirSync(root, { recursive: true })
  writeFileSync(file, JSON.stringify({ version: 1, rules: [{ id: 'r1', text: 'Keep music quieter under talking.', createdAt: '2026-10-22T00:00:00.000Z' }] }))
  const saved = () => JSON.parse(readFileSync(file, 'utf8')).rules
  const { app, page } = await launch({ REELSTUDIO_ROOT: root, REELSTUDIO_USER_DATA: join(mine, 'user data') })
  try {
    await passFirstRun(page)
    await page.getByTestId('nav-style').click()
    const rule = page.getByTestId('style-rule')
    await expect(rule).toContainText('Keep music quieter under talking')

    // Edit sits under the rule's line, beside the full sentence. Escape leaves the words as they were and puts
    // focus back on Edit
    await page.getByRole('button', { name: 'Music: Keep music quieter under talking' }).click()
    await page.getByRole('button', { name: 'Edit "Keep music quieter under talking"' }).click()
    await page.getByTestId('style-edit-input').fill('Something else')
    await page.keyboard.press('Escape')
    await expect(page.getByRole('button', { name: 'Edit "Keep music quieter under talking"' })).toBeFocused()

    await page.keyboard.press('Enter')
    // typed loosely: saved as one sentence, capitalised, with a full stop, as a new rule is
    await page.getByTestId('style-edit-input').fill('keep music much quieter under talking')
    await shot(page, 'style-editing')
    await page.keyboard.press('Enter')
    await expect(rule).toContainText('Keep music much quieter under talking')
    expect(saved()).toEqual([expect.objectContaining({ id: 'r1', text: 'Keep music much quieter under talking.' })])

    await page.getByRole('button', { name: 'Pause "Keep music much quieter under talking"' }).click()
    await expect(rule).toContainText('Paused')
    expect(saved()[0].paused).toBe(true)
    await shot(page, 'style-paused')
    await page.getByRole('button', { name: 'Resume "Keep music much quieter under talking"' }).click()
    await expect(rule).not.toContainText('Paused')
    expect(saved()[0].paused).toBeUndefined()
  } finally {
    await app.close().catch(() => {})
  }
})

test('Learn from my past edits lists the edits on this computer by app, and learns from the ticked ones in one click', async () => {
  const mine = mkdtempSync(join(BASE, 'style-'))
  const root = join(mine, 'Documents', 'Reel Studio')
  const home = join(mine, 'home')
  mkdirSync(root, { recursive: true })
  makePastEditsHome(home)
  // one editor is installed and the other isn't: Final Cut Pro on a Mac; on Windows, where Final Cut Pro can't be,
  // Premiere Pro, laid out as Adobe installs it (main app-icons.ts locate)
  const apps = join(mine, MAC ? 'Applications' : 'Program Files')
  if (MAC) mkdirSync(join(apps, 'Final Cut Pro.app'), { recursive: true })
  else {
    mkdirSync(join(apps, 'Adobe', 'Adobe Premiere Pro 2026'), { recursive: true })
    writeFileSync(join(apps, 'Adobe', 'Adobe Premiere Pro 2026', 'Adobe Premiere Pro.exe'), '')
  }
  const [installed, missing] = MAC ? [0, 1] : [1, 0]
  const { app, page } = await launch({
    REELSTUDIO_ROOT: root,
    REELSTUDIO_USER_DATA: join(mine, 'user data'),
    REELSTUDIO_TEST_PAST_EDITS_HOME: home,
    REELSTUDIO_TEST_APPS_DIR: apps
  })
  try {
    await passFirstRun(page)
    await page.getByTestId('nav-style').click()
    // fails if the button opens a file dialog again (Sam cancelled it twice): the sheet opens, the dialog never does
    await app.evaluate(({ dialog }) => {
      ;(dialog as any).showOpenDialog = async () => {
        throw new Error('a file dialog opened')
      }
    })
    await page.getByTestId('style-learn').click()
    const sheet = page.getByTestId('learn-sheet')
    const groups = sheet.getByTestId('learn-group')
    await expect(groups).toHaveCount(2)
    // each app's section is named by its heading (aria-labelledby broke on the space in "Final Cut Pro")
    await expect(groups.nth(0)).toHaveAccessibleName('Final Cut Pro')
    await expect(groups.nth(1)).toHaveAccessibleName('Premiere Pro')
    // the installed editor's own icon from the system; the missing one gets the neutral icon, never a drawn copy
    await expect(groups.nth(installed).getByTestId('learn-app-icon')).toHaveAttribute('src', /^data:image\/png;base64,/)
    await expect(groups.nth(missing).getByTestId('learn-app-icon')).toHaveCount(0)
    await expect(groups.nth(missing).getByTestId('learn-app-neutral')).toBeVisible()
    // Return learns from what is ticked: the Learn button has the focus once the list is there
    await expect(page.getByTestId('learn-go')).toBeFocused()
    const items = sheet.getByTestId('learn-item')
    await expect(items).toHaveText([new RegExp(`^Spring launchXML export · .* · 1 timeline · ${videoFolder()} › Exports$`), /^Kitchen tour/, /^talking-head.* · Desktop$/])
    for (const box of await items.locator('input').all()) await expect(box).toBeChecked()
    // a library and a project can't be read as they are: each says once how to export one, beside Show in Finder
    const needs = sheet.getByTestId('learn-needs-export')
    // in their own sub-group after the tickable rows, named for what they need, with no checkbox
    await expect(needs.nth(0)).toHaveAccessibleName('Needs an export first')
    await expect(needs.nth(0)).toContainText('In Final Cut Pro, select the project, then choose File › Export XML…')
    await expect(needs.locator('input[type="checkbox"]')).toHaveCount(0)
    await expect(needs.nth(0).getByTestId('learn-item-waiting')).toContainText('Untitled')
    await expect(needs.nth(1)).toContainText('In Premiere Pro, open the project, then choose File › Export › Final Cut Pro XML…')
    await expect(needs.nth(1).getByRole('button', { name: 'Show Interview in Finder' }).or(needs.nth(1).getByRole('button', { name: 'Show Interview in Explorer' }))).toBeVisible()

    // back from the editor with a new export: the list looks again when the window has focus, and ticks it
    copyFileSync(join(home, 'Desktop', 'talking-head.xml'), join(home, 'Documents', 'Fresh export.xml'))
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await expect(items.filter({ hasText: 'Fresh export' }).locator('input')).toBeChecked()

    await items.filter({ hasText: 'Fresh export' }).locator('input').uncheck()
    await items.filter({ hasText: 'Kitchen tour' }).locator('input').uncheck()
    await page.getByTestId('learn-go').click()
    await expect(sheet).toHaveCount(0)
    await expect(page.getByTestId('style-lesson')).toContainText('Spring launch.fcpxml (Final Cut Pro), talking-head.xml (Premiere Pro)')
    expect(await page.evaluate(() => window.reel.style.rules())).toEqual([])

    // what crosses to the page names edits by id: no path in what was found or in what was read
    const crossed = await page.evaluate(async () => {
      const found = await window.reel.style.find()
      const lesson = await window.reel.style.learn(found.edits.filter((e) => e.readable).map((e) => e.id))
      return JSON.stringify({ found, lesson })
    })
    expect(crossed).toContain('Spring launch.fcpxml')
    expect(crossed).not.toContain(home)
  } finally {
    await app.close().catch(() => {})
  }
})

// The sample is built from the documented draft layout (engine reference_capcut.py), not a real CapCut project.
test('a CapCut project where CapCut keeps it is listed under CapCut, read as it is, and its rules say CapCut', async () => {
  const mine = mkdtempSync(join(BASE, 'style-'))
  const root = join(mine, 'Documents', 'Reel Studio')
  const home = join(mine, 'home')
  mkdirSync(root, { recursive: true })
  const projects = join(home, ...(process.platform === 'darwin' ? ['Movies'] : ['AppData', 'Local']), 'CapCut', 'User Data', 'Projects', 'com.lveditor.draft')
  mkdirSync(join(projects, 'Bread reel'), { recursive: true })
  copyFileSync(join(__dirname, '..', '..', 'engine', 'tests', 'fixtures', 'reference-import', 'capcut-draft', 'draft_content.json'), join(projects, 'Bread reel', 'draft_content.json'))
  const { app, page } = await launch({
    REELSTUDIO_ROOT: root,
    REELSTUDIO_USER_DATA: join(mine, 'user data'),
    REELSTUDIO_TEST_PAST_EDITS_HOME: home
  })
  try {
    await passFirstRun(page)
    await page.getByTestId('nav-style').click()
    await page.getByTestId('style-learn').click()
    const sheet = page.getByTestId('learn-sheet')
    await expect(sheet.getByTestId('learn-group')).toHaveText([/^CapCut/])
    const item = sheet.getByTestId('learn-item')
    await expect(item).toHaveText([/^Bread reelProject · .* · 1 timeline · CapCut$/])
    await expect(item.locator('input')).toBeChecked()
    await shot(page, 'learn-capcut-01-listed')
    await page.getByTestId('learn-go').click()
    const lesson = page.getByTestId('style-lesson')
    await expect(lesson).toContainText('Bread reel/draft_content.json (CapCut)')
    // the sample's title at half a second and its song under the talking
    await expect(page.getByTestId('style-lesson-rule')).toContainText(['Open with a title on screen in the first few seconds.', 'Put music under the talking.'])
    await page.getByTestId('style-lesson-keep').click()
    await expect(page.getByTestId('style-rule').first()).toContainText('from your CapCut edit Bread reel/draft_content.json')
    await shot(page, 'learn-capcut-02-kept')
  } finally {
    await app.close().catch(() => {})
  }
})

test('with nothing found, Learn from my past edits says so and how to get one in, and opens no file dialog by itself', async () => {
  const mine = mkdtempSync(join(BASE, 'style-'))
  const root = join(mine, 'Documents', 'Reel Studio')
  mkdirSync(root, { recursive: true })
  const { app, page } = await launch({ REELSTUDIO_ROOT: root, REELSTUDIO_USER_DATA: join(mine, 'user data'), REELSTUDIO_TEST_PAST_EDITS_HOME: join(mine, 'empty home') })
  try {
    await passFirstRun(page)
    await page.getByTestId('nav-style').click()
    const opened: string[] = []
    await app.evaluate(({ dialog }) => {
      ;(globalThis as any).__dialogs = 0
      ;(dialog as any).showOpenDialog = async () => {
        ;(globalThis as any).__dialogs++
        return { canceled: true, filePaths: [] }
      }
    })
    await page.getByTestId('style-learn').click()
    const none = page.getByTestId('learn-none')
    await expect(none).toContainText(/No edits from (Final Cut Pro, )?Premiere Pro, DaVinci Resolve or CapCut on this (Mac|PC) yet\./)
    await expect(none).toContainText('Export one from your editor.')
    await expect(none).toContainText('In Premiere Pro, open the project, then choose File › Export › Final Cut Pro XML… In DaVinci Resolve, choose File › Export › Timeline… and save it as FCPXML. Save it anywhere')
    opened.push(String(await app.evaluate(() => (globalThis as any).__dialogs)))
    await page.getByTestId('learn-choose').click()
    opened.push(String(await app.evaluate(() => (globalThis as any).__dialogs)))
    // only Choose files… opens the dialog; cancelled, the sheet stays
    expect(opened).toEqual(['0', '1'])
    await expect(none).toBeVisible()
  } finally {
    await app.close().catch(() => {})
  }
})

test('when a limit stops the look, Learn from my past edits says older edits may be missing and keeps what it found', async () => {
  const mine = mkdtempSync(join(BASE, 'style-'))
  const root = join(mine, 'Documents', 'Reel Studio')
  const home = join(mine, 'home')
  mkdirSync(root, { recursive: true })
  makePastEditsHome(home)
  const { app, page } = await launch({
    REELSTUDIO_ROOT: root,
    REELSTUDIO_USER_DATA: join(mine, 'user data'),
    REELSTUDIO_TEST_PAST_EDITS_HOME: home,
    // the walk reads the top of Movies (Videos on Windows), Documents and Desktop (7 entries), then stops before the
    // folders below
    REELSTUDIO_TEST_PAST_EDITS_LIMITS: JSON.stringify({ walk: 7 })
  })
  try {
    await passFirstRun(page)
    await page.getByTestId('nav-style').click()
    await page.getByTestId('style-learn').click()
    await expect(page.getByTestId('learn-item')).toHaveText([/^talking-head/])
    await expect(page.getByTestId('learn-item-waiting')).toHaveText([/^Untitled/])
    await expect(page.getByTestId('learn-cut')).toHaveText(
      /^This (Mac|PC) has too many files to look through them all, so older edits may be missing\. Use Choose files… for those\.$/
    )
    await expect(page.getByTestId('learn-choose')).toBeVisible()
  } finally {
    await app.close().catch(() => {})
  }
})
