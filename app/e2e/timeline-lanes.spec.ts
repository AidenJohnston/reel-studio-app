// The timeline's lanes, end to end: pictures above the rail, your video on it (a clip from another video drawn as its
// own kind), sounds under it. Each lane is one named stop in the tab order, its arrows move between items, each item
// is named for what it is, when and why, and a picture opens in Edit it myself.
//
// The reels are made by the fake engine, then given a fixture edit (words, cut, pictures, sounds, a render's
// segments and a video of the same length), so a long reel with many pictures and a multi-source reel can be drawn
// without the real engine. Run after a build, as smoke.spec.ts.
import { test, expect, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BASE, launch, makeMedia, makeReel, passFirstRun, shot, viewMenu } from './helpers'

const MINE = mkdtempSync(join(BASE, 'lanes-'))
const ROOT = join(MINE, 'Documents', 'Reel Studio')
const LEXICON = ['every', 'morning', 'I', 'make', 'coffee', 'first', 'then', 'walk', 'the', 'dog', 'around', 'the', 'park', 'before', 'work', 'starts']
const TREATMENTS: [string, string | null, Record<string, unknown>][] = [
  ['card-above-head', 'Library/Images/cup.png', {}],
  ['side-card', 'Library/Images/dog.png', {}],
  ['text-pop', null, { text: 'before work' }],
  ['phone-card', 'Library/Videos/walk.mp4', {}],
  ['full-frame', 'Library/Images/park.jpg', {}]
]

interface Fixture {
  seconds: number
  pictures: number
  /** a clip of a second video, played whole after the first kept range */
  clip?: boolean
}

// The Library pictures the fixture places, so the timeline has stills to show
const STILLS: [string, string][] = [
  ['cup.png', 'testsrc2=size=320x320'],
  ['dog.png', 'smptebars=size=320x320'],
  ['park.jpg', 'mandelbrot=size=320x320']
]

/** Gives the reel on screen a fixture Version 1: words, a cut, pictures, sounds and a song, and a render of them. */
function seed(slug: string, f: Fixture): void {
  const images = join(ROOT, 'Library', 'Images')
  mkdirSync(images, { recursive: true })
  for (const [name, src] of STILLS)
    if (!existsSync(join(images, name))) execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', src, '-frames:v', '1', join(images, name)])
  const dir = join(ROOT, 'Projects', slug)
  const p = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8'))
  const words = Array.from({ length: Math.floor(f.seconds / 0.45) }, (_, i) => ({ id: `f${i}`, w: LEXICON[i % LEXICON.length], s: i * 0.45, e: i * 0.45 + 0.32, source: 's1' }))
  // kept ranges of 16 words, two cut between each
  const ranges: { from: number; to: number }[] = []
  for (let i = 0; i + 16 <= words.length; i += 18) ranges.push({ from: i, to: i + 15 })
  const keep: unknown[] = ranges.map((r) => ({ from: words[r.from].id, to: words[r.to].id }))
  const segments: { source: string; src_start: number; src_end: number; out_start: number }[] = []
  let out = 0
  const add = (source: string, a: number, b: number) => {
    segments.push({ source, src_start: a, src_end: b, out_start: Math.round(out * 1000) / 1000 })
    out += b - a
  }
  ranges.forEach((r, k) => {
    add('s1', Math.max(0, words[r.from].s - 0.08), words[r.to].e + 0.08)
    if (k === 0 && f.clip) {
      keep.splice(1, 0, { clip: 'c1', source: 's2', in: 2, out: 7 })
      add('s2', 2, 7)
    }
  })
  const duration = Math.round(out * 1000) / 1000
  // pictures spread over the kept ranges, each on four words
  const starts = ranges.flatMap((r) => [r.from + 1, r.from + 9])
  const broll = Array.from({ length: f.pictures }, (_, i) => {
    const w = starts[Math.floor((i * starts.length) / f.pictures)]
    const [treatment, asset, params] = TREATMENTS[i % TREATMENTS.length]
    return { id: `b${i + 1}`, anchor: { from: words[w].id, to: words[w + 3].id }, treatment, asset, params }
  })
  const sfx = [
    { at: { word: words[ranges[0].from + 4].id }, sound: 'whoosh-quick' },
    { at: { word: words[ranges[1].from + 6].id }, sound: 'pop-soft' }
  ]
  const project = {
    ...p,
    sources: f.clip ? [...p.sources, { ...p.sources[0], id: 's2' }] : p.sources,
    cut: { ...p.cut, keep },
    broll,
    sfx,
    music: { enabled: true, track: 'Library/Music/happy song.mp3', startAt: 0, level: 'under-voice', automation: [], fadeIn: 1.2, fadeOut: 2 }
  }
  writeFileSync(join(dir, p.transcript.file), JSON.stringify({ words }))
  writeFileSync(join(dir, 'project.json'), JSON.stringify(project, null, 2))
  const v1 = join(dir, 'versions', 'v1')
  writeFileSync(join(v1, 'project.json'), JSON.stringify(project, null, 2))
  writeFileSync(join(v1, 'render.json'), JSON.stringify({ duration, segmentsDetail: segments }))
  writeFileSync(join(v1, 'receipts.json'), JSON.stringify([{ renderId: 'fixture', facts: broll.map((b) => ({ kind: 'broll', id: b.id, before: null, after: b })) }]))
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `testsrc2=size=270x480:rate=15:duration=${duration}`, '-f', 'lavfi', '-i', `sine=frequency=330:duration=${duration}`, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', join(v1, 'export.mp4')])
}

