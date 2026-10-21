// The listening model: reuse a matching copy already on this computer, else the one-time download, then a timing
// check that picks how many processor threads it should use here.
import { existsSync, readFileSync, promises as fs } from 'node:fs'
import { cpus } from 'node:os'
import { join } from 'node:path'
import { engineMode, modelsDir } from './paths'
import type { ModelStatus } from '../shared/api'
import { toUserError, type RunEngine } from './engine'
import type { WorkGate } from './work-gate'
import { adoptCopy, findCachedCopies, hfHubCache, type PinnedModel } from './model-cache'
import pinnedModels from '../../../engine/reelengine/models/speech-models.json'

// Must match the engine's transcribe.DEFAULT_MODEL (or set REELENGINE_MODEL for both).
export const modelName = (): string => process.env.REELENGINE_MODEL || 'small.en'

/** The pinned files of a model, or null for one Reel Studio does not pin (only those can be reused). */
export function pinnedModel(name = modelName()): PinnedModel | null {
  // Test builds can pin stand-in files, so the "found on this computer" path runs without a 483 MB model.
  const override = process.env.REELSTUDIO_TEST === '1' ? process.env.REELSTUDIO_TEST_SPEECH_PINS : undefined
  const pins: Record<string, PinnedModel> = override ? JSON.parse(readFileSync(override, 'utf8')) : pinnedModels
  return pins[name] ?? null
}

/** Same rule as the engine's transcribe.model_present(). */
export function modelInstalled(dir = join(modelsDir(), modelName())): boolean {
  if (existsSync(join(dir, '.fake')) && engineMode() === 'real') return false
  return (
    existsSync(join(dir, 'model.bin')) &&
    existsSync(join(dir, 'config.json')) &&
    ['tokenizer.json', 'vocabulary.txt', 'vocabulary.json'].some((f) => existsSync(join(dir, f)))
  )
}

/** A profile copied to another computer checks again. */
export interface SpeechCheckResult {
  machine: string
  /** null: the check failed (or the GPU does the work), so the engine keeps its usual rule */
  threads: number | null
}

const thisMachine = (): string => `${process.arch} ${cpus()[0]?.model ?? 'unknown'} x${cpus().length}`

export interface ModelDeps {
  runEngine: RunEngine
  onChange: (s: ModelStatus) => void
  loadCheck: () => Promise<SpeechCheckResult | null>
  saveCheck: (r: SpeechCheckResult) => Promise<void>
  useThreads: (n: number | null) => void
  gate: WorkGate
  log: (line: string) => void
}

