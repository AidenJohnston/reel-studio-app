// How long a person waits in the app itself: launch, opening a reel, switching versions, scrubbing, sending a note.
// Report only (README.md): it records numbers and fails only when a moment never happens.
//
// Every end time is Chromium's own: Element Timing's renderTime for the elements src/shared/perf-marks.ts names,
// and requestVideoFrameCallback's expectedDisplayTime for a scrubbed frame. Every start is the timeStamp of the
// input event that began it. Both are on the page's clock, so test-side polling never enters a number.
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { cpus, release, totalmem } from 'node:os'
import { dirname, join } from 'node:path'
import { APP_DIR, launch, makeMedia, passFirstRun } from '../e2e/helpers'
import { HOME_REEL, NOTE_STATUS, WINDOW_SHOWN } from '../src/shared/perf-marks'
import { machineLoad, stats, waitForQuiet, type Load } from './measure'

const RUNS = Number(process.env.REELSTUDIO_PERF_RUNS || 5)
const PLAYER = 'video[data-testid="player"]'
// Always the mock AI, even when REELSTUDIO_E2E_AI asks e2e for the real package. Its ChatGPT editor is connected for
// the note and holds each note 1.5 s, as a real model takes seconds.
const MOCK = { REELSTUDIO_MOCK_AI: '1' }
const ENV = { ...MOCK, REELSTUDIO_MOCK_CODEX: 'ready', REELSTUDIO_MOCK_NOTE_MS: '1500' }
// Fractions of the scrub bar, clicked in this order. A seek's cost depends on where it lands (how far past a keyframe),
// and the first one after opening also loads the data, so each position is reported on its own, never pooled.
const SCRUB_AT = [0.2, 0.7, 0.4, 0.9, 0.55]

interface Paint {
  id: string
  renderTime: number
  loadTime: number
  url: string
  el: Element | null
}
interface Rec {
  paints: Paint[]
  marks: Record<string, { ts: number; value: string }>
  pending: { name: string; type: string } | null
  frames: { mediaTime: number; shown: number }[]
}
declare global {
  interface Window {
    __rsPerf: Rec
  }
}

/** Installed in the page right after launch. Element Timing entries are buffered, so launch's are still there. */
function recorder(): void {
  if (window.__rsPerf) return
  const rec: Rec = { paints: [], marks: {}, pending: null, frames: [] }
  window.__rsPerf = rec
  type ElementTiming = PerformanceEntry & { identifier: string; renderTime: number; loadTime: number; url: string; element: Element | null }
  new PerformanceObserver((list) => {
    for (const e of list.getEntries() as ElementTiming[])
      rec.paints.push({ id: e.identifier, renderTime: e.renderTime, loadTime: e.loadTime, url: e.url, el: e.element })
  }).observe({ type: 'element', buffered: true })
  for (const type of ['click', 'keydown', 'input'])
    document.addEventListener(
      type,
      (e) => {
        const p = rec.pending
        if (!p || p.type !== e.type || (e instanceof KeyboardEvent && e.key !== 'Enter')) return
        rec.marks[p.name] = { ts: e.timeStamp, value: String((e.target as HTMLInputElement).value ?? '') }
        rec.pending = null
      },
      true
    )
}

/** The next `type` event (keydown: Enter only) starts the moment `name`. */
async function arm(page: Page, name: string, type: 'click' | 'keydown' | 'input'): Promise<void> {
  await page.evaluate(([n, t]) => void (window.__rsPerf.pending = { name: n, type: t }), [name, type] as const)
}

/** ms from moment `mark`'s event to the first paint of `id` after it, on the element `selector` finds when given. */
async function paintAfter(page: Page, mark: string, id: string, selector: string | null = null): Promise<{ ms: number; url: string }> {
  try {
    const h = await page.waitForFunction(
      ([m, i, sel]) => {
        const rec = window.__rsPerf
        const start = rec.marks[m]?.ts
        if (start === undefined) return null
        const el = sel ? document.querySelector(sel) : null
        const p = rec.paints.find((x) => x.id === i && x.renderTime > start && (!sel || x.el === el))
        return p ? { ms: p.renderTime - start, url: p.url } : null
      },
      [mark, id, selector] as const,
      { timeout: 60_000, polling: 100 }
    )
    return (await h.jsonValue())!
  } catch (e) {
    const seen = await page.evaluate((i) => window.__rsPerf.paints.filter((x) => x.id === i).map((x) => ({ renderTime: x.renderTime, loadTime: x.loadTime, url: x.url })), id)
    // renderTime 0 with a loadTime means Chromium withheld the paint time (a cross-origin image without Timing-Allow-Origin)
    throw new Error(`"${mark}": no paint of elementtiming="${id}" after its event within 60 s. Paints seen: ${JSON.stringify(seen)}. ${(e as Error).message}`)
  }
}

