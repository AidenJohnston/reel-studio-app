import type { ChatMessage } from './api'

/**
 * One line per version saying what changed, for the version menu: "First edit" for Version 1; for a
 * change made by hand, what it was ("Version 3: new song." becomes "New song"); for an AI edit, the
 * note that asked for it, in the person's own words.
 *
 * Only the first editor message tagged with a version announces it. A later reply can carry the same
 * number without having made it (a note answered without a new render keeps the current version). A
 * change made by hand is announced in the main process's own words (describe.ts versionMessage), so it
 * is never credited to a note, even one that was stopped and so got no reply.
 */
export function versionChanges(chat: ChatMessage[]): Map<number, string> {
  const out = new Map<number, string>()
  let note: string | null = null
  for (const m of chat) {
    if (m.from === 'you') {
      note = m.text.trim() || null
      continue
    }
    const v = m.version
    if (v !== undefined && !out.has(v)) out.set(v, v === 1 ? 'First edit' : (byHand(m.text, v) ?? (note ? `“${note}”` : m.text.trim())))
    note = null
  }
  return out
}

/** What a change made by hand was, from "Version 3: new song." ("" for "Version 3 is ready."); null for an AI reply. */
function byHand(text: string, v: number): string | null {
  const t = text.trim()
  if (t === `Version ${v} is ready.`) return ''
  const m = new RegExp(`^Version ${v}: (.+?)\\.?$`, 's').exec(t)
  return m ? m[1].charAt(0).toUpperCase() + m[1].slice(1) : null
}
