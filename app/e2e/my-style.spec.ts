// My style in the built app. With the mock AI this is the stand-in the app runs when the AI package fails to load;
// REELSTUDIO_E2E_AI=package runs it against the real package.
//
// Run: npm run build && npx playwright test e2e/my-style.spec.ts
import { test, expect } from '@playwright/test'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BASE, launch, passFirstRun, shot } from './helpers'

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
      'Your saved style file was damaged, so I started a new one. The old one is kept next to it.'
    )
    await expect(page.getByText('Nothing here yet.')).toBeVisible()
    await shot(page, 'style-damaged')
    expect(readFileSync(join(root, 'My style.damaged.json'), 'utf8')).toBe(damaged)
  } finally {
    await app.close().catch(() => {})
  }
})

test('Edit changes a rule\'s words, and Pause keeps it listed but off', async () => {
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
    await expect(rule).toContainText('Keep music quieter under talking.')

    // Escape leaves the words as they were and puts focus back on Edit
    await page.getByRole('button', { name: 'Edit "Keep music quieter under talking."' }).click()
    await page.getByTestId('style-edit-input').fill('Something else')
    await page.keyboard.press('Escape')
    await expect(page.getByRole('button', { name: 'Edit "Keep music quieter under talking."' })).toBeFocused()

    await page.keyboard.press('Enter')
    // typed loosely: saved as one sentence, capitalised, with a full stop, as a new rule is
    await page.getByTestId('style-edit-input').fill('keep music much quieter under talking')
    await shot(page, 'style-editing')
    await page.keyboard.press('Enter')
    await expect(rule).toContainText('Keep music much quieter under talking.')
    expect(saved()).toEqual([expect.objectContaining({ id: 'r1', text: 'Keep music much quieter under talking.' })])

    await page.getByRole('button', { name: 'Pause "Keep music much quieter under talking."' }).click()
    await expect(rule).toContainText('Paused')
    expect(saved()[0].paused).toBe(true)
    await shot(page, 'style-paused')
    await page.getByRole('button', { name: 'Turn back on "Keep music much quieter under talking."' }).click()
    await expect(rule).not.toContainText('Paused')
    expect(saved()[0].paused).toBeUndefined()
  } finally {
    await app.close().catch(() => {})
  }
})
