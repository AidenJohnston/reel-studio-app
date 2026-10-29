import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { RunEngine } from './engine'
import { isEngineError } from './engine'

export interface SelfTestLocations {
  python: string
  ffmpeg: string
  ffprobe: string
  engine: string
}

export interface SelfTestCheck {
  name: string
  ok: boolean
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

const DOCTOR_TIMEOUT_MS = 120_000
const execFileAsync = promisify(execFile)

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
  return (
    'ok' in r && typeof r.ok === 'boolean' &&
    'checks' in r && Array.isArray(r.checks) &&
    r.checks.every((c: unknown) => !!c && typeof c === 'object' &&
      'ok' in c && typeof c.ok === 'boolean' && 'name' in c && typeof c.name === 'string' &&
      'detail' in c && typeof c.detail === 'string' && (!('fix' in c) || typeof c.fix === 'string'))
  )
}

export async function runSelfTest(opts: {
  locations: SelfTestLocations
  runEngine: RunEngine
}): Promise<SelfTestResult> {
  const { locations: L } = opts
  const ffprobeCheck: SelfTestCheck = { name: 'bundled ffprobe', ok: existsSync(L.ffprobe), required: true, detail: L.ffprobe }
  if (ffprobeCheck.ok) {
    try {
      const { stdout } = await execFileAsync(L.ffprobe, ['-version'], { timeout: 10_000, killSignal: 'SIGKILL', maxBuffer: 64 * 1024, windowsHide: true })
      ffprobeCheck.ok = /^ffprobe version \S+/m.test(stdout)
      ffprobeCheck.detail = stdout.trim() || 'ffprobe -version returned no version'
    } catch (e) {
      ffprobeCheck.ok = false
      ffprobeCheck.detail = e instanceof Error ? e.message : String(e)
    }
  }
  const checks: SelfTestCheck[] = [
    { name: 'bundled python', ok: existsSync(L.python), required: true, detail: L.python },
    { name: 'bundled ffmpeg', ok: existsSync(L.ffmpeg), required: true, detail: L.ffmpeg },
    ffprobeCheck,
    { name: 'engine files', ok: existsSync(join(L.engine, 'reelengine', '__main__.py')), required: true, detail: L.engine }
  ]

  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), DOCTOR_TIMEOUT_MS)
  const t0 = Date.now()
  const seconds = (): number => Math.round((Date.now() - t0) / 100) / 10
  try {
    const result = await opts.runEngine('doctor', [], undefined, ac.signal)
    if (!isDoctorResult(result)) {
      checks.push({ name: 'engine doctor', ok: false, required: true, detail: { unexpectedResult: result }, seconds: seconds() })
    } else {
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
      ? `doctor did not finish within ${DOCTOR_TIMEOUT_MS / 1000}s`
      : isEngineError(e)
        ? { code: e.code, message: e.message }
        : String(e)
    checks.push({ name: 'engine doctor', ok: false, required: true, detail, seconds: seconds() })
  } finally {
    clearTimeout(timer)
  }
  return { ok: checks.every((c) => c.ok || !c.required), checks }
}
