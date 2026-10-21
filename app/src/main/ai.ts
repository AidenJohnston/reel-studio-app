// Loads @reelstudio/ai when it is installed, else the mock with the same interface.
import type { AI, CreateAIOptions } from './ai-types'
import { promises as fs } from 'node:fs'
import { join, resolve } from 'node:path'
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

interface NoteSupport {
  withProjectLock<T>(dir: string, fn: () => Promise<T>): Promise<T>
  recoverNoteStaging(dir: string): Promise<void>
}

let support: Promise<NoteSupport | null> | undefined
function loadSupport(): Promise<NoteSupport | null> {
  return support ??= (async () => {
    try {
      const name = '@reelstudio/ai'
      const mod = await import(/* @vite-ignore */ name)
      const lock = mod.withProjectLock ?? mod.default?.withProjectLock
      const recover = mod.recoverNoteStaging ?? mod.default?.recoverNoteStaging
      if (typeof lock === 'function' && typeof recover === 'function') {
        return { withProjectLock: lock, recoverNoteStaging: recover }
      }
    } catch { /* Package-absent development mode still needs local edit serialization. */ }
    return null
  })()
}

const localLocks = new Map<string, Promise<unknown>>()
export async function withProjectLock<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const ai = await loadSupport()
  if (ai) return ai.withProjectLock(dir, fn)
  const key = resolve(dir)
  const run = (localLocks.get(key) ?? Promise.resolve()).then(fn)
  const tail = run.catch(() => undefined)
  localLocks.set(key, tail)
  void tail.then(() => { if (localLocks.get(key) === tail) localLocks.delete(key) })
  return run
}

export async function recoverNoteStaging(dir: string): Promise<void> {
  const ai = await loadSupport()
  if (ai) return ai.recoverNoteStaging(dir)
  await withProjectLock(dir, async () => {
    await fs.rm(join(dir, '.staging'), { recursive: true, force: true })
    let project: unknown
    try { project = JSON.parse(await fs.readFile(join(dir, 'project.json'), 'utf8')) }
    catch { return }
    if (!project || typeof project !== 'object') return
    const version = 'version' in project ? project.version : 0
    if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 0) return
    let versions: string[]
    try { versions = await fs.readdir(join(dir, 'versions')) }
    catch (e) { if (e instanceof Error && 'code' in e && e.code === 'ENOENT') return; throw e }
    for (const name of versions) {
      if (/^v\d+$/.test(name) && Number(name.slice(1)) > version) {
        await fs.rm(join(dir, 'versions', name), { recursive: true, force: true })
      }
    }
  })
}
