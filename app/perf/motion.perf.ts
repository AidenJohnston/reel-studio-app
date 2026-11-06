// Frame timing of the first run's two moving moments, in a visible window: the welcome's reel flying into the player
// after Get started, and the editor step after "Use it" on Claude (the mock Claude Code app, ready). Report only
// (README.md): it records every frame gap and long animation frame and fails only when a moment never happens.
import { test, expect, type Page } from '@playwright/test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { cpus, release } from 'node:os'
import { dirname, join } from 'node:path'
import { APP_DIR, BASE, launch } from '../e2e/helpers'
import { machineLoad, stats, waitForQuiet, type Load } from './measure'

const RUNS = Number(process.env.REELSTUDIO_PERF_RUNS || 6)
const WATCH_MS = 3000

interface Loaf {
  start: number
  duration: number
  blocking: number
  scripts: { src: string; fn: string; ms: number }[]
}
interface Frames {
  gaps: number[]
  loafs: Loaf[]
}
declare global {
  interface Window {
    __rsMotion?: Frames
  }
}

/** Starts recording every animation frame's gap and every long animation frame for `ms` from now. */
function record(ms: number): void {
  const f: Frames = { gaps: [], loafs: [] }
  window.__rsMotion = f
  const t0 = performance.now()
  let last = t0
  const tick = (t: number): void => {
    f.gaps.push(t - last)
    last = t
    if (t - t0 < ms) requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
  type LoafEntry = PerformanceEntry & { blockingDuration: number; scripts: { sourceURL: string; sourceFunctionName: string; duration: number }[] }
  const obs = new PerformanceObserver((list) => {
    for (const e of list.getEntries() as LoafEntry[])
      f.loafs.push({
        start: Math.round(e.startTime - t0),
        duration: Math.round(e.duration),
        blocking: Math.round(e.blockingDuration),
        scripts: e.scripts.map((s) => ({ src: s.sourceURL.split('/').pop() ?? '', fn: s.sourceFunctionName, ms: Math.round(s.duration) }))
      })
  })
  obs.observe({ type: 'long-animation-frame' })
  setTimeout(() => obs.disconnect(), ms + 500)
}

interface Moment {
  medianGapMs: number
  maxGapMs: number
  p95GapMs: number
  framesOver50Ms: number
  loafs: Loaf[]
}
interface Run {
  run: number
  load: { before: Load; after: Load }
  flyIn: Moment
  useClaude: Moment
  /** the longest tasks Chromium traced around "Use it", with the process and thread each ran on */
  useClaudeTasks: Task[]
}
interface Task {
  process: string
  thread: string
  name: string
  ms: number
  at: number
}

/** Chromium trace events (Tracing.dataCollected) */
interface TraceEvent {
  ph: string
  name: string
  pid: number
  tid: number
  ts: number
  dur?: number
  args?: { name?: string }
}

/** The longest complete tasks of a trace, longest first, each named by its process and thread (GPU, renderer...). */
function longestTasks(events: TraceEvent[], top = 12, minMs = 16): Task[] {
  const proc = new Map<number, string>()
  const thread = new Map<string, string>()
  for (const e of events) {
    if (e.ph !== 'M') continue
    if (e.name === 'process_name') proc.set(e.pid, e.args?.name ?? String(e.pid))
    if (e.name === 'thread_name') thread.set(`${e.pid}:${e.tid}`, e.args?.name ?? String(e.tid))
  }
  const t0 = Math.min(...events.filter((e) => e.ph === 'X').map((e) => e.ts))
  return events
    .filter((e) => e.ph === 'X' && (e.dur ?? 0) >= minMs * 1000)
    .sort((a, b) => (b.dur ?? 0) - (a.dur ?? 0))
    .slice(0, top)
    .map((e) => ({ process: proc.get(e.pid) ?? String(e.pid), thread: thread.get(`${e.pid}:${e.tid}`) ?? String(e.tid), name: e.name, ms: Math.round((e.dur ?? 0) / 100) / 10, at: Math.round((e.ts - t0) / 1000) }))
}

async function measure(page: Page, act: () => Promise<void>): Promise<Moment> {
  await page.evaluate(record, WATCH_MS)
  await act()
  await page.waitForTimeout(WATCH_MS + 600)
  const f = (await page.evaluate(() => window.__rsMotion))!
  const gaps = f.gaps.slice(1).sort((a, b) => a - b)
  if (gaps.length < 10) throw new Error(`only ${gaps.length} frames in ${WATCH_MS} ms: the window was not drawing`)
  const round = (n: number) => Math.round(n * 10) / 10
  return {
    // the display's own frame time: what every other gap is compared with
    medianGapMs: round(gaps[Math.floor(gaps.length / 2)]),
    maxGapMs: round(gaps[gaps.length - 1]),
    p95GapMs: round(gaps[Math.floor(gaps.length * 0.95)]),
    framesOver50Ms: gaps.filter((g) => g > 50).length,
    loafs: f.loafs.sort((a, b) => b.duration - a.duration).slice(0, 5)
  }
}

test('first-run motion: the welcome fly-in and "Use it" on Claude', async () => {
  test.setTimeout(RUNS * 5 * 60_000)
  const runs: Run[] = []
  for (let run = 1; run <= RUNS; run++) {
    await waitForQuiet()
    const before = machineLoad()
    const mine = mkdtempSync(join(BASE, 'motion-'))
    // a real viewport: the fly-in needs a window wider than 860 px (FirstRun.tsx canFly)
    const { app, page } = await launch({ REELSTUDIO_MOCK_CLAUDE: 'ready', REELSTUDIO_USER_DATA: join(mine, 'user data'), REELSTUDIO_ROOT: join(mine, 'Reel Studio') }, { realViewport: true })
    try {
      await page.getByTestId('get-started').waitFor()
      const flyIn = await measure(page, () => page.getByTestId('get-started').click())
      await page.getByTestId('demo-skip').click()
      await page.getByTestId('demo-next').click()
      const skip = page.getByTestId('mac-skip')
      const use = page.getByTestId('use-claude-code')
      await expect(skip.or(use)).toBeVisible()
      if (await skip.isVisible()) await skip.click()
      await expect(use).toBeVisible()
      // a trace beside the frame timing, so a long frame can be put down to its process and task
      const cdp = await page.context().newCDPSession(page)
      const events: TraceEvent[] = []
      cdp.on('Tracing.dataCollected', (e) => void events.push(...(e.value as TraceEvent[])))
      await cdp.send('Tracing.start', {
        categories: 'toplevel,devtools.timeline,disabled-by-default-devtools.timeline,disabled-by-default-devtools.timeline.frame,gpu,viz,media',
        transferMode: 'ReportEvents'
      })
      const useClaude = await measure(page, () => use.click())
      const ended = new Promise<void>((r) => cdp.once('Tracing.tracingComplete', () => r()))
      await cdp.send('Tracing.end')
      await ended
      runs.push({ run, load: { before, after: machineLoad() }, flyIn, useClaude, useClaudeTasks: longestTasks(events) })
    } finally {
      await app.close()
    }
  }
  const summary = Object.fromEntries(
    (['flyIn', 'useClaude'] as const).map((k) => [k, { maxGapMs: stats(runs.map((r) => r[k].maxGapMs)), framesOver50Ms: runs.map((r) => r[k].framesOver50Ms) }])
  )
  const report = {
    what: 'Reel Studio first-run motion (app/perf/README.md)',
    reportOnly: 'No thresholds. maxGapMs is the longest time between two animation frames in the 3 s after the click.',
    machine: { platform: process.platform, release: release(), cpu: cpus()[0]?.model ?? null, cpus: cpus().length },
    summary,
    runs
  }
  const out = process.env.REELSTUDIO_PERF_OUT_MOTION ?? join(APP_DIR, 'perf', 'results', `motion-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, JSON.stringify(report, null, 1))
  console.log(`first-run motion (${runs.length} runs) -> ${out}`)
  console.log(JSON.stringify(summary))
})
