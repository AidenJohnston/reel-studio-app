// The pace and zoom-in kinds "Edit it myself" offers (shared/cut-style.ts) are hand-mirrored from the AI's tools and
// the engine. Each case fails when a copy drifts, so the drawer would offer a choice the AI's validation refuses, or
// miss one it accepts.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { CUT_STYLES } from '../../ai/src/cut-style'
import { validateProject, withDefaults } from '../../ai/src/project'
import { TOOLS } from '../../ai/src/tools'
import { CUT_PRESETS, cutStyleProblem, PACE_BANDS, withKind, ZOOM_KINDS, zoomProblem } from '../src/shared/cut-style'

const schema = JSON.parse(readFileSync(join(__dirname, '../../engine/reelengine/schema/project.schema.json'), 'utf8'))

it('fails if a pace or a zoom-in kind differs from the AI tools and the engine schema', () => {
  expect([...CUT_PRESETS].sort()).toEqual(Object.keys(CUT_STYLES).sort())
  expect([...CUT_PRESETS].sort()).toEqual([...schema.properties.cutStyle.properties.preset.enum].sort())
  for (const preset of CUT_PRESETS) {
    const { secondsPerVisualChange, beatAccents } = CUT_STYLES[preset]
    expect(PACE_BANDS[preset]).toEqual({ secondsPerVisualChange, beatAccents })
  }
  const setZoom = TOOLS.find((t) => t.name === 'set_zoom')!.parameters.properties.zooms.items.properties.kind
  expect([...ZOOM_KINDS].sort()).toEqual([...schema.properties.zooms.items.properties.kind.enum].sort())
  expect([...ZOOM_KINDS].sort()).toEqual([...setZoom.enum].filter((k: unknown) => k !== null).sort())
})

it("fails if the drawer accepts a pace the AI's project validation refuses, or refuses one it accepts", () => {
  const p = withDefaults({ id: 'p', title: 't', slug: 't' })
  const cases: unknown[] = [
    { preset: 'clean', seed: 0 }, { preset: 'punchline', seed: -4 }, { preset: 'standard', seed: 1.5 }, { preset: 'calm', seed: 1 },
    { preset: 'toString', seed: 1 }, { preset: 'hyper' }, { seed: 1 }, { preset: ['hyper'], seed: 1 }, null, 'hyper', []
  ]
  for (const style of cases) {
    const ai = validateProject({ ...p, cutStyle: style }).find((x) => x.startsWith('cutStyle')) ?? null
    expect(cutStyleProblem(style), JSON.stringify(style)).toBe(ai)
  }
})

it('fails if a zoom-in kind the engine refuses passes, or giving a zoom-in a kind changes how far it zooms', () => {
  expect(zoomProblem({ anchor: { from: 'w1', to: 'w2' }, kind: 'whip' })).not.toBeNull()
  expect(zoomProblem({ anchor: { from: 'w1' }, kind: 'snap' })).not.toBeNull()
  expect(zoomProblem({ anchor: { from: 'w1', to: 'w2' } })).toBeNull()
  // zoom.py: with no kind and no scale it zooms 1.12; a named kind would take the style's scale instead
  expect(withKind({ anchor: { from: 'w1', to: 'w2' }, style: 'snap' }, 'drift')).toEqual({ anchor: { from: 'w1', to: 'w2' }, scale: 1.12, kind: 'drift' })
  expect(withKind({ anchor: { from: 'w1', to: 'w2' }, kind: 'snap' }, 'punch')).toEqual({ anchor: { from: 'w1', to: 'w2' }, kind: 'punch' })
})
