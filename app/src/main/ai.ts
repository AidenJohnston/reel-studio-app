// Loads @reelstudio/ai when it is installed, else the mock with the same interface.
import type { AI, CreateAIOptions } from './ai-types'
import { createMockAI } from './ai-mock'

export async function loadAI(
  opts: CreateAIOptions,
  log: (s: string) => void
): Promise<{ ai: AI; source: 'package' | 'mock' }> {
  if (process.env.REELSTUDIO_MOCK_AI === '1') return { ai: createMockAI(opts), source: 'mock' }
  try {
    const name = '@reelstudio/ai'
    const mod = await import(/* @vite-ignore */ name)
    const createAI = mod.createAI ?? mod.default?.createAI
    if (typeof createAI === 'function') return { ai: createAI(opts) as AI, source: 'package' }
    log('[ai] @reelstudio/ai has no createAI export, using the mock')
  } catch (e) {
    log(`[ai] @reelstudio/ai not available (${(e as Error).message?.split('\n')[0]}), using the mock`)
  }
  return { ai: createMockAI(opts), source: 'mock' }
}
