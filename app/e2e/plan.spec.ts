// A reel with no video is planned in its notes column: a chat with the editor (the practice editor here,
// REELSTUDIO_MOCK_NOTE) that asks two questions and proposes the plan, which stands on the stage beside the drop zone.
// With no editor the column asks to connect one first. The plan goes to the first edit when the video arrives.
import { test, expect, type Page } from '@playwright/test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { BASE, chooseClaudeCode, expectOneCheckbox, launch, makeMedia, passFirstRun } from './helpers'

function freshProfile(name: string): Record<string, string> {
  const dir = mkdtempSync(join(BASE, `plan-${name}-`))
  return { REELSTUDIO_USER_DATA: join(dir, 'user data'), REELSTUDIO_ROOT: join(dir, 'Reel Studio'), REELSTUDIO_PHONE_HOST: '127.0.0.1' }
}

const slugOf = (page: Page) => page.locator('.reel-page').getAttribute('data-slug') as Promise<string>
const planOf = (page: Page, slug: string) => page.evaluate((s) => window.reel.projects.get(s).then((d) => d.plan), slug)

async function say(page: Page, text: string): Promise<void> {
  await page.getByTestId('note-input').fill(text)
  await page.keyboard.press('Enter')
}

test('plan a reel with the editor, edit a beat, then film it', async () => {
  const media = makeMedia()
  const { app, page } = await launch({ ...freshProfile('editor'), REELSTUDIO_MOCK_NOTE: '1500' })
  await passFirstRun(page)
  await page.getByTestId('new-reel').click()
  await expect(page.getByRole('heading', { name: 'Plan with your editor' })).toBeVisible()
  await expect(page.getByTestId('plan-empty')).toBeVisible()
  await expect(page.getByTestId('plan-who')).toHaveAttribute('title', 'Practice editor (test)')
  const slug = await slugOf(page)

  // the call can be stopped; its words wait to be sent again and are not read as said
  await say(page, 'How I make sourdough without a mixer')
  const strip = page.getByTestId('note-progress')
  await expect(strip).toContainText('Planning your reel')
  await expect(page.getByTestId('plan-answering')).toBeVisible()
  await strip.getByRole('button', { name: 'Stop' }).click()
  await expect(page.getByTestId('log-stopped')).toBeVisible()
  await page.getByTestId('log-retry').click()

  // the honest wait from round 9.1 shows in place of the step, then the first question
  await expect(strip).toContainText('Waiting for your editor to answer')
  await expect(strip.getByTestId('steps')).toHaveCount(0)
  await expect(page.getByTestId('plan-question')).toHaveText('Who is it for?')
  // the box asks for the answer to the editor's question (10-28 audit, finding 9)
  await expect(page.getByTestId('note-input')).toHaveAttribute('placeholder', 'Answer, or tell your editor more…')
  await say(page, 'People who have never baked bread')
  // while the editor answers, words can be written but not sent, and nothing turns red (finding 8)
  await expect(page.getByTestId('note-input')).toHaveAttribute('placeholder', 'Your editor is answering…')
  await page.getByTestId('note-input').fill('and busy parents')
  await expect(page.getByTestId('send')).toBeDisabled()
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('change-alert')).toHaveCount(0)
  await expect(page.getByTestId('plan-question').nth(1)).toHaveText("What's the one thing they should take away?")
  await expect(page.getByTestId('note-input')).toHaveValue('and busy parents')
  await expect(page.getByTestId('send')).toBeEnabled()
  await page.getByTestId('note-input').fill('')
  await say(page, 'You do not need fancy gear')

  // two questions, then the plan: hooks to pick from, 3-6 beats, the shots, on the stage beside the drop zone; the
  // chat says how big it is and brings focus to it
  const card = page.getByTestId('plan-card')
  await expect(page.getByTestId('planned-stage').getByTestId('plan-card')).toBeVisible()
  await expect(page.getByTestId('plan-chip')).toHaveAccessibleName('Show the plan 5 beats, 3 shots')
  // the planning chat names itself for screen readers, not as the notes it becomes once the video is in
  await expect(page.getByRole('log', { name: 'Plan with your editor' })).toBeVisible()
  await page.getByTestId('plan-chip').click()
  await expect(card.locator('[data-plan-head]')).toBeFocused()
  await expect(page.getByTestId('plan-said')).toHaveCount(1)
  await expect(card.getByRole('radio')).toHaveCount(3)
  await expect(card.getByLabel(/^Beat \d$/)).toHaveCount(5)
  await expect(card.getByLabel(/^Shot \d$/)).toHaveCount(3)
  await expect(page.getByTestId('title')).toHaveText('Sourdough without a mixer')

  // asking for a change in the chat gives the plan again: still one card
  await say(page, 'Make the hook punchier')
  await expect(page.getByTestId('plan-said')).toHaveCount(2)
  await expect(page.getByTestId('plan-said').last()).toHaveText('I made that change.')
  await expect(card).toHaveCount(1)

  // edit one beat in place, pick the second hook, tick a shot
  const beat = card.getByRole('textbox', { name: 'Beat 2', exact: true })
  await beat.fill('Mix it by hand, then let it rest an hour.')
  await beat.press('Enter')
  await card.getByTestId('plan-hook-1').check()
  // fails if a shot's tick is not the app's one checkbox (it was a circle, which reads as pick-one), or the keyboard
  // can't tick it and hear that it is
  const tick = card.getByRole('checkbox', { name: 'Shot 1 done' })
  const box = card.locator('.pl-tick:has([data-testid=plan-shots-tick-0]) > span')
  await expectOneCheckbox(box, false)
  await tick.focus()
  await page.keyboard.press('Space')
  await expect(card.getByRole('checkbox', { name: 'Shot 1 done', checked: true })).toHaveCount(1)
  await expectOneCheckbox(box, true)
  await expect.poll(async () => (await planOf(page, slug))?.beats[1]).toEqual({ text: 'Mix it by hand, then let it rest an hour.' })
  await expect.poll(async () => (await planOf(page, slug))?.hook).toBe(1)
  await expect.poll(async () => (await planOf(page, slug))?.shots[0].done).toBe(true)
  // Escape puts a line back as it was
  await beat.fill('something else')
  await beat.press('Escape')
  await expect(beat).toHaveValue('Mix it by hand, then let it rest an hour.')

  // Copy and Send to my phone carry the plan as it now reads
  await card.getByTestId('plan-copy').click()
  await expect(page.getByTestId('toast')).toContainText('Copied.')
  const copied = await app.evaluate(({ clipboard }) => clipboard.readText())
  expect(copied).toContain('Hook: I kneaded bread by hand for a year before I learned this.')
  expect(copied).toContain('2. Mix it by hand, then let it rest an hour.')
  await card.getByTestId('plan-phone').click()
  const url = await page.getByTestId('phone-qr').getAttribute('data-url')
  const phonePage = await (await fetch(url!)).text()
  expect(phonePage).toContain('Mix it by hand, then let it rest an hour.')
  expect(phonePage).toContain('I kneaded bread by hand for a year before I learned this.')
  await expect(page.getByTestId('plan-phone-status')).toContainText('Sent. Check your phone.')
  await page.getByTestId('plan-phone-done').click()
  await expect(page.getByTestId('plan-phone-panel')).toHaveCount(0)
  await expect(card.getByTestId('plan-phone')).toBeFocused()

  // the video: the first edit reads the plan, with the picked hook and the edited beat
  await page.getByTestId('planned-stage').getByTestId('file-input').setInputFiles([media.video])
  await expect(page.getByTestId('log-play-1')).toBeVisible({ timeout: 240_000 })
  const dir = await page.evaluate((s) => window.reel.projects.get(s).then((d) => d.dir), slug)
  const script = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')).script
  expect(script).toEqual({
    hook: 'I kneaded bread by hand for a year before I learned this.',
    script: 'Flour, water, salt. Nothing else goes in.\nMix it by hand, then let it rest an hour.\nFold it four times, an hour apart.\nIt sleeps in the fridge overnight.\nBake it hot in a closed pot. No mixer, ever.',
    shots: ['You at the kitchen counter, chest up, by the window', 'Your hands folding the dough, close up', 'The loaf coming out of the pot']
  })

  // the plan folds into one line above the video, and opens read-only
  await expect(page.getByRole('heading', { name: 'Notes for your editor' })).toBeVisible()
  await expect(page.getByRole('log', { name: 'Notes for your editor' })).toBeVisible()
  await expect(card).toHaveAttribute('data-folded')
  await expect(page.getByTestId('plan-question')).toHaveCount(0)
  await card.getByTestId('plan-unfold').click()
  await expect(card.getByRole('textbox', { name: 'Beat 2', exact: true })).toHaveAttribute('readonly', '')
  await expect(card.getByTestId('plan-copy')).toBeVisible()
  await app.close()
})

