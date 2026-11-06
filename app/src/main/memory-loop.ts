// The learning loop: My style suggests memories the person keeps, edits or turns down. Two sources feed it:
// post results (the AI package's learn(), which pairs a trial's two posts) and the person's own hand edits, read
// here. A hand edit says what the person wanted more plainly than any model can, but one reel is a choice for that
// reel; the same change by hand in two or more reels, never the other way in any, is a habit worth asking about.
// Nothing is saved as a rule until the person keeps it (StyleStore.accept).
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { PACE_LABELS } from '../shared/cut-style'
import type { CutPreset } from '../shared/cut-style'

/** The same change, by hand, in at least this many reels. Two is the smallest number that is a repeat; there is no
 * evidence for a better one, and a suggestion costs the person one click to turn down. */
export const MIN_REELS = 2

/** What learning drafts: the AI package's ProposalDraft (ai/src/style.ts), from hand edits. */
export interface EditDraft {
  kind: 'captions' | 'pacing' | 'music'
  line: string
  text: string
  from: { kind: 'edits'; reels: string[]; n: number; evidence: string }
}

/** One version the person made by hand, and the version it changed. */
export interface HandPair {
  reel: string
  title: string
  before: unknown
  after: unknown
}

type Vote = { setting: string; way: string }

const obj = (v: unknown): Record<string, any> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : {})
const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)
// The engine's defaults when a project leaves them out (captions.py DEFAULT_SIZE, tools.ts set_caption_style)
const DEFAULT_SIZE = 105
const DEFAULT_WORDS = 3
// quietest first: the engine's levels (music.py LEVELS)
const MUSIC_ORDER = ['quiet', 'under-voice', 'loud-intro']

/** The whole-reel settings one hand edit changed, as directions. A change too small to see is not a vote. */
export function votes(beforeRaw: unknown, afterRaw: unknown): Vote[] {
  const b = obj(beforeRaw)
  const a = obj(afterRaw)
  const bc = obj(b.captions)
  const ac = obj(a.captions)
  const out: Vote[] = []
  const bOn = bc.enabled !== false
  const aOn = ac.enabled !== false
  if (bOn && !aOn) out.push({ setting: 'subtitles', way: 'off' })
  if (bOn && aOn) {
    const bs = num(obj(bc.style).size, DEFAULT_SIZE)
    const as = num(obj(ac.style).size, DEFAULT_SIZE)
    // under 5% is a nudge, not a size the person keeps choosing
    if (Math.abs(as - bs) >= bs * 0.05) out.push({ setting: 'size', way: as > bs ? 'up' : 'down' })
    const bw = num(obj(bc.style).maxWords, DEFAULT_WORDS)
    const aw = num(obj(ac.style).maxWords, DEFAULT_WORDS)
    if (aw !== bw) out.push({ setting: 'words', way: aw > bw ? 'up' : 'down' })
  }
  const bl = MUSIC_ORDER.indexOf(String(obj(b.music).level ?? 'under-voice'))
  const al = MUSIC_ORDER.indexOf(String(obj(a.music).level ?? 'under-voice'))
  if (obj(a.music).track && bl >= 0 && al >= 0 && al !== bl) out.push({ setting: 'music', way: al < bl ? 'quieter' : 'louder' })
  const bp = obj(b.cutStyle).preset
  const ap = obj(a.cutStyle).preset
  if (typeof ap === 'string' && ap in PACE_LABELS && ap !== bp) out.push({ setting: 'pace', way: ap })
  return out
}

const WORDS: Record<string, Record<string, { kind: EditDraft['kind']; text: string; did: string }>> = {
  subtitles: { off: { kind: 'captions', text: 'Leave subtitles off.', did: 'turned the subtitles off' } },
  size: {
    up: { kind: 'captions', text: 'Use bigger subtitles.', did: 'made the subtitles bigger' },
    down: { kind: 'captions', text: 'Use smaller subtitles.', did: 'made the subtitles smaller' }
  },
  words: {
    down: { kind: 'captions', text: 'Show fewer words in each subtitle.', did: 'put fewer words in each subtitle' },
    up: { kind: 'captions', text: 'Show more words in each subtitle.', did: 'put more words in each subtitle' }
  },
  music: {
    quieter: { kind: 'music', text: 'Keep the music quieter under my voice.', did: 'turned the music down' },
    louder: { kind: 'music', text: 'Make the music louder.', did: 'turned the music up' }
  },
  pace: Object.fromEntries(
    (Object.keys(PACE_LABELS) as CutPreset[]).map((p) => [p, { kind: 'pacing' as const, text: `Cut my reels at the ${PACE_LABELS[p]} pace.`, did: `picked the ${PACE_LABELS[p]} pace` }])
  )
}

