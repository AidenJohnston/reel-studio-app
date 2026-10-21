// A note asked "at a moment" (the change button under the player) carries its time in its own text:
// "At 0:14: cut this part". The note path has no time field, and the AI already reads the text
// (ai/src/editor.ts turns the prefix into the words said there). The marks on the scrub bar are read
// back from the chat. Keep this file free of Node and DOM imports (it is unit-tested).
import type { ChatMessage } from './api'
import { clock } from './progress'

const MOMENT = /^At (\d+):([0-5]\d): /

export function momentNote(seconds: number, text: string): string {
  return `At ${clock(seconds)}: ${text}`
}

/** Seconds into the reel a note points at, or null for a note about the whole reel. */
export function noteMoment(text: string): number | null {
  const m = MOMENT.exec(text)
  return m ? Number(m[1]) * 60 + Number(m[2]) : null
}

export type MarkState = 'making' | 'done' | 'failed'

export interface NoteMark {
  id: string
  at: number
  /** what was asked, without the "At 0:14: " prefix */
  text: string
  state: MarkState
}

const BUSIEST_FIRST: MarkState[] = ['making', 'failed', 'done']

/** Marks drawn closer than `minPx` on a `trackPx`-wide bar share one target; it shows its busiest state. */
export function groupMarks(marks: NoteMark[], duration: number, trackPx: number, minPx = 24): { at: number; state: MarkState; items: NoteMark[] }[] {
  const groups: { at: number; state: MarkState; items: NoteMark[] }[] = []
  for (const m of [...marks].sort((a, b) => a.at - b.at)) {
    const last = groups[groups.length - 1]
    if (!last || ((m.at - last.at) / duration) * trackPx >= minPx) {
      groups.push({ at: m.at, state: m.state, items: [m] })
      continue
    }
    last.items.push(m)
    if (BUSIEST_FIRST.indexOf(m.state) < BUSIEST_FIRST.indexOf(last.state)) last.state = m.state
  }
  return groups
}

/**
 * One mark per moment note. Done: the editor's reply came with a new version. Failed: the reply
 * made no new version (an error, "I was not sure what to change"), or there is no reply and nothing
 * is running (stopped). Making: the last note, while a job runs.
 */
export function noteMarks(chat: ChatMessage[], running: boolean): NoteMark[] {
  const marks: NoteMark[] = []
  let newest = 0
  chat.forEach((m, i) => {
    if (m.from === 'editor') newest = Math.max(newest, m.version ?? 0)
    if (m.from !== 'you') return
    const at = noteMoment(m.text)
    if (at === null) return
    const rest = chat.slice(i + 1)
    const reply = rest.find((r) => r.from === 'editor')
    const state: MarkState = reply
      ? (reply.version ?? 0) > newest
        ? 'done'
        : 'failed'
      : running && !rest.some((r) => r.from === 'you')
        ? 'making'
        : 'failed'
    marks.push({ id: m.id, at, text: m.text.replace(MOMENT, ''), state })
  })
  return marks
}
