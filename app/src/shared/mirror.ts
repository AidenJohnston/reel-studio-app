// A mirrored take (front camera: wall text and shirts read backwards) is flipped by the engine when
// `sources[].mirror` is true. The "Edit it myself" drawer has a toggle for it, so people without an
// AI can flip too. Keep free of Node and DOM imports.
import type { ProjectJson } from './api'

type Sources = NonNullable<ProjectJson['sources']>

/** The toggle's state: on only when EVERY take is flipped (a mixed project shows off; turning it on flips them all). */
export function isMirrored(p: Pick<ProjectJson, 'sources'>): boolean {
  const s = p.sources ?? []
  return s.length > 0 && s.every((x) => x.mirror === true)
}

/** Every take flipped (on) or back as filmed (off: the flag is removed, so the project matches an old one). */
export function withMirror(sources: Sources | undefined, on: boolean): Sources {
  return (sources ?? []).map((s) => {
    const { mirror: _old, ...rest } = s
    return on ? { ...rest, mirror: true } : rest
  })
}

/** What `projects:update` takes from a `sources` patch: ONLY the mirror flag of takes the project
 * already has. Paths, sizes and ids stay as the engine wrote them (a patch can never point the
 * project at another file). A take the import check looked at keeps the user's choice in
 * `mirrorCheck.answer`, as the chat buttons do (`answerMirror`), so nothing undoes or asks it again. */
export function mergeSourcesPatch(current: Sources | undefined, patch: unknown): Sources {
  const cur = current ?? []
  if (!Array.isArray(patch)) return cur
  const want = new Map<string, boolean>()
  for (const x of patch) {
    if (x && typeof x === 'object' && typeof (x as any).id === 'string') want.set((x as any).id, (x as any).mirror === true)
  }
  return cur.map((s) => {
    const on = want.get(s.id)
    if (on === undefined || on === (s.mirror === true)) return s
    const { mirror: _old, ...rest } = s
    const out = s.mirrorCheck ? { ...rest, mirrorCheck: { ...s.mirrorCheck, answer: on ? ('flipped' as const) : ('undone' as const) } } : rest
    return on ? { ...out, mirror: true } : out
  })
}

// ---- the check `engine init` runs on every new take (engine/reelengine/mirror_detect.py) ----------
// A clearly mirrored take comes in flipped (`mirror: true`) and the editor says so in the chat, with a
// one-click undo. A take that only looks somewhat mirrored is left alone and the editor asks instead.
// Each question carries the ids of the takes it is about (ChatMessage.sources), and its buttons act on
// those takes only. Once the user has answered, only their own tap changes that take again: the AI
// editor never flips it (ai set_mirror), it can only make the app ask (`declinedQuestion`).

/** The buttons under those chat lines. */
export type MirrorAnswer = 'mirror-undo' | 'mirror-flip' | 'mirror-keep'
export const MIRROR_ANSWERS: readonly MirrorAnswer[] = ['mirror-undo', 'mirror-flip', 'mirror-keep']

/** A chat line about some takes, and the ids of those takes. */
export interface MirrorQuestion {
  text: string
  actions: MirrorAnswer[]
  sources: string[]
}

type Source = Sources[number]
const autoFlipped = (s: Source): boolean => s.mirrorCheck?.verdict === 'mirrored' && s.mirror === true && !s.mirrorCheck.answer
const askable = (s: Source): boolean => s.mirrorCheck?.verdict === 'maybe-mirrored' && s.mirror !== true && !s.mirrorCheck.answer

/** "your video" / "your videos" when it is every take, otherwise "take 2" / "take 1 and take 3"; and
 * the pronoun that goes with it. */
function whichTakes(all: Sources, hit: Sources): { what: string; it: string } {
  const it = hit.length > 1 ? 'they' : 'it'
  if (hit.length === all.length) return { what: hit.length > 1 ? 'your videos' : 'your video', it }
  const names = hit.map((s) => `take ${all.indexOf(s) + 1}`)
  return { what: names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0], it }
}

const capital = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)
const ids = (hit: Sources): string[] => hit.map((s) => s.id)

/** The editor's chat lines once init has looked at the takes: what it flipped and why, with "Undo flip",
 * and what it is unsure about, with "Flip it" / "Keep as filmed". Empty when there is nothing to say. */
export function mirrorNotices(sources: Sources | undefined): MirrorQuestion[] {
  const all = sources ?? []
  const out: MirrorQuestion[] = []
  const flipped = all.filter(autoFlipped)
  if (flipped.length) {
    const w = whichTakes(all, flipped)
    const why = flipped[0].mirrorCheck?.why ?? 'the writing behind you reads backwards'
    out.push({ text: `I flipped ${w.what}: ${w.it} looked mirrored (${why}).`, actions: ['mirror-undo'], sources: ids(flipped) })
  }
  const asked = all.filter(askable)
  if (asked.length) {
    const w = whichTakes(all, asked)
    const why = asked[0].mirrorCheck?.why ?? 'some writing behind you seems to read backwards'
    out.push({
      text: `${capital(w.what)} ${asked.length > 1 ? 'look' : 'looks'} mirrored (${why}). Flip ${w.it === 'they' ? 'them' : 'it'}?`,
      actions: ['mirror-flip', 'mirror-keep'],
      sources: ids(asked)
    })
  }
  return out
}

/** The editor's question when the AI wanted to flip takes the user had said are the right way round
 * (AgentResult.mirrorDeclined): the AI may not, so the user decides with one tap. Null when none of
 * those takes is still as filmed. */
export function declinedQuestion(sources: Sources | undefined, declined: string[] | undefined): MirrorQuestion | null {
  const all = sources ?? []
  const hit = all.filter((s) => declined?.includes(s.id) && s.mirror !== true)
  if (!hit.length) return null
  const w = whichTakes(all, hit)
  return {
    text: `It still looks mirrored to me (some writing behind you seems to read backwards), so I left ${w.what} the way you chose. Flip ${w.it === 'they' ? 'them' : 'it'}?`,
    actions: ['mirror-flip', 'mirror-keep'],
    sources: ids(hit)
  }
}

/** One of those buttons, for the takes its question is about (`ids`), with the answer kept in
 * `mirrorCheck.answer`. `change` = what to call a new version (empty when the picture did not change);
 * `reply` = the editor's answer in the chat, null when those takes were already changed another way
 * (the "Flip picture" switch, or Undo in What I did). */
export function answerMirror(sources: Sources | undefined, a: MirrorAnswer, ids: string[]): { sources: Sources; change: string; reply: string | null } {
  const cur = sources ?? []
  const hit = (s: Source): boolean => ids.includes(s.id) && !!s.mirrorCheck && (a === 'mirror-undo' ? s.mirror === true : s.mirror !== true)
  if (!cur.some(hit)) return { sources: cur, change: '', reply: null }
  const answer = a === 'mirror-undo' ? 'undone' : a === 'mirror-flip' ? 'flipped' : 'kept'
  const next = cur.map((s) => {
    if (!hit(s)) return s
    const { mirror: _old, ...rest } = s
    const out = { ...rest, mirrorCheck: { ...s.mirrorCheck!, answer } } as Source
    return a === 'mirror-flip' ? { ...out, mirror: true } : out
  })
  if (a === 'mirror-undo') return { sources: next, change: 'picture back the way you filmed it', reply: 'Done: it is back the way you filmed it.' }
  if (a === 'mirror-flip') return { sources: next, change: 'flipped the picture', reply: 'Flipped. The writing behind you reads the right way now.' }
  return { sources: next, change: '', reply: 'OK, I left it the way you filmed it.' }
}