/** Makes a reel, gives it the fixture, and opens it again so it reads the fixture. */
async function reelWith(page: Page, video: string, f: Fixture): Promise<string> {
  await makeReel(page, video)
  const slug = (await page.locator('.reel-page').getAttribute('data-slug'))!
  seed(slug, f)
  await page.getByTestId('nav-home').click()
  await page.locator(`[data-slug="${slug}"] [data-testid=project-card]`).click()
  await expect(page.getByRole('group', { name: 'Your video on the timeline' })).toBeVisible()
  return slug
}

/** The window, and the timeline up close with room for its tips. */
async function shoot(page: Page, name: string): Promise<void> {
  await shot(page, name)
  const b = (await page.locator('.tl').boundingBox())!
  await page.waitForTimeout(150)
  await page.screenshot({ path: join(__dirname, 'screenshots', `${name}-timeline.png`), clip: { x: Math.max(0, b.x - 24), y: b.y - 96, width: b.width + 48, height: b.height + 132 } })
}

/** A lane's icon sits in the gutter left of time, level with the lane's items. */
async function expectBeside(page: Page, lane: string, item: Locator): Promise<void> {
  const icon = page.getByTestId('lane-gutter').locator(`[title="${lane}"]`)
  await expect(icon).toBeVisible()
  const a = (await icon.boundingBox())!
  const b = (await item.boundingBox())!
  expect(a.x + a.width).toBeLessThanOrEqual(b.x + 0.5)
  expect(Math.abs(a.y + a.height / 2 - (b.y + b.height / 2))).toBeLessThan(8)
}

