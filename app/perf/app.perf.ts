// How long a person waits in the app itself: launch, opening a reel, switching versions, scrubbing, sending a note.
// Report only (README.md): it records numbers and fails only when a moment never happens.
//
// Every end time is Chromium's own: Element Timing's renderTime for the elements src/shared/perf-marks.ts names,
// requestVideoFrameCallback's expectedDisplayTime for a scrubbed frame, and an animation frame's start for the player
// swapping in a version. Every start is the timeStamp of the input event that began it. All are on the page's clock, so
// test-side polling never enters a number.
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { cpus, release, totalmem } from 'node:os'
import { dirname, join } from 'node:path'
import { APP_DIR, launch, makeMedia, makeReel, passFirstRun } from '../e2e/helpers'
import { HOME_REEL, NOTE_STATUS, PLAYER, WINDOW_SHOWN } from '../src/shared/perf-marks'
import { machineLoad, stats, waitForQuiet, type Load } from './measure'

const RUNS = Number(process.env.REELSTUDIO_PERF_RUNS || 5)
// Always the mock AI, even when REELSTUDIO_E2E_AI asks e2e for the real package. Its ChatGPT editor is connected for
// the note and answers each note after 1.5 s (REELSTUDIO_MOCK_NOTE, src/main/ai-mock.ts), as a real model takes seconds.
const MOCK = { REELSTUDIO_MOCK_AI: '1' }
const ENV = { ...MOCK, REELSTUDIO_MOCK_CODEX: 'ready', REELSTUDIO_MOCK_NOTE: '1500' }
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
  /** each <video> that became the player's shown layer with a decoded frame, and the start of the first animation
   * frame it was seen so */
  layers: { el: Element; at: number }[]
}
declare global {
  interface Window {
    __rsPerf: Rec
  }
}

/** Installed in the page right after launch. Element Timing entries are buffered, so launch's are still there. */
function recorder(player: string): void {
  if (window.__rsPerf) return
  const rec: Rec = { paints: [], marks: {}, pending: null, frames: [], layers: [] }
  window.__rsPerf = rec
  type ElementTiming = PerformanceEntry & { identifier: string; renderTime: number; loadTime: number; url: string; element: Element | null }
  new PerformanceObserver((list) => {
    for (const e of list.getEntries() as ElementTiming[])
      rec.paints.push({ id: e.identifier, renderTime: e.renderTime, loadTime: e.loadTime, url: e.url, el: e.element })
  }).observe({ type: 'element', buffered: true })
  for (const type of ['click', 'keydown', 'input', 'pointerup'])
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
  // The player loads a version in a hidden layer (opacity 0, Phone.css) and gives it data-testid="player" once its
  // first frame is ready (Player.tsx). Element Timing may record that layer's paint while it is still hidden, so the
  // swap itself is timed too: the first animation frame in which this element is the shown layer and has a frame.
  // The first layer is shown before it has loaded anything (videoLayers.ts), so being shown alone is not enough.
  let last: Element | null = null
  const watch = (t: number): void => {
    const el = document.querySelector<HTMLVideoElement>(player)
    if (!el) last = null
    else if (el !== last && el.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      rec.layers.push({ el, at: t })
      last = el
    }
    requestAnimationFrame(watch)
  }
  requestAnimationFrame(watch)
}

/** The next `type` event (keydown: Enter only) starts the moment `name`. */
async function arm(page: Page, name: string, type: 'click' | 'keydown' | 'input' | 'pointerup'): Promise<void> {
  await page.evaluate(([n, t]) => void (window.__rsPerf.pending = { name: n, type: t }), [name, type] as const)
}

/** ms from moment `mark`'s event to the first paint of `id` after it. */
async function paintAfter(page: Page, mark: string, id: string): Promise<{ ms: number; url: string }> {
  try {
    const h = await page.waitForFunction(
      ([m, i]) => {
        const rec = window.__rsPerf
        const start = rec.marks[m]?.ts
        if (start === undefined) return null
        const p = rec.paints.find((x) => x.id === i && x.renderTime > start)
        return p ? { ms: p.renderTime - start, url: p.url } : null
      },
      [mark, id] as const,
      { timeout: 60_000, polling: 100 }
    )
    return (await h.jsonValue())!
  } catch (e) {
    const seen = await page.evaluate((i) => window.__rsPerf.paints.filter((x) => x.id === i).map((x) => ({ renderTime: x.renderTime, loadTime: x.loadTime, url: x.url })), id)
    // renderTime 0 with a loadTime means Chromium withheld the paint time (a cross-origin image without Timing-Allow-Origin)
    throw new Error(`"${mark}": no paint of elementtiming="${id}" after its event within 60 s. Paints seen: ${JSON.stringify(seen)}. ${(e as Error).message}`)
  }
}

