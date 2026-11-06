// My style › Your niche: the saved niche in <Reel Studio root>/My niche.json, and the short chat with the editor that
// drafts one (ai niche.ts nicheTurn). Nothing is saved until the person presses Save.
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { writeJson } from './store'
import { NICHE_FILE, NICHE_OPENER, checkNiche, nicheFileData, readNicheFile, type NicheTurn, type SavedNiche } from '../shared/niche'
import type { AI } from './ai-types'

type Handle = (channel: string, fn: (event: unknown, ...args: any[]) => unknown) => void
/** A chat longer than this is not a two-minute chat; the page starts over before it gets there. */
const MAX_TURNS = 24
const MAX_WORDS = 2000

/** The chat's turns from the page, checked: who said it, and text of a sane size. */
export function checkTurns(v: unknown): NicheTurn[] {
  const bad = { code: 'BAD_ARGS', userMessage: 'That chat could not be read. Start it again.' }
  if (!Array.isArray(v) || !v.length || v.length > MAX_TURNS) throw bad
  return v.map((t) => {
    if (!t || typeof t !== 'object' || (t.from !== 'you' && t.from !== 'editor') || typeof t.text !== 'string' || !t.text.trim() || t.text.length > MAX_WORDS) throw bad
    return { from: t.from, text: t.text.trim(), ...(t.kind === 'question' || t.kind === 'niche' ? { kind: t.kind } : {}) }
  })
}

export function registerNicheIpc(d: {
  handle: Handle
  root: () => string
  /** the AI in use now: it is loaded after the handlers are registered, and the person can switch editors */
  ai: () => Pick<AI, 'active' | 'nicheTurn'>
  /** the editor's waits while it answers ("Waiting for Claude to answer") */
  status: (s: { message: string; waiting?: boolean }) => void
  log: (line: string) => void
}): void {
  const file = (): string => join(d.root(), NICHE_FILE)
  let asking: AbortController | null = null

  async function read(): Promise<{ niche: SavedNiche | null; damaged: boolean }> {
    let text: string
    try {
      text = await fs.readFile(file(), 'utf8')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { niche: null, damaged: false }
      throw e
    }
    const n = readNicheFile(text)
    return n === 'damaged' ? { niche: null, damaged: true } : { niche: n, damaged: false }
  }

  d.handle('niche:get', () => read())
  d.handle('niche:save', async (_e, niche: unknown, from: unknown) => {
    const saved: SavedNiche = { ...checkNiche(niche), savedAt: new Date().toISOString(), from: from === 'chat' ? 'chat' : 'typed' }
    await fs.mkdir(d.root(), { recursive: true })
    await writeJson(file(), nicheFileData(saved))
    return saved
  })
  // the page keeps what was removed, for Undo (it saves it again)
  d.handle('niche:remove', async () => {
    await fs.rm(file(), { force: true })
  })
  // `asked`: questions the editor has asked, past the app's own opener
  d.handle('niche:say', async (_e, turns: unknown, asked: unknown, draft: unknown) => {
    const checked = checkTurns(turns)
    if (checked[checked.length - 1].from !== 'you') throw { code: 'BAD_ARGS', userMessage: 'Say something first.' }
    const ai = d.ai()
    if (!ai.nicheTurn) throw { code: 'NOT_READY', userMessage: 'This version of the editor cannot help with a niche. Write it yourself instead.' }
    const active = await ai.active().catch(() => null)
    if (!active?.connected || active.id === 'none') throw { code: 'NO_AI', userMessage: 'Connect an editor to find your niche together, or write it yourself.' }
    if (asking) throw { code: 'BUSY', userMessage: 'Your editor is still answering. Wait for it, or press Stop.' }
    const controller = new AbortController()
    asking = controller
    try {
      const opener: NicheTurn = { from: 'editor', text: NICHE_OPENER, kind: 'question' }
      return await ai.nicheTurn(
        { turns: [opener, ...checked], asked: Number.isInteger(asked) ? Math.max(0, asked as number) : 0, niche: draft == null ? null : checkNiche(draft) },
        (e) => {
          if (e.type === 'status' && e.message) d.status({ message: e.message, ...(e.waiting ? { waiting: true } : {}) })
        },
        controller.signal
      )
    } finally {
      if (asking === controller) asking = null
    }
  })
  d.handle('niche:stop', () => {
    asking?.abort()
    asking = null
  })
}