/** ms from moment `mark`'s input on the scrub bar to the frame at the position it asked for being on screen. */
async function frameAfter(page: Page, mark: string): Promise<number> {
  const h = await page.waitForFunction(
    (m) => {
      const rec = window.__rsPerf
      const at = rec.marks[m]
      if (!at) return null
      const f = rec.frames.find((x) => x.shown > at.ts && Math.abs(x.mediaTime - Number(at.value)) <= 0.1)
      return f ? f.shown - at.ts : null
    },
    mark,
    { timeout: 30_000, polling: 100 }
  )
  return (await h.jsonValue())!
}

/** Every frame the Reel screen's player presents from now on. */
function watchFrames(): void {
  const rec = window.__rsPerf
  const v = document.querySelector<HTMLVideoElement>('video[data-testid="player"]')!
  const onFrame = (_now: number, m: VideoFrameCallbackMetadata): void => {
    rec.frames.push({ mediaTime: m.mediaTime, shown: m.expectedDisplayTime })
    if (v.isConnected) v.requestVideoFrameCallback(onFrame)
  }
  v.requestVideoFrameCallback(onFrame)
}

interface Launch {
  /** spawn to the main process starting (Electron and Node booting, before any app code) */
  mainStartMs: number
  /** spawn to the window being shown; includes Playwright attaching, which holds Electron's ready event */
  windowShownMs: number
  /** spawn to the first reel title on Home being painted */
  homeReelMs: number
  /** the later of the two above: the window is up and the reels can be clicked */
  usableMs: number
}

async function launchTimes(app: ElectronApplication, page: Page, spawnedAt: number): Promise<Launch> {
  const home = await page.waitForFunction(
    (id) => {
      const p = window.__rsPerf.paints.find((x) => x.id === id && x.renderTime > 0)
      return p ? performance.timeOrigin + p.renderTime : null
    },
    HOME_REEL,
    { timeout: 60_000, polling: 100 }
  )
  const homeAt = (await home.jsonValue())!
  const main = await app.evaluate((_e, name) => ({ origin: performance.timeOrigin, shown: performance.getEntriesByName(name)[0]?.startTime ?? null }), WINDOW_SHOWN)
  if (main.shown === null) throw new Error(`no "${WINDOW_SHOWN}" mark in the main process; createWindow sets it on ready-to-show`)
  const shownAt = main.origin + main.shown
  return { mainStartMs: main.origin - spawnedAt, windowShownMs: shownAt - spawnedAt, homeReelMs: homeAt - spawnedAt, usableMs: Math.max(shownAt, homeAt) - spawnedAt }
}

interface Run {
  run: number
  load: { before: Load; after: Load; waitedForQuiet: number }
  launch: Launch
  openReelMs: number
  /** to a version not yet shown since launch */
  switchMs: number
  /** back to the version shown when the reel opened */
  switchBackMs: number
  /** one per SCRUB_AT position, in click order */
  scrubMs: number[]
  noteStatusMs: number
  /** what the player's first paint was: the version's cover (poster) or a video frame */
  picture: 'poster' | 'frame'
}

function commit(): string | null {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: APP_DIR, encoding: 'utf8' }).trim()
  } catch {
    return null
  }
}

