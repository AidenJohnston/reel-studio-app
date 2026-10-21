// `Reel Studio --self-test [--out <file>]`: proves an installed copy can make videos without opening a window.
// packaging/test-mac-install.sh and test-win-install.ps1 run it and read the JSON it writes (the same contract as
// packaging/spike). This module never imports electron; index.ts supplies the paths and the engine runner.
import type { RunEngine } from './engine'
import { isEngineError } from './engine'

export interface SelfTestLocations {
  python: string
  ffmpeg: string
  ffprobe: string
  /** The folder holding the `reelengine` package. */
  engine: string
}

export interface SelfTestCheck {
  name: string
  ok: boolean
  /** A failed check that is not required is reported but does not fail the self-test. */
  required: boolean
  detail: unknown
  seconds?: number
}

export interface SelfTestResult {
  ok: boolean
  checks: SelfTestCheck[]
}

/** doctor checks a fresh install is expected to fail: the speech model is downloaded on the first-run screen. */
const NOT_REQUIRED = new Set(['speech model'])

export const DOCTOR_TIMEOUT_MS = 120_000

export function selfTestArgs(argv: string[]): { selfTest: boolean; out: string | null } {
  const i = argv.indexOf('--out')
  return { selfTest: argv.includes('--self-test'), out: i >= 0 && argv[i + 1] ? argv[i + 1] : null }
}

interface DoctorCheck {
  ok: boolean
  name: string
  detail: string
  fix?: string
}

function isDoctorResult(r: unknown): r is { ok: boolean; checks: DoctorCheck[] } {
  if (!r || typeof r !== 'object') return false
  const o = r as Record<string, unknown>
  return (
    typeof o.ok === 'boolean' &&
    Array.isArray(o.checks) &&
    o.checks.every((c) => !!c && typeof c === 'object' && typeof (c as DoctorCheck).ok === 'boolean' && typeof (c as DoctorCheck).name === 'string')
  )
}

export async function runSelfTest(opts: {
  locations: SelfTestLocations
  /** Absolute paths must exist; a bare name must be found on PATH. */
  exists: (path: string) => boolean
  /** Exists when the engine package is complete (reelengine/__main__.py). */
  engineExists: (engineDir: string) => boolean
  runEngine: RunEngine
  timeoutMs?: number
}): Promise<SelfTestResult> {
  const { locations: L } = opts
  const checks: SelfTestCheck[] = [
    { name: 'bundled python', ok: opts.exists(L.python), required: true, detail: L.python },
    { name: 'bundled ffmpeg', ok: opts.exists(L.ffmpeg), required: true, detail: L.ffmpeg },
    { name: 'bundled ffprobe', ok: opts.exists(L.ffprobe), required: true, detail: L.ffprobe },
    { name: 'engine files', ok: opts.engineExists(L.engine), required: true, detail: L.engine }
  ]

  const timeoutMs = opts.timeoutMs ?? DOCTOR_TIMEOUT_MS
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  const t0 = Date.now()
  const seconds = (): number => Math.round((Date.now() - t0) / 100) / 10
  try {
    const result = await opts.runEngine('doctor', [], undefined, ac.signal)
    if (!isDoctorResult(result)) {
      checks.push({ name: 'engine doctor', ok: false, required: true, detail: { unexpectedResult: result }, seconds: seconds() })
    } else {
      // Getting a doctor result at all means the bundled python started and imported the engine.
      checks.push({ name: 'engine doctor', ok: true, required: true, detail: 'python -m reelengine doctor ran', seconds: seconds() })
      for (const c of result.checks) {
        checks.push({
          name: `doctor: ${c.name}`,
          ok: c.ok,
          required: !NOT_REQUIRED.has(c.name),
          detail: c.ok || !c.fix ? c.detail : `${c.detail} (${c.fix})`
        })
      }
    }
  } catch (e) {
    const timedOut = ac.signal.aborted
    const detail = timedOut
      ? `doctor did not finish within ${timeoutMs / 1000}s`
      : isEngineError(e)
        ? { code: e.code, message: e.message }
        : String(e)
    checks.push({ name: 'engine doctor', ok: false, required: true, detail, seconds: seconds() })
  } finally {
    clearTimeout(timer)
  }
  return { ok: checks.every((c) => c.ok || !c.required), checks }
}
