// The editing timeline in Edit it myself, end to end: a labelled lane each for your video, the pictures, the subtitles,
// the song and the sounds; each drag on it is one change, made into the next version, on word ids (a cut's edge on a
// word, a picture's anchor on its words), so project.json says exactly what the AI would have written.
//
// The reel is the fixture of lanes-fixture.ts, made by the fake engine. Run after a build, as smoke.spec.ts.
import { test, expect, type Locator, type Page } from '@playwright/test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { BASE, launch, makeMedia, passFirstRun, shot } from './helpers'
import { reelWith } from './lanes-fixture'

const MINE = mkdtempSync(join(BASE, 'track-'))
const ROOT = join(MINE, 'Documents', 'Reel Studio')

/** Presses `el` at its own spot (`at`: 0 left edge, 1 right edge, of its box), moves `dx` px and lets go. */
async function dragBy(page: Page, el: Locator, dx: number, { at = 0.5, dy = 0, before }: { at?: number; dy?: number; before?: () => Promise<void> } = {}): Promise<void> {
  const b = (await el.boundingBox())!
  const x = b.x + b.width * at
  const y = b.y + b.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  for (let i = 1; i <= 8; i++) await page.mouse.move(x + (dx * i) / 8, y + (dy * i) / 8)
  await before?.()
  await page.mouse.up()
}

const index = (id: string): number => Number(id.slice(1))

