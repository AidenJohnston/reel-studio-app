// How each cut plays, as "Edit it myself" shows and changes it (shared/joins.ts), and how a join survives the
// drawer's other changes (shared/cut.ts, shared/hand-edit.ts). Each case has one right answer.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { validateProject, withDefaults } from '../../ai/src/project'
import type { JSONSchema } from '../../ai/src/schema'
import { TOOLS } from '../../ai/src/tools'
import type { ProjectJson, Word } from '../src/shared/api'
import { keptIds, rangesKeepingOrder } from '../src/shared/cut'
import { applyHandEdit, countChanges, diffProject, parseHandEdit } from '../src/shared/hand-edit'
import { cutRows, joinProblem, TRANSITIONS, withJoin } from '../src/shared/joins'

const schema = JSON.parse(readFileSync(join(__dirname, '../../engine/reelengine/schema/project.schema.json'), 'utf8'))
const words: Word[] = ['so', 'my', 'cat', 'Biscuit', 'sits', 'here', 'then', 'fold', 'it', 'up'].map((w, i) => ({ id: `w${i + 1}`, w, s: i, e: i + 0.8, source: 's1' }))
const J = { transition: 'j' as const, frames: 8 }
const MATCH = { transition: 'match' as const, frames: 0 }

function project(keep: NonNullable<ProjectJson['cut']>['keep']): ProjectJson {
  return { schemaVersion: 1, id: 'p', title: 't', slug: 't', createdAt: '', updatedAt: '', version: 1, sources: [{ id: 's1', path: 'raw.mov' }], cut: { keep } }
}
const kept = (p: ProjectJson) => new Set(keptIds(words, p.cut?.keep))

it('fails if the drawer offers a transition the AI and the engine refuse, or misses one they take', () => {
  expect([...TRANSITIONS].sort()).toEqual([...schema.$defs.join.properties.transition.enum].sort())
  const setCut = (TOOLS.find((t) => t.name === 'set_cut')!.parameters as JSONSchema).properties.keep.items.properties.join
  expect([...TRANSITIONS].sort()).toEqual([...(setCut.anyOf ?? [setCut]).find((s: JSONSchema) => s.properties)!.properties.transition.enum].sort())
})

it("fails if the drawer accepts a join the AI's project validation refuses, or refuses one it accepts", () => {
  const p = withDefaults({ id: 'p', title: 't', slug: 't' })
  const cases: unknown[] = [MATCH, J, { transition: 'smash', frames: 0 }, { transition: 'dissolve', frames: 0 }, { transition: 'j', frames: -1 },
    { transition: 'l', frames: 1.5 }, { transition: 'j' }, null, 'match']
  for (const j of cases) {
    const ai = validateProject({ ...p, cut: { keep: [{ from: 'w1', to: 'w2' }, { from: 'w4', to: 'w5', join: j }] } }).find((x) => x.startsWith('cut.keep[1].join')) ?? null
    expect(joinProblem(j, 1), JSON.stringify(j)).toBe(ai && ai.replace('cut.keep[1].join: ', ''))
  }
})

describe('the cuts the drawer lists', () => {
  it('fails if a range the take runs straight into is listed as a cut, or a real cut is missed', () => {
    const rows = cutRows(words, [{ from: 'w1', to: 'w3' }, { from: 'w4', to: 'w5' }, { from: 'w8', to: 'w10', join: J }])
    expect(rows.map((r) => [r.at, r.index, r.transition])).toEqual([['w8', 2, 'j']])
    expect(rows[0].before).toBe('Biscuit sits')
  })

  it('fails if a join lands on another cut, or one is put on the first range', () => {
    const keep = [{ from: 'w1', to: 'w2' }, { from: 'w4', to: 'w5' }, { from: 'w7', to: 'w8', join: J }]
    expect(withJoin(keep, 'w4', MATCH)).toEqual([keep[0], { from: 'w4', to: 'w5', join: MATCH }, keep[2]])
    expect(withJoin(keep, 'w7', null)).toEqual([keep[0], keep[1], { from: 'w7', to: 'w8' }])
    expect(withJoin(keep, 'w1', J)).toEqual(keep)
  })
})

describe('joins through the drawer', () => {
  it('fails if cutting a word by hand turns the joins the editor set back into plain cuts', () => {
    const keep = [{ from: 'w1', to: 'w3' }, { from: 'w5', to: 'w7', join: J }, { from: 'w9', to: 'w10', join: MATCH }]
    // strike "my" in the first range, and "sits" (the first word after the J cut)
    const now = new Set(keptIds(words, keep).filter((id) => id !== 'w2' && id !== 'w5'))
    expect(rangesKeepingOrder(words, keep, now)).toEqual([
      { from: 'w1', to: 'w1' },
      { from: 'w3', to: 'w3' },
      { from: 'w6', to: 'w7', join: J },
      { from: 'w9', to: 'w10', join: MATCH }
    ])
  })

  it('fails if a join stays on a cut that bringing words back has closed', () => {
    const keep = [{ from: 'w1', to: 'w3' }, { from: 'w5', to: 'w7', join: J }]
    expect(rangesKeepingOrder(words, keep, new Set(['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7']))).toEqual([{ from: 'w1', to: 'w7' }])
  })

  it('fails if a join picked on a cut the person just made is lost when the edit lands on a newer version', () => {
    const v1 = project([{ from: 'w1', to: 'w10' }])
    const now = new Set(keptIds(words, v1.cut!.keep).filter((id) => id !== 'w4' && id !== 'w5'))
    const edited = project(withJoin(rangesKeepingOrder(words, v1.cut!.keep, now), 'w6', J))
    const edit = diffProject(v1, edited, kept(v1), now)
    expect(edit.joins).toEqual([{ at: 'w6', join: J }])
    expect(countChanges(edit, words)).toBe(2) // the words cut, and the J cut
    // a note made Version 2 meanwhile and kept the whole take
    const out = applyHandEdit({ ...v1, version: 2 }, parseHandEdit(JSON.parse(JSON.stringify(edit))), words)
    expect(out.cut!.keep).toEqual([{ from: 'w1', to: 'w3' }, { from: 'w6', to: 'w10', join: J }])
    expect(out.version).toBe(2)
  })

  it('fails if setting a cut back to plain leaves its old join', () => {
    const v1 = project([{ from: 'w1', to: 'w2' }, { from: 'w5', to: 'w6', join: MATCH }])
    const edited = project([{ from: 'w1', to: 'w2' }, { from: 'w5', to: 'w6' }])
    const edit = diffProject(v1, edited, kept(v1), kept(v1))
    expect(edit.joins).toEqual([{ at: 'w5', join: null }])
    expect(applyHandEdit(v1, edit, words).cut!.keep).toEqual(edited.cut!.keep)
  })

  it('fails if an edit queued before joins existed no longer applies, or a bad join gets past main', () => {
    const old = { set: [], items: [], words: { cut: ['w3'], keep: [] }, mirror: [] }
    const p = project([{ from: 'w1', to: 'w10' }])
    expect(applyHandEdit(p, old as never, words).cut!.keep).toEqual([{ from: 'w1', to: 'w2' }, { from: 'w4', to: 'w10' }])
    expect(parseHandEdit(old).joins).toEqual([])
    expect(() => parseHandEdit({ ...old, joins: [{ at: 'w4', join: { transition: 'dissolve', frames: 0 } }] })).toThrow()
    expect(() => parseHandEdit({ ...old, joins: [{ at: 4, join: null }] })).toThrow()
  })
})
