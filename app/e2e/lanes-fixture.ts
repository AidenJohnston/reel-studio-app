// A fixture reel for the timeline specs (timeline-lanes, timeline-edit): the fake engine makes the reel, then it is
// given a fixture Version 1 (words, a cut, pictures, sounds, a song, subtitle lines, a render's segments and a video
// of the same length), so the timeline has a long reel, many pictures or a clip from another video to draw without
// the real engine.
import { expect, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeReel } from './helpers'

const LEXICON = ['every', 'morning', 'I', 'make', 'coffee', 'first', 'then', 'walk', 'the', 'dog', 'around', 'the', 'park', 'before', 'work', 'starts']
const TREATMENTS: [string, string | null, Record<string, unknown>][] = [
  ['card-above-head', 'Library/Images/cup.png', {}],
  ['side-card', 'Library/Images/dog.png', {}],
  ['text-pop', null, { text: 'before work' }],
  ['phone-card', 'Library/Videos/walk.mp4', {}],
  ['full-frame', 'Library/Images/park.jpg', {}]
]

export interface Fixture {
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
function seed(root: string, slug: string, f: Fixture): void {
  const images = join(root, 'Library', 'Images')
  mkdirSync(images, { recursive: true })
  for (const [name, src] of STILLS)
    if (!existsSync(join(images, name))) execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', src, '-frames:v', '1', join(images, name)])
  const dir = join(root, 'Projects', slug)
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
  // the subtitle lines the render drew: the kept words, three to a line
  const shown = ranges.flatMap((r) => words.slice(r.from, r.to + 1))
  const cues = Array.from({ length: Math.ceil(shown.length / 3) }, (_, i) => ({ run: 0, tokens: shown.slice(i * 3, i * 3 + 3).map((w) => ({ w: w.w, ids: [w.id] })) }))
  writeFileSync(join(v1, 'captions.json'), JSON.stringify({ cues }))
  writeFileSync(join(v1, 'receipts.json'), JSON.stringify([{ renderId: 'fixture', facts: broll.map((b) => ({ kind: 'broll', id: b.id, before: null, after: b })) }]))
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `testsrc2=size=270x480:rate=15:duration=${duration}`, '-f', 'lavfi', '-i', `sine=frequency=330:duration=${duration}`, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', join(v1, 'export.mp4')])
}

/** Makes a reel, gives it the fixture, and opens it again so it reads the fixture. */
export async function reelWith(page: Page, root: string, video: string, f: Fixture): Promise<string> {
  await makeReel(page, video)
  const slug = (await page.locator('.reel-page').getAttribute('data-slug'))!
  seed(root, slug, f)
  await page.getByTestId('nav-home').click()
  await page.locator(`[data-slug="${slug}"] [data-testid=project-card]`).click()
  await expect(page.getByRole('group', { name: 'Your video on the timeline' })).toBeVisible()
  return slug
}

/** The window, and the timeline up close with room for its tips. */