// fails if a video dropped while the editor is answering names the reel after the file though no video went in (the
// title was written before the first edit was refused), or the refusal doesn't say why
test('a video dropped while the editor is answering is refused, and the reel keeps its name', async () => {
  const media = makeMedia()
  const { app, page } = await launch({ ...freshProfile('busy'), REELSTUDIO_MOCK_NOTE: '4000' })
  await passFirstRun(page)
  await page.getByTestId('new-reel').click()
  const slug = await slugOf(page)
  const dir = await page.evaluate((s) => window.reel.projects.get(s).then((d) => d.dir), slug)
  const names = () => {
    const s = JSON.parse(readFileSync(join(dir, 'app.json'), 'utf8'))
    return { title: s.title, fileTitle: s.fileTitle }
  }
  await say(page, 'How I make sourdough without a mixer')
  await expect(page.getByTestId('plan-answering')).toBeVisible()
  const before = names()

  await page.getByTestId('planned-stage').getByTestId('file-input').setInputFiles([media.video])
  await expect(page.getByTestId('toast')).toContainText('Your editor is still answering. Drop the video again in a moment, or press Stop.')
  expect(names()).toEqual(before)
  await expect(page.getByTestId('planned-stage')).toBeVisible()

  // the editor's answer lands on the reel as it was
  await expect(page.getByTestId('plan-question')).toHaveText('Who is it for?')
  expect(names()).toEqual(before)
  expect((await page.evaluate((s) => window.reel.projects.get(s), slug)).status).toBe('planned')
  await app.close()
})

