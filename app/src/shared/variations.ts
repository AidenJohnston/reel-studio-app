// Versions to compare: each changes one thing in the reel and nothing else, so two of them can be played against each
// other with Compare. They are hand edits like any made in "Edit it myself", queued and made into versions in a row.
//   paces      one version at each pace other than the reel's own (cutStyle, a new seed each)
//   moments    three new seeds at the reel's pace
//   brightness one 8% brighter and one 8% darker (exposure; the steps engine variation.py allows for a trial)
//   hook       the reel opens on its second sentence: the first one is cut
//   cover      another cover frame
// A different post caption is not a version: the engine leaves post text out of what makes a video (project.py
// edit_signature), so it is tried at posting instead, as Share > Try 2. Each version's line in the notes says what it
// changed, with the seed for a pace so it can be made again (engine variation.py resolve). No Node or DOM imports.
import type { ProjectJson, Word } from './api'
import { keptIds } from './cut'
import { nextSeed, PACE_LABELS, type CutPreset } from './cut-style'
import type { HandEdit } from './hand-edit'
import { clock } from './progress'

export type VariationKind = 'paces' | 'moments' | 'brightness' | 'hook' | 'cover'

/** The paces offered side by side. Punchline is left out: it changes the picture only on punchlines the editor
 * marks, so next to the others it reads as "nothing happened" on a reel the editor has not marked. */
const PACES: CutPreset[] = ['clean', 'standard', 'hyper']
const MOMENT_SETS = 3
/** variation.py make_variant's brightness trial: +8% or -8% exposure. */
const BRIGHTNESS_STEP = 0.08
/** The exposure a reel can have (project.schema.json, shared/hand-edit.ts): a step past either end is not offered. */
const EXPOSURE = { min: 0.125, max: 8 }
/** A first sentence longer than this many words is not an opening line to drop; nor is a reel that would keep fewer. */
const MAX_OPENING_WORDS = 30
const MIN_WORDS_LEFT = 8
/** Another cover is at least this far from the one the reel has, so the two read as different moments. */
const MIN_COVER_GAP = 2

export interface Variation {
  edit: HandEdit
  /** The version's line in the notes: what it changed, with a pace's seed so it can be made again. */
  summary: string
}

type Reel = Pick<ProjectJson, 'cutStyle' | 'cut' | 'cover'> & { exposure?: number }

const edit = (part: Partial<HandEdit>): HandEdit => ({ set: [], items: [], words: { cut: [], keep: [] }, mirror: [], joins: [], ...part })
const paceEdit = (preset: CutPreset, seed: number): HandEdit => edit({ set: [{ path: ['cutStyle'], value: { preset, seed } }] })
const round = (n: number) => Math.round(n * 1e6) / 1e6

/** The kept words, in the order the reel plays them. */
function kept(p: Reel, words: Word[]): Word[] {
  const byId = new Map(words.map((w) => [w.id, w]))
  return keptIds(words, p.cut?.keep).map((id) => byId.get(id)!).filter(Boolean)
}

/** The hand edits for `kind`, from the reel as it is; null when this reel can't vary that way (no pace to vary, no
 * second sentence to open on, no other moment for a cover). */
export function variations(p: Reel, kind: VariationKind, words: Word[] = [], random: () => number = Math.random): Variation[] | null {
  const own = p.cutStyle
  switch (kind) {
    case 'paces':
      return PACES.filter((preset) => preset !== own?.preset).map((preset) => {
        const seed = nextSeed(undefined, random)
        return { edit: paceEdit(preset, seed), summary: `Variation: ${PACE_LABELS[preset]} pace (seed ${seed})` }
      })
    case 'moments': {
      if (!own) return null
      const seeds: number[] = []
      while (seeds.length < MOMENT_SETS) {
        const seed = nextSeed(own.seed, random)
        if (!seeds.includes(seed)) seeds.push(seed)
      }
      return seeds.map((seed, i) => ({
        edit: paceEdit(own.preset, seed),
        summary: `Variation: ${PACE_LABELS[own.preset]} pace, moments ${i + 1} of ${MOMENT_SETS} (seed ${seed})`
      }))
    }
    case 'brightness': {
      const base = p.exposure ?? 1
      const list = [1, -1]
        .map((sign) => ({ sign, value: round(base * (1 + sign * BRIGHTNESS_STEP)) }))
        .filter(({ value }) => value >= EXPOSURE.min && value <= EXPOSURE.max)
        .map(({ sign, value }) => ({
          edit: edit({ set: [{ path: ['exposure'], value }] }),
          summary: `Variation: ${Math.round(BRIGHTNESS_STEP * 100)}% ${sign > 0 ? 'brighter' : 'darker'}`
        }))
      return list.length ? list : null
    }
    case 'hook': {
      const said = kept(p, words)
      const end = said.findIndex((w, i) => i < MAX_OPENING_WORDS && /[.!?]["”’)]?$/.test(w.w))
      if (end < 0 || said.length - (end + 1) < MIN_WORDS_LEFT) return null
      const opens = said.slice(end + 1, end + 7).map((w) => w.w).join(' ')
      return [{ edit: edit({ words: { cut: said.slice(0, end + 1).map((w) => w.id), keep: [] } }), summary: `Variation: opens on “${opens}…”` }]
    }
    case 'cover': {
      const said = kept(p, words)
      const at = p.cover?.atSourceTime
      const source = p.cover?.source ?? said[0]?.source
      // a word start (the face mid-line) two thirds in, else a third, five sixths or a sixth in: the first of those far
      // enough from the cover the reel has
      const from = said.filter((w) => !w.source || w.source === source)
      const w = [2 / 3, 1 / 3, 5 / 6, 1 / 6].map((f) => from[Math.floor(from.length * f)])
        .find((x) => x && (at === undefined || Math.abs(x.s - at) >= MIN_COVER_GAP))
      if (!w || !source) return null
      return [{
        edit: edit({ set: [{ path: ['cover', 'atSourceTime'], value: round(w.s) }, { path: ['cover', 'source'], value: source }] }),
        summary: `Variation: cover at ${clock(w.s)} of the take`
      }]
    }
  }
}

/** Whether this reel can vary that way: the button for `kind` shows only then. */
export function canVary(p: Reel, kind: VariationKind, words: Word[]): boolean {
  if (kind === 'paces') return true
  if (kind === 'moments') return !!p.cutStyle
  return variations(p, kind, words) !== null
}