/**
 * ms from moment `mark`'s event to the player showing version `version`: the first animation frame with its <video>
 * as the shown layer and a decoded frame, or that element's first paint (Element Timing) if Chromium recorded a later
 * one. Only an element that became the shown layer after the event counts, so the version on screen before the click
 * never ends the moment.
 */
async function shownAfter(page: Page, mark: string, version: number): Promise<{ ms: number; url: string }> {
  try {
    const h = await page.waitForFunction(
      ([m, v, sel, id]) => {
        const rec = window.__rsPerf
        const start = rec.marks[m]?.ts
        if (start === undefined) return null
        const el = document.querySelector<HTMLVideoElement>(sel)
        if (!el || !new RegExp(`[\\\\/]v${v}[\\\\/]`).test(decodeURIComponent(el.currentSrc || el.src))) return null
        const swap = rec.layers.find((x) => x.el === el && x.at > start)
        if (!swap) return null
        // A layer that loaded hidden gets no Element Timing paint (Chromium skips invisible elements), so the swap,
        // which the player makes only once the layer has a decoded frame, ends the moment then.
        const p = rec.paints.find((x) => x.id === id && x.el === el && x.renderTime > 0)
        return { ms: (p ? Math.max(swap.at, p.renderTime) : swap.at) - start, url: p?.url ?? (el.currentSrc || el.src) }
      },
      [mark, version, PLAYER_SELECTOR, PLAYER] as const,
      { timeout: 60_000, polling: 100 }
    )
    return (await h.jsonValue())!
  } catch (e) {
    const seen = await page.evaluate((id) => window.__rsPerf.paints.filter((x) => x.id === id).map((x) => ({ renderTime: x.renderTime, url: x.url })), PLAYER)
    throw new Error(`"${mark}": the player did not show Version ${version} within 60 s. Player paints seen: ${JSON.stringify(seen)}. ${(e as Error).message}`)
  }
}

/** ms from moment `mark`'s release on the timeline to the frame at `target` seconds, where it seeked, being on screen. */
async function frameAfter(page: Page, mark: string, target: number): Promise<number> {
  const h = await page.waitForFunction(
    ([m, t]) => {
      const rec = window.__rsPerf
      const at = rec.marks[m]
      if (!at) return null
      const f = rec.frames.find((x) => x.shown > at.ts && Math.abs(x.mediaTime - t) <= 0.1)
      return f ? f.shown - at.ts : null
    },
    [mark, target] as const,
    { timeout: 30_000, polling: 100 }
  )
  return (await h.jsonValue())!
}

/**
 * The fraction of the timeline's width nearest `at` where a click lands on the bare track and seeks somewhere new. A
 * note's mark on the track is a button that opens that note's version (Timeline.tsx tl-mark), and each run's note adds
 * one where its scrubbing left the playhead, so a later run's click there switched versions instead of seeking. A
 * press on the playhead starts a drag (Timeline.tsx `.tl-head`), and a click where the playhead already is seeks
 * nowhere, so the 2% around `now` (the playhead's fraction) is skipped too.
 */
async function bareTrackAt(page: Page, box: { x: number; y: number; width: number; height: number }, at: number, now: number): Promise<number> {
  const f = await page.evaluate(
    ({ b, at, now }) => {
      const y = b.y + b.height / 2
      // out from `at` in 0.5% steps, alternating sides, up to 15% away
      for (let k = 0; k <= 60; k++) {
        const f = at + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 0.005
        if (f < 0.02 || f > 0.98 || Math.abs(f - now) < 0.02) continue
        const el = document.elementFromPoint(b.x + b.width * f, y)
        if (el?.closest('[data-testid="timeline"]') && !el.closest('button, a, [role="button"], .tl-heads')) return f
      }
      return null
    },
    { b: box, at, now }
  )
  if (f === null) throw new Error(`no bare spot on the timeline within 15% of ${at}: every point there is a mark, the playhead or another control`)
  return f
}