test('editing timeline: trim a cut, move, resize, frame and delete a picture, move the song, fix a subtitle', async () => {
  test.setTimeout(20 * 60_000)
  const media = makeMedia()
  const { app, page } = await launch({ REELSTUDIO_ROOT: ROOT, REELSTUDIO_USER_DATA: join(MINE, 'user data'), REELENGINE_CACHE: join(MINE, 'engine-cache') })
  await passFirstRun(page)
  const slug = await reelWith(page, ROOT, media.video, { seconds: 24, pictures: 3 })
  const project = () => JSON.parse(readFileSync(join(ROOT, 'Projects', slug, 'project.json'), 'utf8'))
  // the version the fixture shows; each gesture makes the next one
  let version = Number(project().version)
  /** The gesture's own version: made, and on screen while Edit it myself stays open (its log is behind the panel). */
  const made = async () => {
    version++
    await expect(page.getByTestId('version-on-screen')).toHaveText(`Version ${version}`, { timeout: 5 * 60_000 })
    await expect.poll(() => project().version).toBe(version)
  }

  await page.getByTestId('edit-myself').click()
  const track = page.getByTestId('track-timeline')
  await expect(track).toBeVisible()
  // every lane says what it is, in words
  for (const lane of ['Your video', 'Pictures', 'Subtitles', 'Song', 'Sounds']) await expect(track.locator('.trk-labels')).toContainText(lane)
  const parts = page.getByTestId('track-part')
  const pictures = page.getByTestId('track-picture')
  await expect(parts).toHaveCount(3)
  await expect(page.getByTestId('track-cut')).toHaveCount(2)
  await expect(pictures).toHaveCount(3)
  await expect(page.getByTestId('track-caption').first()).toHaveText('every morning I')
  await expect(page.getByTestId('track-song')).toContainText('happy song · from 0:00.0')
  await expect(page.getByTestId('track-sound')).toHaveCount(2)
  // the stills of your video along its lane
  await expect.poll(() => page.getByTestId('track-film').evaluate((c: HTMLCanvasElement) => c.width)).toBeGreaterThan(0)
  await shot(page, 'track-00-lanes')

  // ---- zoom spreads the lanes out, and Fit brings the whole reel back ----
  const wide = (await track.locator('.trk-content').boundingBox())!.width
  await page.getByTestId('track-zoom-in').click()
  await page.getByTestId('track-zoom-in').click()
  await expect.poll(async () => (await track.locator('.trk-content').boundingBox())!.width).toBeGreaterThan(wide * 2)
  await shot(page, 'track-04-zoomed')
  await page.getByTestId('track-fit').click()
  await expect.poll(async () => (await track.locator('.trk-content').boundingBox())!.width).toBeLessThan(wide + 2)
  // fails if the Zoom slider's arrows reach the timeline's own keys: with a picture picked they nudged it into a new
  // version (prep-for-prod round 1, blocking 2). The slider zooms, and the picture stays where it is.
  await pictures.first().click()
  await expect(page.getByTestId('track-picked')).toBeVisible()
  await track.getByRole('slider', { name: 'Zoom' }).focus()
  await page.keyboard.press('ArrowRight')
  await expect.poll(async () => (await track.locator('.trk-content').boundingBox())!.width).toBeGreaterThan(wide + 2)
  // a nudge shows the picture moving at once (the lanes are .dragging until it is sent)
  await expect(track.locator('.trk-content')).not.toHaveClass(/\bdragging\b/)
  await page.getByTestId('track-fit').click()
  await page.keyboard.press('Escape')

  // ---- the first cut's end, dragged back over its last word: that word is cut, and nothing else ----
  const before = project()
  const wordPx = (await parts.first().boundingBox())!.width / 16
  // as a person does: back a little at a time until the tip names one word
  const edge = (await parts.first().getByTestId('track-trim-end').boundingBox())!
  const [ex, ey] = [edge.x + edge.width / 2, edge.y + edge.height / 2]
  await page.mouse.move(ex, ey)
  await page.mouse.down()
  const tip = page.getByTestId('track-tip')
  const tipText = async () => ((await tip.count()) ? ((await tip.textContent()) ?? '') : '')
  for (let dx = 4; dx < wordPx * 3 && !/^Cut “/.test(await tipText()); dx += 2) await page.mouse.move(ex - dx, ey)
  await expect(tip).toHaveText('Cut “starts”')
  await shot(page, 'track-01-trimming')
  await page.mouse.up()
  await made()
  const trimmed = project()
  expect(trimmed.cut.keep[0]).toEqual({ ...before.cut.keep[0], to: 'f14' })
  expect(trimmed.cut.keep.slice(1)).toEqual(before.cut.keep.slice(1))
  expect(trimmed.broll).toEqual(before.broll)

  // ---- a picture moved along: on other words, as many of them ----
  const side = pictures.nth(1)
  await expect(side).toHaveAccessibleName(/^Picture beside you/)
  await dragBy(page, side, wordPx * 3)
  await made()
  const moved = project().broll.find((b: { id: string }) => b.id === 'b2')
  expect(index(moved.anchor.from)).toBeGreaterThan(19)
  expect(index(moved.anchor.to) - index(moved.anchor.from)).toBe(3)

  // ---- the first picture's end, dragged on: it covers more words, from the same first one ----
  await dragBy(page, pictures.first().getByTestId('track-picture-end'), wordPx * 4, { at: 0.5 })
  await made()
  const longer = project().broll.find((b: { id: string }) => b.id === 'b1')
  expect(longer.anchor.from).toBe('f1')
  expect(index(longer.anchor.to)).toBeGreaterThan(4)

  // ---- picked, it gets its frame on the reel: the corner makes the card bigger ----
  await pictures.first().click()
  await expect(pictures.first()).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('track-picked')).toContainText('Picture above your head')
  const corner = page.getByTestId('framing-corner')
  await expect(corner).toBeVisible()
  await shot(page, 'track-02-picked-framing')
  await dragBy(page, corner, 40, { dy: 40 })
  await made()
  expect(project().broll.find((b: { id: string }) => b.id === 'b1').params.scale).toBeGreaterThan(1)

  // ---- the song dragged left: it starts further in ----
  await dragBy(page, page.getByTestId('track-song'), -wordPx * 7, {
    before: async () => {
      await expect(page.getByTestId('track-tip')).toHaveText(/^Song from 0:0\d\.\d$/)
    }
  })
  await made()
  expect(project().music.startAt).toBeGreaterThan(1.5)
  await expect(page.getByTestId('track-song')).toContainText(/from 0:0[2-9]\.\d/)

  // ---- a subtitle line clicked and typed over: the one word fixed, on its word ----
  await page.getByTestId('track-caption').first().click()
  const input = page.getByTestId('track-caption-input')
  await expect(input).toBeFocused()
  await input.fill('every morning eye')
  await shot(page, 'track-03-subtitle')
  await page.keyboard.press('Enter')
  // the keyboard is back on the line it fixed, not lost to the page (prep-for-prod round 1, blocking 7)
  await expect(page.getByTestId('track-caption').first()).toBeFocused()
  await made()
  expect(project().captions.corrections).toEqual([{ from: 'I', to: 'eye', at: 'f2' }])
  await expect(page.getByTestId('track-caption').first()).toHaveText('every morning eye')

  // ---- a picked picture is deleted with the Delete key ----
  await pictures.nth(1).click()
  await expect(page.getByTestId('track-picked')).toContainText('Picture beside you')
  await page.keyboard.press('Delete')
  await made()
  expect(project().broll.map((b: { id: string }) => b.id)).toEqual(['b1', 'b3'])
  // gone from the timeline too (the fake engine's later versions play the take straight, so only pictures on its
  // first seconds are on their clock)
  await expect(page.locator('[data-testid=track-picture][data-id=b2]')).toHaveCount(0)
  await expect(page.locator('[data-testid=track-picture][data-id=b1]')).toBeVisible()

  // ---- Undo acts where the keyboard is: from the timeline, never the panel's own change; from the panel, the panel's.
  // fails if Cmd/Ctrl+Z on the timeline takes back a word cut in the Cut tab, or gives no answer (Fable check 1, #1)
  const undo = process.platform === 'darwin' ? 'Meta+Z' : 'Control+Z'
  await page.getByTestId('tab-cut').click()
  await page.locator('.word').first().click()
  await expect(page.getByTestId('drawer-undo')).toBeVisible()
  await track.focus()
  await page.keyboard.press(undo)
  // the Delete above ran at once, so it is a version now: the timeline says where to go back from
  await expect(page.getByTestId('toast')).toContainText('That change is already a version.')
  await expect(page.getByTestId('drawer-undo')).toBeVisible()
  await page.locator('.edit-h h2').click()
  await page.keyboard.press(undo)
  await expect(page.getByTestId('drawer-undo')).toHaveCount(0)

  // ---- keys: L plays, K stops; Home on the ruler goes to the start ----
  // from the page itself, as after clicking the reel
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  const play = page.locator('.transport .pp')
  await page.keyboard.press('l')
  await expect(play).toHaveAttribute('aria-label', 'Pause')
  await page.keyboard.press('k')
  await expect(play).toHaveAttribute('aria-label', 'Play')
  const ruler = page.getByRole('slider', { name: 'Time in your reel' })
  await ruler.focus()
  await page.keyboard.press('Home')
  await expect(ruler).toHaveAttribute('aria-valuenow', '0')

  await app.close()
})