test('timeline lanes: pictures, your video and sounds, each named and reachable by keyboard', async () => {
  test.setTimeout(20 * 60_000)
  const media = makeMedia()
  const { app, page } = await launch({ REELSTUDIO_ROOT: ROOT, REELSTUDIO_USER_DATA: join(MINE, 'user data'), REELENGINE_CACHE: join(MINE, 'engine-cache') })
  await passFirstRun(page)
  const pictures = page.getByRole('group', { name: 'Pictures on the timeline' }).getByRole('button')
  const video = page.getByRole('group', { name: 'Your video on the timeline' }).getByRole('button')
  const sounds = page.getByRole('group', { name: 'Sound effects on the timeline' }).getByRole('button')
  const slider = page.getByRole('slider', { name: /^Time in your reel/ })

  // ---- a short reel: each lane is one tab stop, in order, and its arrows move along it ----
  await reelWith(page, media.video, { seconds: 24, pictures: 3 })
  await expect(pictures).toHaveCount(3)
  await expect(pictures.first()).toHaveAccessibleName(/^Picture above your head, 0:0\d to 0:0\d, for the line “morning I make coffee”, Added when Version 1 was made$/)
  await expect(pictures.nth(2)).toHaveAccessibleName(/^Words on screen: “before work”, 0:\d\d to 0:\d\d, for the line “.+”/)
  await expect(video.first()).toHaveAccessibleName(/^Your video, 0:00 to 0:0\d: “every morning I make coffee first…”$/)
  await expect(sounds.first()).toHaveAccessibleName(/^Whoosh at 0:0\d, on “\w+”$/)
  await shoot(page, 'lanes-00-short')
  // what each lane holds, before any hover: its icon beside it, a picture's still at its start where the picture is
  // wide enough, a glyph for words on screen, a sound's kind beside its flag
  await expectBeside(page, 'Pictures', pictures.first())
  await expectBeside(page, 'Your video', page.locator('.tl-rail'))
  await expectBeside(page, 'Sound', sounds.first())
  await expect(pictures.first().getByTestId('timeline-thumb').locator('img')).toBeVisible()
  await expect(pictures.nth(2).getByTestId('timeline-thumb')).toBeVisible()
  await expect(pictures.nth(2).getByTestId('timeline-thumb').locator('img')).toHaveCount(0)
  await expect(sounds.first().getByText('Whoosh', { exact: true })).toBeVisible()
  await slider.focus()
  await page.keyboard.press('Tab')
  await expect(pictures.first()).toBeFocused()
  await page.keyboard.press('ArrowRight')
  await expect(pictures.nth(1)).toBeFocused()
  await page.keyboard.press('End')
  await expect(pictures.nth(2)).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(video.first()).toBeFocused()
  await page.keyboard.press('ArrowRight')
  await expect(video.nth(1)).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(sounds.first()).toBeFocused()
  // the song's fades, which a pointer reads by hovering its line, are the next stop
  await page.keyboard.press('Tab')
  await expect(page.getByRole('group', { name: 'Song on the timeline' }).getByRole('button')).toBeFocused()
  await expect(page.getByRole('group', { name: 'Song on the timeline' }).getByRole('button')).toHaveAccessibleName('Song: fades in over 1.2 s, out over 2 s')
  await page.keyboard.press('Shift+Tab')
  await expect(sounds.first()).toBeFocused()
  // back into the pictures: the one last focused keeps the stop
  await page.keyboard.press('Shift+Tab')
  await page.keyboard.press('Shift+Tab')
  await expect(pictures.nth(2)).toBeFocused()
  await shoot(page, 'lanes-01-short-keyboard')
  await page.mouse.move(0, 0)
  await pictures.first().hover()
  await expect(pictures.first()).toContainText('Picture above your head')
  await shoot(page, 'lanes-02-short-hover')

  // a picture opens in Edit it myself, on its row
  await pictures.first().focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('tab', { name: 'Pictures' })).toHaveAttribute('aria-selected', 'true')
  const row = page.getByTestId('picture-row').first()
  await expect(row).toHaveAttribute('aria-current', 'true')
  await expect(pictures.first()).toHaveAttribute('aria-current', 'true')
  await shoot(page, 'lanes-03-short-picture-open')
  // Remove takes it off the timeline, and the lane keeps its tab stop though the picture that held it is gone
  await row.getByRole('button', { name: 'Remove' }).click()
  await expect(pictures).toHaveCount(2)
  await slider.focus()
  await page.keyboard.press('Tab')
  await expect(pictures.first()).toBeFocused()
  await page.getByTestId('drawer-close').click()

  // ---- a long reel with many pictures, at the narrowest window ----
  await page.setViewportSize({ width: 1100, height: 720 })
  await reelWith(page, media.video, { seconds: 200, pictures: 36 })
  await expect(pictures).toHaveCount(36)
  // too short here for stills: every picture is a bar, so none covers its neighbour
  await expect(page.getByTestId('timeline-thumb')).toHaveCount(0)
  // every picture keeps a target of its own: none is covered by its neighbours
  const boxes = await pictures.evaluateAll((els) => els.map((e) => e.getBoundingClientRect()).map((r) => ({ l: r.left, r: r.right })))
  for (let i = 1; i < boxes.length; i++) expect(boxes[i].l).toBeGreaterThanOrEqual(boxes[i - 1].r - 0.5)
  for (const b of boxes) expect(b.r - b.l).toBeGreaterThan(0)
  await slider.focus()
  await page.keyboard.press('Tab')
  for (let i = 0; i < 20; i++) await page.keyboard.press('ArrowRight')
  await expect(pictures.nth(20)).toBeFocused()
  await shoot(page, 'lanes-04-long-narrow-keyboard')
  await page.setViewportSize({ width: 1280, height: 820 })
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.mouse.move(0, 0)
  await shoot(page, 'lanes-05-long')

  // ---- a clip of another video, between two kept ranges ----
  await reelWith(page, media.video, { seconds: 40, pictures: 4, clip: true })
  // five kept ranges, the clip after the first
  await expect(video).toHaveCount(6)
  await expect(video.nth(1)).toHaveAccessibleName('Video 2, played whole, 0:07 to 0:12')
  await expect(page.getByTestId('timeline-clip')).toHaveCount(1)
  const clipBox = (await page.getByTestId('timeline-clip').boundingBox())!
  await page.mouse.move(clipBox.x + clipBox.width / 2, clipBox.y + clipBox.height / 2)
  await expect(page.getByTestId('timeline-part-tip')).toContainText('Video 2, played whole')
  await shoot(page, 'lanes-06-multi-source-hover')

  await app.close()
})

