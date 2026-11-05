// Node-side helpers for app.perf.ts: the summary each moment gets, and how busy the machine was.
import { execFileSync } from 'node:child_process'
import { cpus, loadavg } from 'node:os'

export interface Stats {
  median: number
  min: number
  max: number
  /** (max - min) / median, in percent, as engine/harness reports it. */
  spreadPct: number
  n: number
}

const tenth = (x: number): number => Math.round(x * 10) / 10

export function stats(xs: number[]): Stats {
  if (!xs.length) throw new Error('stats of no runs')
  const s = [...xs].sort((a, b) => a - b)
  const mid = s.length >> 1
  const median = s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
  const lo = s[0]
  const hi = s[s.length - 1]
  return { median: tenth(median), min: tenth(lo), max: tenth(hi), spreadPct: median ? tenth((100 * (hi - lo)) / median) : 0, n: s.length }
}

/** The last sample in `typeperf "\Processor(_Total)\% Processor Time" -sc 1` output, as a fraction. */
export function parseTypeperf(out: string): number | null {
  const v = [...out.matchAll(/^"[^"]*","([0-9]+(?:[.,][0-9]+)?)"\s*$/gm)].pop()?.[1]
  return v === undefined ? null : Number(v.replace(',', '.')) / 100 // some locales write 37,5
}

export interface Load {
  /** 0 = idle, 1 = every CPU busy; null when it could not be read. */
  busy: number | null
  how: string
}

/** Windows has no load average (Node reports zeros), so it asks typeperf, as engine/harness does. */
export function machineLoad(): Load {
  if (process.platform !== 'win32') return { busy: Math.round((100 * loadavg()[0]) / cpus().length) / 100, how: '1-minute load average / CPUs' }
  try {
    const out = execFileSync('typeperf', ['\\Processor(_Total)\\% Processor Time', '-sc', '1'], { encoding: 'utf8', timeout: 30_000 })
    const busy = parseTypeperf(out)
    // typeperf takes the counter's localized name, so on a Windows not in English this finds no counter and says so
    return { busy: busy === null ? null : Math.round(busy * 100) / 100, how: busy === null ? 'typeperf gave no sample (counter names are English)' : 'typeperf % Processor Time, one 1 s sample' }
  } catch (e) {
    return { busy: null, how: `typeperf failed: ${(e as Error).message.split('\n')[0]}` }
  }
}

/**
 * With REELSTUDIO_PERF_MAX_BUSY (0 to 1) set, waits outside any timing, 30 s at a time for up to 5 minutes, until the
 * machine is less busy than that. Unset, it records load and never waits. Returns how many times it waited.
 */
export async function waitForQuiet(): Promise<number> {
  const max = Number(process.env.REELSTUDIO_PERF_MAX_BUSY)
  if (!(max > 0)) return 0
  for (let waited = 0; waited <= 10; waited++) {
    const { busy, how } = machineLoad()
    if (busy === null) throw new Error(`REELSTUDIO_PERF_MAX_BUSY is set but the load could not be read (${how})`)
    if (busy < max) return waited
    if (waited < 10) await new Promise((r) => setTimeout(r, 30_000))
  }
  throw new Error(`the machine stayed busier than ${max} for 5 minutes, so timings would say little about the app`)
}