test('app timings: launch, open a reel, switch versions, scrub, note', async () => {
  test.setTimeout((RUNS + 3) * 5 * 60_000)
  const startedAt = new Date().toISOString()
  const media = makeMedia()

  // Setup, untimed, and the warm-up: one reel with two versions in this spec's own profile.
  {
    const { app, page } = await launch(MOCK)
    try {
      await passFirstRun(page)
      await page.getByTestId('new-video').click()
      await page.getByTestId('file-input').setInputFiles([media.video])
      await expect(page.getByTestId('player')).toBeVisible({ timeout: 10 * 60_000 })
      await page.getByTestId('edit-myself').click()
      await page.getByTestId('tab-captions').click()
      await page.getByTestId('cap-size-big').click()
      await page.getByTestId('make-version').click()
      await expect(page.getByTestId('versions').getByText('Version 2')).toBeVisible({ timeout: 10 * 60_000 })
      await expect(page.getByTestId('note-progress')).toHaveCount(0, { timeout: 10 * 60_000 })
    } finally {
      await app.close()
    }
  }

  const runs: Run[] = []
  let versions: Record<string, string> = {}
  for (let run = 1; run <= RUNS; run++) {
    const waitedForQuiet = await waitForQuiet()
    const before = machineLoad()
    const spawnedAt = Date.now()
    const { app, page } = await launch(ENV)
    try {
      await page.evaluate(recorder)
      const launchMs = await launchTimes(app, page, spawnedAt)
      if (run === 1) versions = await app.evaluate(() => ({ electron: process.versions.electron, chrome: process.versions.chrome }))

      await arm(page, 'open', 'click')
      await page.getByTestId('project-card').click()
      const open = await paintAfter(page, 'open', 'player', PLAYER)

      const chip = (name: string) => page.getByTestId('versions').getByRole('radio', { name, exact: true })
      await expect(chip('Version 2')).toHaveAttribute('aria-checked', 'true')
      await arm(page, 'switch', 'click')
      await chip('Version 1').click()
      const sw = await paintAfter(page, 'switch', 'player', PLAYER)
      await arm(page, 'back', 'click')
      await chip('Version 2').click()
      const back = await paintAfter(page, 'back', 'player', PLAYER)

      // A person plays before scrubbing; the bar shows once the video has started. Then each click is one seek.
      await page.locator(PLAYER).evaluate(async (v: HTMLVideoElement) => {
        v.muted = true
        await v.play()
        await new Promise((r) => setTimeout(r, 300))
        v.pause()
      })
      await page.evaluate(watchFrames)
      await page.getByTestId('phone').hover()
      const box = await page.getByRole('slider', { name: 'Position in the video' }).boundingBox()
      if (!box) throw new Error('the scrub bar has no bounds')
      const scrubMs: number[] = []
      for (const [i, at] of SCRUB_AT.entries()) {
        await arm(page, `scrub${i}`, 'input')
        await page.mouse.click(box.x + box.width * at, box.y + box.height / 2)
        scrubMs.push(await frameAfter(page, `scrub${i}`))
      }

      await page.evaluate(() => window.reel.ai.setActive('codex-cli'))
      const input = page.getByTestId('note-input')
      await input.fill('Make the captions a little bigger')
      await arm(page, 'note', 'keydown')
      await input.press('Enter')
      const note = await paintAfter(page, 'note', NOTE_STATUS)
      await expect(page.getByTestId('note-progress')).toHaveCount(0, { timeout: 60_000 })

      runs.push({
        run,
        load: { before, after: machineLoad(), waitedForQuiet },
        launch: launchMs,
        openReelMs: open.ms,
        switchMs: sw.ms,
        switchBackMs: back.ms,
        scrubMs,
        noteStatusMs: note.ms,
        picture: /cover\.png/.test(open.url) ? 'poster' : 'frame'
      })
    } finally {
      await app.close()
    }
  }

  const summary = {
    launchUsableMs: stats(runs.map((r) => r.launch.usableMs)),
    launchMainStartMs: stats(runs.map((r) => r.launch.mainStartMs)),
    launchWindowShownMs: stats(runs.map((r) => r.launch.windowShownMs)),
    launchHomeReelMs: stats(runs.map((r) => r.launch.homeReelMs)),
    openReelMs: stats(runs.map((r) => r.openReelMs)),
    switchMs: stats(runs.map((r) => r.switchMs)),
    switchBackMs: stats(runs.map((r) => r.switchBackMs)),
    ...Object.fromEntries(SCRUB_AT.map((at, i) => [`scrub${i + 1}At${Math.round(at * 100)}PctMs`, stats(runs.map((r) => r.scrubMs[i]))])),
    noteStatusMs: stats(runs.map((r) => r.noteStatusMs))
  }
  const report = {
    what: 'Reel Studio app timings (app/perf/README.md)',
    reportOnly:
      'No thresholds: there is no evidence yet for what these numbers should be. Each is a median over runs, spread = (max - min) / median. Read load before comparing.',
    startedAt,
    commit: commit(),
    machine: { platform: process.platform, release: release(), cpu: cpus()[0]?.model ?? null, cpus: cpus().length, memGiB: Math.round(totalmem() / 2 ** 30) },
    ...versions,
    engine: process.env.REELSTUDIO_ENGINE_DIR ? 'REELSTUDIO_ENGINE_DIR' : 'fake (app/dev/fake-engine), which only makes the setup reel',
    ai: 'mock, ChatGPT editor connected, each note held 1.5 s',
    video: process.env.REELSTUDIO_E2E_VIDEO ? 'REELSTUDIO_E2E_VIDEO' : 'generated 12 s 540x960 test pattern, rendered at 1080x1920',
    summary,
    runs
  }
  const out = process.env.REELSTUDIO_PERF_OUT ?? join(APP_DIR, 'perf', 'results', `app-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, JSON.stringify(report, null, 1))
  console.log(`app timings (${runs.length} runs) -> ${out}`)
  for (const [k, s] of Object.entries(summary)) console.log(`  ${k.padEnd(22)} median ${String(s.median).padStart(8)} ms  [${s.min}, ${s.max}]  spread ${s.spreadPct}%`)
  console.log(`  load before each run: ${runs.map((r) => r.load.before.busy ?? '?').join(', ')} (${runs[0]?.load.before.how})`)
})