const timelineItem = (app: ElectronApplication) =>
  app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById('show-timeline')?.checked ?? null)
const clickTimelineItem = (app: ElectronApplication) =>
  app.evaluate(({ Menu, BrowserWindow }) => Menu.getApplicationMenu()!.getMenuItemById('show-timeline')!.click({}, BrowserWindow.getAllWindows()[0], undefined))

test('timeline toggle: hiding gives the phone the height, is remembered, and brings the timeline back reachable', async () => {
  test.setTimeout(10 * 60_000)
  const mine = mkdtempSync(join(BASE, 'toggle-'))
  const env = { REELSTUDIO_ROOT: join(mine, 'Documents', 'Reel Studio'), REELSTUDIO_USER_DATA: join(mine, 'user data'), REELENGINE_CACHE: join(mine, 'engine-cache') }
  const media = makeMedia()
  let { app, page } = await launch(env)
  await passFirstRun(page)
  await makeReel(page, media.video)
  // the app is launched twice: these find their element on the page there is now
  const slider = () => page.getByRole('slider', { name: /^Time in your reel/ })
  // the timeline's switch is in the View menu under the phone; its button says when the timeline is hidden
  const view = () => page.getByTestId('view-menu')
  const height = async () => (await page.getByTestId('player').boundingBox())!.height
  await expect(slider()).toBeVisible()
  await expect(view()).not.toHaveAttribute('aria-label', /timeline hidden/)
  expect(await timelineItem(app)).toBe(true)
  const tall = await height()

  // View › Show Timeline, with focus on the timeline: it goes, the phone grows, and focus waits on the View button
  await slider().focus()
  await clickTimelineItem(app)
  await expect(slider()).toHaveCount(0)
  await expect(view()).toHaveAttribute('aria-label', /timeline hidden$/)
  await expect(view()).toBeFocused()
  await expect.poll(height).toBeGreaterThan(tall + 40)
  // Edit it myself works without it
  await page.getByTestId('edit-myself').click()
  await page.getByRole('tab', { name: 'Pictures' }).click()
  await expect(page.getByTestId('drawer')).toBeVisible()
  await page.getByTestId('drawer-close').click()
  await app.close()

  // remembered on this computer
  ;({ app, page } = await launch(env))
  await page.locator('[data-testid=project-card]').first().click()
  await expect(page.getByTestId('play')).toBeVisible()
  await expect(slider()).toHaveCount(0)
  expect(await timelineItem(app)).toBe(false)
  await shot(page, 'lanes-07-timeline-hidden')

  // the Reel screen's View menu brings it back, and the app menu follows; the keyboard reaches it from the play button
  await viewMenu(page, 'timeline-toggle')
  await expect(slider()).toBeVisible()
  expect(await timelineItem(app)).toBe(true)
  await page.getByTestId('play').focus()
  await page.keyboard.press('Shift+Tab')
  await expect(page.getByTestId('timeline-part').last()).toBeFocused()
  await app.close()
})
