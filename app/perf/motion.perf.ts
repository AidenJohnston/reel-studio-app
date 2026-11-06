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
  /** what the page painted in the 600 ms after "Use it", by element, largest area first (the raster the GPU then does) */
  useClaudePaints: PaintedNode[]
}
interface PaintedNode {
  node: string
  paints: number
  /** CSS px², summed over its paints */
  area: number
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
  args?: { name?: string; data?: { nodeId?: number; clip?: number[] } }
}

/** The page's Paint events in the window after the click (ms from the trace's first task), summed by DOM node. */
function paintsByNode(events: TraceEvent[], windowMs: number): Map<number, { paints: number; area: number }> {
  const t0 = Math.min(...events.filter((e) => e.ph === 'X').map((e) => e.ts))
  const out = new Map<number, { paints: number; area: number }>()
  for (const e of events) {
    const id = e.args?.data?.nodeId
    const q = e.args?.data?.clip
    if (e.name !== 'Paint' || id === undefined || !q || q.length !== 8 || (e.ts - t0) / 1000 > windowMs) continue
    const xs = [q[0], q[2], q[4], q[6]]
    const ys = [q[1], q[3], q[5], q[7]]
    const area = (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys))
    const n = out.get(id) ?? { paints: 0, area: 0 }
    out.set(id, { paints: n.paints + 1, area: n.area + area })
  }
  return out
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
      // the protocol types a trace event as a string map; its fields are numbers and objects too (TraceEvent)
      cdp.on('Tracing.dataCollected', (e) => void events.push(...(e.value as unknown as TraceEvent[])))
      await cdp.send('Tracing.start', {
        categories: 'toplevel,devtools.timeline,disabled-by-default-devtools.timeline,disabled-by-default-devtools.timeline.frame,gpu,viz,media',
        transferMode: 'ReportEvents'
      })
      const useClaude = await measure(page, () => use.click())
      const ended = new Promise<void>((r) => cdp.once('Tracing.tracingComplete', () => r()))
      await cdp.send('Tracing.end')
      await ended
      // name each painted node as a selector would: tag, test id, classes
      const painted = [...paintsByNode(events, 600)].sort((a, b) => b[1].area - a[1].area).slice(0, 8)
      await cdp.send('DOM.getDocument', { depth: 0 })
      const useClaudePaints: PaintedNode[] = []
      for (const [backendNodeId, n] of painted) {
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
        useClaudePaints.push({ node, paints: n.paints, area: Math.round(n.area) })
      }
      runs.push({ run, load: { before, after: machineLoad() }, flyIn, useClaude, useClaudeTasks: longestTasks(events), useClaudePaints })
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
