// The one-time speech model download. The engine does the work (`download-model`, resumable);
// the app checks whether it is there and shows progress.
import { existsSync, promises as fs } from 'node:fs'
import { join } from 'node:path'
import { engineMode, modelsDir } from './paths'
import type { ModelStatus } from '../shared/api'
import { toUserError, type RunEngine } from './engine'

// Must match the engine's transcribe.DEFAULT_MODEL (or set REELENGINE_MODEL for both).
export const modelName = (): string => process.env.REELENGINE_MODEL || 'small.en'

/** Same rule as the engine's transcribe.model_present(). */
export function modelInstalled(dir = join(modelsDir(), modelName())): boolean {
  if (existsSync(join(dir, '.fake')) && engineMode() === 'real') return false
  return (
    existsSync(join(dir, 'model.bin')) &&
    existsSync(join(dir, 'config.json')) &&
    ['tokenizer.json', 'vocabulary.txt', 'vocabulary.json'].some((f) => existsSync(join(dir, f)))
  )
}

export function createModelManager(runEngine: RunEngine, onChange: (s: ModelStatus) => void) {
  let state: ModelStatus = { name: modelName(), installed: false, downloading: false, pct: 0, bytes: 0, total: 0, error: null }
  let abort: AbortController | null = null

  const set = (patch: Partial<ModelStatus>): ModelStatus => {
    state = { ...state, ...patch }
    onChange(state)
    return state
  }

  return {
    status(): ModelStatus {
      state = { ...state, name: modelName(), installed: modelInstalled() }
      return state
    },
    async download(): Promise<ModelStatus> {
      if (modelInstalled()) return set({ installed: true, downloading: false, pct: 100, error: null })
      if (abort) return state
      const dir = join(modelsDir(), modelName())
      if (existsSync(join(dir, '.fake')) && engineMode() === 'real') await fs.rm(dir, { recursive: true, force: true })
      abort = new AbortController()
      set({ downloading: true, error: null, pct: 0 })
      try {
        await runEngine('download-model', ['--name', modelName()], (p) => set({ pct: Math.round(p.pct) }), abort.signal)
        return set({ installed: modelInstalled(), downloading: false, pct: 100 })
      } catch (e) {
        const err = toUserError(e)
        return set({ downloading: false, error: err.code === 'CANCELLED' ? null : err.userMessage })
      } finally {
        abort = null
      }
    },
    cancel(): void {
      abort?.abort()
    }
  }
}
