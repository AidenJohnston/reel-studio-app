// How a version gets its files (docs/versions.md). A hand edit ends at its draft: first the pictures of
// what it changed (engine `moments`: a few stills, the 2 s around them, then the draft), then that draft
// saved as the version (engine `save-version`). The full-quality file is made once, when the person
// exports (engine `export`), and handed back as it is while nothing changed since.
import type { Emit } from './jobs'
import type { RunEngine } from './engine'
import type { VideoFacts } from '../shared/api'

/** Saves a hand edit as a version and returns its number. `words` says what is being changed ("Updating your subtitles"). */
export async function saveHandEdit(runEngine: RunEngine, dir: string, words: string, emit: Emit, signal: AbortSignal): Promise<number> {
  const status = (pct: number): void => emit({ type: 'status', message: words, pct: Math.round(pct), phase: 'final' })
  status(1)
  try {
    const r = (await runEngine(
      'moments',
      ['--project', dir],
      (p) => {
        if (p.ready?.kind === 'still') emit({ type: 'moment', kind: 'still', t: p.ready.t, file: p.ready.file })
        else if (p.ready?.kind === 'window') emit({ type: 'moment', kind: 'window', from: p.ready.from, to: p.ready.to, file: p.ready.file })
        status(p.pct * 0.6)
      },
      signal
    )) as { draft?: { version?: number; file?: string } | null } | null
    if (r?.draft?.file) emit({ type: 'render', version: Number(r.draft.version ?? 0), draft: true, file: String(r.draft.file) })
  } catch (e) {
    if (signal.aborted) throw e
    // only the early pictures are lost: save-version below makes the draft
  }
  const saved = (await runEngine('save-version', ['--project', dir], (p) => status(60 + p.pct * 0.4), signal)) as { version: number }
  return Number(saved.version)
}

export interface Exported {
  version: number
  file: string
  cover: string | null
  /** the file was already made for this edit: nothing was rendered */
  reused: boolean
  facts: VideoFacts
}

/** The full-quality file of the edit as it is now, or of an earlier `version` that has one. */
export async function makeExport(runEngine: RunEngine, dir: string, version: number | null, emit: Emit, signal: AbortSignal): Promise<Exported> {
  const words = 'Making the full-quality video'
  emit({ type: 'status', message: words, pct: 1, phase: 'final' })
  const args = ['--project', dir, ...(version === null ? [] : ['--version', String(version)])]
  return (await runEngine('export', args, (p) => emit({ type: 'status', message: p.message || words, pct: p.pct, phase: 'final' }), signal)) as Exported
}
