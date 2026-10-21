// The cover picker's face scan (engine `cover-candidates --picker`), one per project at a time: every
// scan empties work/cover-picker first, so two at once would delete each other's stills.
import { COVER_SIGNALS, type CoverCandidate, type CoverSignal } from '../shared/cover'
import type { RunEngine } from './engine'
import { mediaUrl } from './media-url'

interface Scan {
  result: Promise<unknown>
  abort: AbortController
  exited: Promise<void>
}

export function createCoverScans(runEngine: RunEngine) {
  const running = new Map<string, Scan>()
  const stopping = new Map<string, Promise<void>>()

  /** This project's scan: the one already running, else a new one with `args`. */
  async function scan(slug: string, args: string[]): Promise<unknown> {
    await stopping.get(slug)
    const now = running.get(slug)
    if (now) return now.result
    const abort = new AbortController()
    let markExited!: () => void
    const exited = new Promise<void>((resolve) => (markExited = resolve))
    const result = runEngine('cover-candidates', [...args, '--picker'], undefined, abort.signal, markExited)
    const s: Scan = { result, abort, exited }
    running.set(slug, s)
    const forget = (): void => {
      if (running.get(slug) === s) running.delete(slug)
    }
    result.then(forget, forget)
    return result
  }

  /** Stops this project's scan, if one runs, and resolves once its process has exited. */
  async function stop(slug: string): Promise<void> {
    const s = running.get(slug)
    if (!s) return stopping.get(slug)
    running.delete(slug)
    s.abort.abort()
    stopping.set(slug, s.exited)
    await s.exited
    if (stopping.get(slug) === s.exited) stopping.delete(slug)
  }

  return { scan, stop }
}

const isSignal = (x: unknown): x is CoverSignal => COVER_SIGNALS.includes(x as CoverSignal)

/** The engine's answer -> what the picker shows. Two moments can land on the same frame; it shows once. */
export function parseCoverCandidates(r: any, source: string): CoverCandidate[] {
  const out: CoverCandidate[] = []
  for (const c of Array.isArray(r?.candidates) ? r.candidates : []) {
    const t = Number(c?.atSourceTime)
    if (!Number.isFinite(t) || typeof c?.file !== 'string' || !Array.isArray(c.reasons) || !c.reasons.every(isSignal))
      throw { code: 'ENGINE_OUTPUT', userMessage: 'I could not look through your video for a cover. Pick any moment below.', message: `cover-candidates row ${JSON.stringify(c)}` }
    if (out.some((o) => Math.abs(o.atSourceTime - t) < 0.3)) continue
    out.push({
      atSourceTime: t,
      source: String(r.source ?? source),
      reasons: COVER_SIGNALS.filter((s) => c.reasons.includes(s)),
      image: mediaUrl(c.file, Date.now())
    })
  }
  return out
}
