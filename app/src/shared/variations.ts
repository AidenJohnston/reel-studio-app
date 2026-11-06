// Versions to compare, made from Cut > Pace: one at each pace, or three sets of moments at the reel's pace. Each is
// a hand edit that sets only the reel's pace and seed (project.json cutStyle), so two of them differ in that alone,
// and the seed in its version's project.json makes it again byte for byte (engine variation.py resolve). They queue
// like any hand edit and become versions in a row, which Compare plays one against the other. No Node or DOM imports.
import type { ProjectJson } from './api'
import { nextSeed, PACE_LABELS, type CutPreset } from './cut-style'
import type { HandEdit } from './hand-edit'

export type VariationKind = 'paces' | 'moments'

/** The paces offered side by side. Punchline is left out: it changes the picture only on punchlines the editor
 * marks, so next to the others it reads as "nothing happened" on a reel the editor has not marked. */
const PACES: CutPreset[] = ['clean', 'standard', 'hyper']
const MOMENT_SETS = 3

export interface Variation {
  edit: HandEdit
  /** The version's line in the notes, with its seed so it can be told apart and made again. */
  summary: string
}

const paceEdit = (preset: CutPreset, seed: number): HandEdit => ({
  set: [{ path: ['cutStyle'], value: { preset, seed } }],
  items: [],
  words: { cut: [], keep: [] },
  mirror: [],
  joins: []
})

/** The hand edits for `kind`, from the reel as it is. `paces`: one at each pace other than the reel's own. `moments`:
 * three new seeds at the reel's pace, none the reel's own; null when the reel has no pace to vary. */
export function variations(p: Pick<ProjectJson, 'cutStyle'>, kind: VariationKind, random: () => number = Math.random): Variation[] | null {
  const own = p.cutStyle
  if (kind === 'paces') {
    return PACES.filter((preset) => preset !== own?.preset).map((preset) => {
      const seed = nextSeed(undefined, random)
      return { edit: paceEdit(preset, seed), summary: `Variation: ${PACE_LABELS[preset]} pace (seed ${seed})` }
    })
  }
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
