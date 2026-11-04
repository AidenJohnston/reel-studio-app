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