export function createModelManager(deps: ModelDeps) {
  const { runEngine, log } = deps
  const total = (): number => pinnedModel()?.files.reduce((a, f) => a + f.size, 0) ?? 0
  let state: ModelStatus = {
    name: modelName(),
    installed: false,
    downloading: false,
    checking: false,
    reused: false,
    checkFailed: false,
    pct: 0,
    bytes: 0,
    total: total(),
    error: null
  }
  let download: AbortController | null = null
  let finding: Promise<ModelStatus> | null = null
  let timing: Promise<void> | null = null

  const set = (patch: Partial<ModelStatus>): ModelStatus => {
    state = { ...state, ...patch }
    deps.onChange(state)
    return state
  }
  const checkDone = async (): Promise<boolean> => (await deps.loadCheck())?.machine === thisMachine()

  /** A creator can't judge the thread count, so this is never a setup step; it runs unseen once the model is here. */
  function checkInBackground(): Promise<void> {
    timing ??= (async () => {
      if (!modelInstalled() || (await checkDone())) return
      // Taken after the await above and spawned in the same tick, so a job that started meanwhile wins.
      const run = deps.gate.runCheck((signal, exited) => runEngine('speech-check', ['--name', modelName()], undefined, signal, exited))
      if (!run) return
      try {
        const r = (await run) as {
          threads?: unknown
          runs?: unknown
          complete?: unknown
        } | null
        const threads = typeof r?.threads === 'number' && r.threads > 0 ? r.threads : null
        // Cut short by its time budget (a busy computer): use what it found now, but don't keep it, so it runs again
        // on a later start. Seen 2026-10-21: one 7 s run at 8 threads, 4 never tried.
        const complete = r?.complete !== false
        if (complete) await deps.saveCheck({ machine: thisMachine(), threads })
        deps.useThreads(threads)
        log(`[model] speech check: ${threads ?? 'usual'} thread(s)${complete ? '' : ' (cut short, not saved)'} ${JSON.stringify(r?.runs ?? [])}`)
      } catch (e) {
        const err = toUserError(e)
        if (err.code === 'CANCELLED') return // a video started; try again on a later start
        // A failure that would repeat: main's thread count (the engine's own rule), saved so it doesn't run again here.
        log(`[model] speech check failed: ${err.code} ${err.message ?? ''}`)
        await deps.saveCheck({ machine: thisMachine(), threads: null }).catch(() => undefined)
        deps.useThreads(null)
        set({ checkFailed: true })
      }
    })()
      .catch((e) => log(`[model] speech check: ${String(e)}`))
      .finally(() => (timing = null))
    return timing
  }

  async function findOnComputer(): Promise<ModelStatus> {
    const pin = pinnedModel()
    if (modelInstalled() || !pin) return state
    const dest = join(modelsDir(), modelName())
    const copies = await findCachedCopies(hfHubCache(), pin)
    for (const src of copies) {
      set({ checking: true, pct: 0, error: null })
      try {
        if (existsSync(join(dest, '.fake')) && engineMode() === 'real') await fs.rm(dest, { recursive: true, force: true })
        const t0 = Date.now()
        const r = await adoptCopy(src, dest, pin.files, (b) => set({ pct: Math.floor((b / total()) * 100) }))
        if (r.ok && modelInstalled()) {
          log(`[model] reused ${src} (verified in ${Date.now() - t0} ms)`)
          void checkInBackground()
          return set({ checking: false, installed: true, reused: true, pct: 100 })
        }
        log(`[model] not using ${src}: ${r.ok ? 'incomplete' : `${r.file} ${r.reason}`}`)
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code
        log(`[model] could not copy ${src}: ${String(e)}`)
        if (code === 'ENOSPC')
          return set({ checking: false, pct: 0, error: "There isn't enough free space for the listening model. Free up about 500 MB, then try again." })
      }
    }
    return set({ checking: false, pct: 0 })
  }

  return {
    status(): ModelStatus {
      state = { ...state, name: modelName(), installed: modelInstalled(), total: total() }
      return state
    },
    find(): Promise<ModelStatus> {
      finding ??= findOnComputer().finally(() => (finding = null))
      return finding
    },
    async download(): Promise<ModelStatus> {
      await this.find()
      if (modelInstalled()) return set({ installed: true, downloading: false, pct: 100, error: null })
      if (download) return state
      const dir = join(modelsDir(), modelName())
      if (existsSync(join(dir, '.fake')) && engineMode() === 'real') await fs.rm(dir, { recursive: true, force: true })
      download = new AbortController()
      set({ downloading: true, error: null, pct: 0, bytes: 0 })
      try {
        // The engine's percent is bytes / total of the pinned files, so it converts back to MB exactly.
        await runEngine('download-model', ['--name', modelName()], (p) => set({ pct: Math.round(p.pct), bytes: Math.round((p.pct / 100) * total()) }), download.signal)
        void checkInBackground()
        return set({ installed: modelInstalled(), downloading: false, pct: 100, bytes: total() })
      } catch (e) {
        const err = toUserError(e)
        return set({ downloading: false, error: err.code === 'CANCELLED' ? null : err.userMessage })
      } finally {
        download = null
      }
    },
    cancel(): void {
      download?.abort()
    },
    checkInBackground,
    async savedThreads(): Promise<number | null> {
      const r = await deps.loadCheck()
      return r?.machine === thisMachine() ? r.threads : null
    }
  }
}
