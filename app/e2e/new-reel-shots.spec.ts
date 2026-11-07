// Screenshots of the New reel screen (a reel with no video yet) at the four window sizes the app supports. Not a test
// of behaviour: it photographs the screen so a person can look at it. Skipped unless asked for.
//
//   REELSTUDIO_SHOTS_DIR=<folder>   where the pictures go
//
// Each state is shot at 1100 x 720 (the smallest window), 1280 x 820 (the default), 1512 x 982 and 1920 x 1080:
//   no-editor   nothing connected: the plan panel asks to connect the editor
//   no-editor-plan  a plan saved earlier (made with an editor since disconnected), nothing connected now
//   chat-empty  the practice editor connected, nothing said yet
//   chat-plan   two questions answered, the plan proposed
// and at the smallest size only: chat-answering (the editor thinking) and chat-long (a long message and long plan lines).
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { BASE, expectViewport, launch, passFirstRun } from './helpers'

const OUT = process.env.REELSTUDIO_SHOTS_DIR
test.skip(!OUT, 'set REELSTUDIO_SHOTS_DIR to run')

const SIZES = [
  [1100, 720],
  [1280, 820],
  [1512, 982],
  [1920, 1080]
] as const

function profile(name: string): Record<string, string> {
  const dir = mkdtempSync(join(BASE, `shots-${name}-`))
  return { REELSTUDIO_USER_DATA: join(dir, 'user data'), REELSTUDIO_ROOT: join(dir, 'Reel Studio') }
}

async function size(app: ElectronApplication, page: Page, w: number, h: number): Promise<void> {
  await app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setContentSize(w, h), [w, h] as const)
  await expectViewport(page, w, h)
  await page.waitForTimeout(300)
}

async function shoot(app: ElectronApplication, page: Page, state: string, sizes: readonly (readonly [number, number])[] = SIZES): Promise<void> {
  mkdirSync(OUT!, { recursive: true })
  for (const [w, h] of sizes) {
    await size(app, page, w, h)
    await page.screenshot({ path: join(OUT!, `${state}-${w}x${h}.png`) })
  }
}

async function say(page: Page, text: string): Promise<void> {
  await page.getByTestId('note-input').fill(text)
  await page.keyboard.press('Enter')
}

test('no editor', async () => {
  const { app, page } = await launch(profile('none'), { realViewport: true })
  try {
    await passFirstRun(page)
    await page.getByTestId('new-reel').click()
    await expect(page.getByTestId('planned-stage')).toBeVisible()
    await shoot(app, page, 'no-editor')

    const slug = await page.locator('.reel-page').getAttribute('data-slug')
    await page.evaluate(
      (s) =>
        window.reel.projects.setPlan(s!, {
          topic: 'How I make sourdough without a mixer',
          hooks: ['You do not need a mixer to make good sourdough.'],
          hook: 0,
          beats: [{ text: 'Flour, water, salt. Nothing else goes in.' }, { text: 'Mix it by hand, then leave it for an hour.' }, { text: 'Bake it hot in a closed pot.' }],
          shots: [{ text: 'You at the kitchen counter, by the window' }]
        }),
      slug
    )
    await page.getByTestId('nav-home').click()
    await page.getByTestId('project-card').click()
    await expect(page.getByTestId('plan-card')).toBeVisible()
    await shoot(app, page, 'no-editor-plan')
  } finally {
    await app.close()
  }
})

test('planning with the editor', async () => {
  const { app, page } = await launch({ ...profile('chat'), REELSTUDIO_MOCK_NOTE: '600' }, { realViewport: true })
  try {
    await passFirstRun(page)
    await page.getByTestId('new-reel').click()
    await expect(page.getByTestId('planned-stage')).toBeVisible()
    await shoot(app, page, 'chat-empty')

    await size(app, page, 1100, 720)
    await say(page, 'How I make sourdough without a mixer')
    await expect(page.getByTestId('plan-answering')).toBeVisible()
    await page.screenshot({ path: join(OUT!, 'chat-answering-1100x720.png') })
    await expect(page.getByTestId('plan-question')).toHaveText('Who is it for?')
    await say(page, 'People who have never baked bread')
    await expect(page.getByTestId('plan-question').nth(1)).toBeVisible()
    await say(page, 'You do not need fancy gear')
    await expect(page.getByTestId('plan-card')).toBeVisible()
    await shoot(app, page, 'chat-plan')

    // a long message, and plan lines at their longest (160 characters)
    await say(page, 'Make it for people who think sourdough is hard. '.repeat(6).trim())
    await expect(page.getByTestId('plan-said')).toHaveCount(2)
    const long = 'Mix it by hand, then leave it on the counter for an hour while you do something else entirely, because nothing about this needs you to stand over it.'
    const beat = page.getByTestId('plan-card').getByRole('textbox', { name: 'Beat 2', exact: true })
    await beat.fill(long)
    await beat.press('Enter')
    await shoot(app, page, 'chat-long', [SIZES[0]])
  } finally {
    await app.close()
  }
})
