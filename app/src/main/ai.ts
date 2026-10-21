// Loads @reelstudio/ai when it is installed, else the mock with the same interface.
import type { AI, CreateAIOptions, ProjectOwner } from './ai-types'
import { createMockAI } from './ai-mock'

/** Without the AI package (a dev build that has not built it) nothing holds the project's lock file:
 * each engine command takes the project for itself while it runs (engine/reelengine/owner.py). */
const unlocked = async (): Promise<ProjectOwner> => ({ token: null, release: async () => undefined })

export async function loadAI(
  opts: CreateAIOptions,
  log: (s: string) => void
): Promise<{ ai: AI; source: 'package' | 'mock'; ownProject: (projectDir: string) => Promise<ProjectOwner> }> {
  let mod: any = null
  try {
    const name = '@reelstudio/ai'
    mod = await import(/* @vite-ignore */ name)
  } catch (e) {
    log(`[ai] @reelstudio/ai not available (${(e as Error).message?.split('\n')[0]}), using the mock`)
  }
  const ownProject = typeof mod?.ownProject === 'function' ? mod.ownProject : unlocked
  if (process.env.REELSTUDIO_MOCK_AI === '1') return { ai: createMockAI(opts), source: 'mock', ownProject }
  const createAI = mod?.createAI ?? mod?.default?.createAI
  if (typeof createAI === 'function') return { ai: createAI(opts) as AI, source: 'package', ownProject }
  if (mod) log('[ai] @reelstudio/ai has no createAI export, using the mock')
  return { ai: createMockAI(opts), source: 'mock', ownProject }
}