/** Every frame the Reel screen's shown player presents from now on. */
function watchFrames(sel: string): void {
  const rec = window.__rsPerf
  const v = document.querySelector<HTMLVideoElement>(sel)!
  const onFrame = (_now: number, m: VideoFrameCallbackMetadata): void => {
    rec.frames.push({ mediaTime: m.mediaTime, shown: m.expectedDisplayTime })
    if (v.isConnected) v.requestVideoFrameCallback(onFrame)
  }
  v.requestVideoFrameCallback(onFrame)
}

const PLAYER_SELECTOR = `video[data-testid="${PLAYER}"]`

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
  /** the fraction of the timeline each scrub clicked: its SCRUB_AT position, or the nearest bare spot to it */
  scrubAt: number[]
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
      await makeReel(page, media.video, 10 * 60_000)
      await page.getByTestId('edit-myself').click()
      await page.getByTestId('tab-captions').click()
      await page.getByTestId('cap-size-big').click()
      await page.getByTestId('make-version').click()
      await expect(page.getByTestId('log-play-2')).toBeVisible({ timeout: 10 * 60_000 })
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
      await page.evaluate(recorder, PLAYER_SELECTOR)
      const launchMs = await launchTimes(app, page, spawnedAt)
      if (run === 1) versions = await app.evaluate(() => ({ electron: process.versions.electron, chrome: process.versions.chrome }))

      // The reel opens on its latest version. Each run's note adds one, so it is read here, not assumed.
      const latest = await page.evaluate(async () => (await window.reel.projects.list())[0]?.version ?? 0)
      if (latest < 2) throw new Error(`the reel has ${latest} version(s); the setup made two`)
      await arm(page, 'open', 'click')
      await page.getByTestId('project-card').click()
      const open = await shownAfter(page, 'open', latest)

      await arm(page, 'switch', 'click')
      await page.getByTestId(`log-play-${latest - 1}`).click()
      const sw = await shownAfter(page, 'switch', latest - 1)
      await arm(page, 'back', 'click')
      await page.getByTestId(`log-play-${latest}`).click()
      const back = await shownAfter(page, 'back', latest)

      // A person plays before scrubbing, then clicks the timeline under the phone (Timeline.tsx): a click seeks to
      // where it lands when the button comes up. The player on the Reel screen has no scrub bar of its own.
      const player = page.locator(PLAYER_SELECTOR)
      await player.evaluate(async (v: HTMLVideoElement) => {
        v.muted = true
        await v.play()
        await new Promise((r) => setTimeout(r, 300))
        v.pause()
      })
      await page.evaluate(watchFrames, PLAYER_SELECTOR)
      const box = await page.getByTestId('timeline').boundingBox()
      if (!box) throw new Error('the timeline has no bounds')
      const scrubMs: number[] = []
      const scrubAt: number[] = []
      for (const [i, at] of SCRUB_AT.entries()) {
        const { before, now } = await player.evaluate((v: HTMLVideoElement) => ({ before: v.currentTime, now: v.currentTime / v.duration }))
        const f = await bareTrackAt(page, box, at, now)
        scrubAt.push(Math.round(f * 1000) / 1000)
        await arm(page, `scrub${i}`, 'pointerup')
        await page.mouse.click(box.x + box.width * f, box.y + box.height / 2)
        // where the click seeked to, read from the player once it has moved there
        const moved = await page.waitForFunction(
          ([sel, t]) => {
            const v = document.querySelector<HTMLVideoElement>(sel)
            return v && Math.abs(v.currentTime - t) > 0.05 ? v.currentTime : null
          },
          [PLAYER_SELECTOR, before] as const,
          { timeout: 10_000, polling: 50 }
        )
        scrubMs.push(await frameAfter(page, `scrub${i}`, (await moved.jsonValue())!))
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
        scrubAt,
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
    ai: 'mock, ChatGPT editor connected, each note answered after 1.5 s',
    video: process.env.REELSTUDIO_E2E_VIDEO ? 'REELSTUDIO_E2E_VIDEO' : 'generated test pattern (e2e/helpers.ts makeMedia)',
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