// fails if the plan panel offers a form or a chat no one would answer, if Connect your editor loses this New reel (an
// untouched one is removed when its screen closes, and Choose your editor closed it), or if coming back connected
// needs another click before typing
test('with no editor, planning asks to connect it first; connected, the chat on the same reel is ready to type in', async () => {
  const { app, page } = await launch({ ...freshProfile('connect'), REELSTUDIO_MOCK_CLAUDE: 'ready' })
  await passFirstRun(page)
  await page.getByTestId('new-reel').click()
  await expect(page.getByRole('heading', { name: 'Plan with your editor' })).toBeVisible()
  const slug = await slugOf(page)
  const step = page.getByTestId('plan-connect-step')
  await expect(step).toContainText('Your editor plans it with you')
  await expect(step.getByRole('button')).toHaveText(['Connect your editor'])
  await expect(page.getByTestId('note-input')).toHaveCount(0)
  await expect(page.getByTestId('plan-who')).toHaveCount(0)

  await step.getByRole('button', { name: 'Connect your editor' }).click()
  await expect(page.getByTestId('connect-screen')).toBeVisible()
  expect(await chooseClaudeCode(page)).toBe(true)

  await expect(page.locator('.reel-page')).toHaveAttribute('data-slug', slug)
  await expect(page.getByTestId('note-input')).toBeFocused()
  await expect(page.getByTestId('note-input')).toHaveAttribute('placeholder', "What's this reel about?")
  await expect(page.getByTestId('plan-greeting')).toContainText('Not filmed yet?')
  await expect(page.getByTestId('plan-who')).toHaveAttribute('title', 'Claude (your Claude Code app), the model it picks')
  await expect(page.getByTestId('plan-connect-step')).toHaveCount(0)
  await app.close()
})
