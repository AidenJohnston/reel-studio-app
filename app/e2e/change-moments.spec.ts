import { test, expect, type Page } from '@playwright/test'
import { launch, makeMedia, makeReel, passFirstRun, shot } from './helpers'

// A note's change shows on the phone before its draft (ChangeMoments.tsx): each still the engine's `moments` draws, then
// the 2 s around the first, then the draft as the Quick preview, then the version. The practice editor runs the
// stand-in engine's `moments` for a note that changes the picture (ai-mock.ts slowNote) and none for a music note.
// The stand-in draws stills at 0.8, 2.4 and 4.0 s and the window 0:00 to 0:02, FAKE_ENGINE_MOMENTS_GAP apart.
const ENV = { REELSTUDIO_MOCK_CLAUDE: 'ready', REELSTUDIO_MOCK_NOTE: '2500', REELSTUDIO_MOCK_MOMENTS: '1' }

/** Every distinct state of the phone, as `tag|top picture|dots|preview tag`, sampled every 30 ms from now on. */
async function record(page: Page): Promise<() => Promise<string[]>> {
  await page.evaluate(() => {
    const w = window as unknown as { __seen: string[] }
    w.__seen = []
    let last = ''
    window.setInterval(() => {
      const tag = document.querySelector('[data-testid=change-tag] .change-label')?.textContent ?? ''
      const top = document.querySelector('[data-testid=change-picture]')?.lastElementChild?.getAttribute('data-testid') ?? ''
      const dots = document.querySelectorAll('[data-testid=change-dot]').length
      const preview = document.querySelector('[data-testid=change-preview]')?.textContent ?? ''
      const s = `${tag}|${top}|${dots}|${preview}`
      if (s !== last) w.__seen.push((last = s))
    }, 30)
  })
  return () => page.evaluate(() => (window as unknown as { __seen: string[] }).__seen)
}

async function note(page: Page, text: string): Promise<void> {
  await page.getByTestId('note-input').fill(text)
  await page.getByTestId('send').click()
}

test('fails if a change\'s stills, its moment and its draft do not reach the phone in the order they were made', async () => {
  const media = makeMedia()
  const { app, page } = await launch({ ...ENV, FAKE_ENGINE_MOMENTS_GAP: '0.9' })
  try {
    await passFirstRun(page)
    await makeReel(page, media.video)
    const player = page.getByTestId('player')
    const seen = await record(page)
    await note(page, 'make the subtitles bigger')
    const label = page.getByTestId('change-tag').locator('.change-label')
    await expect(label).toHaveText('Your change · 0:01', { timeout: 60_000 })
    // the reel stops under the change, so its sound does not go on behind a still
    await expect.poll(() => player.evaluate((v: HTMLVideoElement) => v.paused)).toBe(true)
    await shot(page, 'change-1-first-still')
    await expect(page.getByTestId('change-dot')).toHaveCount(3)
    await expect(label).toHaveText('Your change · 0:04')
    await shot(page, 'change-2-third-still')
    await expect(label).toHaveText('Your change · 0:00–0:02')
    await shot(page, 'change-3-moment-playing')
    await expect(page.getByTestId('change-preview')).toHaveText('Quick preview', { timeout: 60_000 })
    await expect(page.getByTestId('change-tag')).toHaveCount(0)
    await shot(page, 'change-4-quick-preview')
    await expect(page.getByTestId('log-play-2')).toBeVisible({ timeout: 120_000 })
    await shot(page, 'change-5-version')

    const states = await seen()
    const tags = states.map((s) => s.split('|')[0]).filter((t, i, a) => t && t !== a[i - 1])
    expect(tags).toEqual(['Your change · 0:01', 'Your change · 0:02', 'Your change · 0:04', 'Your change · 0:00–0:02'])
    // the moment is the window playing, and the Quick preview comes only after it, with the pictures gone
    expect(states.find((s) => s.startsWith('Your change · 0:00–0:02'))).toContain('|change-window|')
    const playing = states.findIndex((s) => s.startsWith('Your change · 0:00–0:02'))
    const quick = states.findIndex((s) => s.endsWith('|Quick preview'))
    expect(quick).toBeGreaterThan(playing)
    expect(states[quick]).toBe('||0|Quick preview')
  } finally {
    await app.close()
  }
})

test('fails if Stop while the stills arrive leaves them on the phone or lets a later one in', async () => {
  const media = makeMedia()
  const { app, page } = await launch({ ...ENV, FAKE_ENGINE_MOMENTS_GAP: '2' })
  try {
    await passFirstRun(page)
    await makeReel(page, media.video)
    const v1 = await page.getByTestId('player').getAttribute('src')
    await note(page, 'make the subtitles bigger')
    const label = page.getByTestId('change-tag').locator('.change-label')
    await expect(label).toHaveText('Your change · 0:01', { timeout: 60_000 })
    await shot(page, 'change-6-before-stop')
    await page.getByTestId('stop').click()
    await expect(page.getByTestId('change-picture')).toHaveCount(0)
    await expect(page.getByTestId('change-tag')).toHaveCount(0)
    await expect(page.getByTestId('note-progress')).toHaveCount(0)
    await expect(page.getByTestId('player')).toHaveAttribute('src', v1!)
    const seen = await record(page)
    // the stand-in would have drawn the next still 2 s after the first
    await page.waitForTimeout(3000)
    expect((await seen()).filter((s) => s.startsWith('Your change'))).toEqual([])
    await expect(page.getByTestId('log-play-2')).toHaveCount(0)
    await shot(page, 'change-7-after-stop')
  } finally {
    await app.close()
  }
})

test('fails if a note that changes nothing on screen shows pictures of a change', async () => {
  const media = makeMedia()
  const { app, page } = await launch(ENV)
  try {
    await passFirstRun(page)
    await makeReel(page, media.video)
    const seen = await record(page)
    await note(page, 'make the music quieter')
    await expect(page.getByTestId('log-play-2')).toBeVisible({ timeout: 120_000 })
    expect((await seen()).filter((s) => s.startsWith('Your change'))).toEqual([])
    await shot(page, 'change-8-music-note')
  } finally {
    await app.close()
  }
})