/** Habits in the person's hand edits: one draft per setting changed the same way in MIN_REELS or more reels and
 * the other way in none. Each reel counts once per setting, however many hand edits it had. */
export function editDrafts(pairs: HandPair[]): EditDraft[] {
  const ways = new Map<string, Map<string, Set<string>>>()
  const titles = new Map<string, string>()
  for (const p of pairs) {
    titles.set(p.reel, p.title)
    for (const v of votes(p.before, p.after)) {
      const bySetting = ways.get(v.setting) ?? new Map<string, Set<string>>()
      ways.set(v.setting, bySetting)
      bySetting.set(v.way, (bySetting.get(v.way) ?? new Set()).add(p.reel))
    }
  }
  const out: EditDraft[] = []
  for (const [setting, byWay] of [...ways].sort(([a], [b]) => a.localeCompare(b))) {
    // a reel that went both ways, or any reel that went another way, means there is no one habit
    if (byWay.size !== 1) continue
    const [[way, reels]] = [...byWay]
    const w = WORDS[setting]?.[way]
    if (!w || reels.size < MIN_REELS) continue
    const list = [...reels].sort()
    const named = list.slice(0, 2).map((r) => `“${titles.get(r) || r}”`).join(' and ')
    const more = list.length > 2 ? ` and ${list.length - 2} more` : ''
    out.push({
      kind: w.kind, line: w.text.replace(/\.$/, ''), text: w.text,
      from: { kind: 'edits', reels: list, n: list.length, evidence: `You ${w.did} by hand in ${list.length} reels: ${named}${more}.` }
    })
  }
  return out
}

const readJson = async (file: string): Promise<any> => JSON.parse((await fs.readFile(file, 'utf8')).replace(/^﻿/, ''))

/** Every version made by hand (app.json versionsMade) with the version it changed (version.json parent). A reel or
 * version whose files can't be read is skipped: learning never stops on one damaged folder. */
export async function handPairs(projectsRoot: string): Promise<HandPair[]> {
  const slugs = await fs.readdir(projectsRoot).catch(() => [] as string[])
  const out: HandPair[] = []
  for (const slug of slugs.sort()) {
    const dir = join(projectsRoot, slug)
    const app = await readJson(join(dir, 'app.json')).catch(() => null)
    const made: unknown[] = Array.isArray(app?.versionsMade) ? app.versionsMade : []
    const title = await readJson(join(dir, 'project.json')).then((p) => String(p?.title ?? ''), () => '')
    for (const m of made) {
      const r = obj(m)
      if (r.by !== 'hand' || !Number.isSafeInteger(r.version)) continue
      const vdir = join(dir, 'versions', `v${r.version}`)
      const parent = await readJson(join(vdir, 'version.json')).then((v) => v?.parent, () => null)
      if (!Number.isSafeInteger(parent) || parent < 1) continue
      try {
        out.push({ reel: slug, title, before: await readJson(join(dir, 'versions', `v${parent}`, 'project.json')), after: await readJson(join(vdir, 'project.json')) })
      } catch {
        /* a version folder removed by hand: nothing to learn from it */
      }
    }
  }
  return out
}

/** What the loop needs from the AI package (or the mock). */
export interface MemoryAI {
  learnFromResults?(): Promise<unknown[]>
  proposeMemory?(draft: unknown): Promise<string>
}

let running: Promise<void> | null = null

/** Drafts memories from post results and hand edits and keeps the new ones waiting in My style. Runs each time My
 * style opens, never two at once. It reads small JSON files per reel and no media, so it needs no throttle; a throttle
 * hid a hand edit made just after a look (review). Fails soft: a damaged My style file or one bad reel never stops
 * the screen from opening. */
export function refreshMemories(ai: MemoryAI, projectsRoot: string, log: (m: string) => void): Promise<void> {
  if (running) return running
  if (!ai.proposeMemory) return Promise.resolve()
  running = (async () => {
    const fromResults = await ai.learnFromResults?.().catch((e) => (log(`[memory] results: ${String(e)}`), [])) ?? []
    const fromEdits = editDrafts(await handPairs(projectsRoot))
    for (const d of [...fromResults, ...fromEdits]) await ai.proposeMemory!(d).catch((e) => log(`[memory] propose: ${String(e)}`))
  })()
    .catch((e) => log(`[memory] refresh: ${String(e)}`))
    .finally(() => {
      running = null
    })
  return running
}
