// Frame timing of the first run's two moving moments, in a visible window: the welcome's reel flying into the player
// after Get started, and the editor step after "Use it" on Claude (the mock Claude Code app, ready). Report only
// (README.md): it records every frame gap and long animation frame and fails only when a moment never happens.
import { test, expect, type CDPSession, type Page } from '@playwright/test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { cpus, release } from 'node:os'
import { dirname, join } from 'node:path'
import { APP_DIR, BASE, launch } from '../e2e/helpers'
import { machineLoad, stats, waitForQuiet, type Load } from './measure'

const RUNS = Number(process.env.REELSTUDIO_PERF_RUNS || 6)
const WATCH_MS = 3000
/** the traced window on each side of the "Use it" click: before it, what the editor step does on its own */
const TRACE_MS = 600
/** the user-timing mark the click sets, found in the trace to split it */
const CLICK_MARK = 'rs-use-claude'

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
  /** the longest tasks Chromium traced in the 600 ms after "Use it", with the process and thread each ran on */
  useClaudeTasks: Task[]
  /** what the page painted in the 600 ms after "Use it", by element, largest area first */
  useClaudePaints: PaintedNode[]
  /** the same for the 600 ms before the click: what the step does with nobody touching it, to subtract */
  stillTasks: Task[]
  stillPaints: PaintedNode[]
}
interface PaintedNode {
  node: string
  paints: number
  /** CSS px² of the rectangles Paint recorded, summed: how often and how much was re-recorded, not what the GPU
   * rastered (that is the GPU tasks' time). Paints with no bounds (unbounded) are counted apart, not in it. */
  area: number
  /** paints whose recorded rectangle was Chromium's unbounded one (no clip), which has no meaningful area */
  unbounded: number
}
interface Task {
  process: string
  thread: string
  name: string
  ms: number
  /** ms from the click; negative before it */
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
  args?: { name?: string; data?: { nodeId?: number; clip?: number[] } }
}

/** Trace time (µs) of the mark the click set. Without it the trace can't be split, so it fails loudly. */
function clickAt(events: TraceEvent[]): number {
  const mark = events.find((e) => e.name === CLICK_MARK)
  if (!mark) throw new Error(`the trace has no "${CLICK_MARK}" mark: is blink.user_timing in its categories?`)
  return mark.ts
}

/** Whether a trace event starts in [from, to), both ms from the click. */
const within = (e: TraceEvent, click: number, from: number, to: number): boolean => e.ts >= click + from * 1000 && e.ts < click + to * 1000

/** Chromium writes an unclipped Paint's rectangle as its "infinite" one, about ±2^24 px a side. */
const UNBOUNDED_PX = 1e6

type Painted = { paints: number; area: number; unbounded: number }

/** The page's Paint events starting in [from, to) ms from the click, summed by DOM node. */
function paintsByNode(events: TraceEvent[], click: number, from: number, to: number): Map<number, Painted> {
  const out = new Map<number, Painted>()
  for (const e of events) {
    const id = e.args?.data?.nodeId
    const q = e.args?.data?.clip
    if (e.name !== 'Paint' || id === undefined || !q || q.length !== 8 || !within(e, click, from, to)) continue
    const xs = [q[0], q[2], q[4], q[6]]
    const ys = [q[1], q[3], q[5], q[7]]
    const unbounded = [...xs, ...ys].some((v) => Math.abs(v) > UNBOUNDED_PX)
    const area = unbounded ? 0 : (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys))
    const n = out.get(id) ?? { paints: 0, area: 0, unbounded: 0 }
    out.set(id, { paints: n.paints + 1, area: n.area + area, unbounded: n.unbounded + (unbounded ? 1 : 0) })
  }
  return out
}

/** The longest complete tasks starting in [from, to) ms from the click, longest first, each named by its process and
 * thread (GPU, renderer...). */
function longestTasks(events: TraceEvent[], click: number, from: number, to: number, top = 12, minMs = 16): Task[] {
  const proc = new Map<number, string>()
  const thread = new Map<string, string>()
  for (const e of events) {
    if (e.ph !== 'M') continue
    if (e.name === 'process_name') proc.set(e.pid, e.args?.name ?? String(e.pid))
    if (e.name === 'thread_name') thread.set(`${e.pid}:${e.tid}`, e.args?.name ?? String(e.tid))
  }
  return events
    .filter((e) => e.ph === 'X' && (e.dur ?? 0) >= minMs * 1000 && within(e, click, from, to))
    .sort((a, b) => (b.dur ?? 0) - (a.dur ?? 0))
    .slice(0, top)
    .map((e) => ({ process: proc.get(e.pid) ?? String(e.pid), thread: thread.get(`${e.pid}:${e.tid}`) ?? String(e.tid), name: e.name, ms: Math.round((e.dur ?? 0) / 100) / 10, at: Math.round((e.ts - click) / 1000) }))
}

/** The most repainted nodes (then the largest), each named as a selector would name it: tag, test id, classes. */
async function describePaints(cdp: CDPSession, painted: Map<number, Painted>): Promise<PaintedNode[]> {
  const out: PaintedNode[] = []
  for (const [backendNodeId, n] of [...painted].sort((a, b) => b[1].paints - a[1].paints || b[1].area - a[1].area).slice(0, 8)) {
    let node = `backend node ${backendNodeId}`
    try {
      const { node: d } = await cdp.send('DOM.describeNode', { backendNodeId })
      const attr = (k: string) => {
        const i = d.attributes?.indexOf(k) ?? -1
        return i >= 0 ? (d.attributes?.[i + 1] ?? '') : ''
      }
      node = `${d.nodeName.toLowerCase()}${attr('data-testid') ? `[data-testid=${attr('data-testid')}]` : ''}${attr('class') ? `.${attr('class').trim().split(/\s+/).join('.')}` : ''}`
    } catch {
      // the node is gone from the page since it painted
    }
    out.push({ node, paints: n.paints, area: Math.round(n.area), unbounded: n.unbounded })
  }
  return out
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
      // the protocol types a trace event as a string map; its fields are numbers and objects too (TraceEvent)
      cdp.on('Tracing.dataCollected', (e) => void events.push(...(e.value as unknown as TraceEvent[])))
      await cdp.send('Tracing.start', {
        categories: 'toplevel,blink.user_timing,devtools.timeline,disabled-by-default-devtools.timeline,disabled-by-default-devtools.timeline.frame,gpu,viz,media',
        transferMode: 'ReportEvents'
      })
      // the step on its own first, then the click, marked by the click itself so the trace splits at it (Playwright
      // waits for the button to be ready before clicking, so a mark set beforehand could fall well before the click)
      await use.evaluate((el, m) => el.addEventListener('click', () => performance.mark(m), { capture: true, once: true }), CLICK_MARK)
      await page.waitForTimeout(TRACE_MS)
      const useClaude = await measure(page, () => use.click())
      const ended = new Promise<void>((r) => cdp.once('Tracing.tracingComplete', () => r()))
      await cdp.send('Tracing.end')
      await ended
      const click = clickAt(events)
      await cdp.send('DOM.getDocument', { depth: 0 })
      const after = await describePaints(cdp, paintsByNode(events, click, 0, TRACE_MS))
      const still = await describePaints(cdp, paintsByNode(events, click, -TRACE_MS, 0))
      runs.push({
        run,
        load: { before, after: machineLoad() },
        flyIn,
        useClaude,
        useClaudeTasks: longestTasks(events, click, 0, TRACE_MS),
        useClaudePaints: after,
        stillTasks: longestTasks(events, click, -TRACE_MS, 0),
        stillPaints: still
      })
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
