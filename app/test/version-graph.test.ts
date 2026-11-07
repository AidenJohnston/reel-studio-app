// The version tree's layout (shared/version-graph.ts): which lane each version sits in and where its lines run.
import { describe, expect, it } from 'vitest'
import { versionGraph, type GraphVersion } from '../src/shared/version-graph'

const chain = (n: number): GraphVersion[] => Array.from({ length: n }, (_, i) => ({ n: i + 1, parent: i ? i : null }))
const lanes = (vs: GraphVersion[]) => versionGraph(vs).map((r) => [r.n, r.lane])

describe('version tree layout', () => {
  it('a reel that never branched is one straight line, newest first', () => {
    const rows = versionGraph(chain(3))
    expect(rows.map((r) => [r.n, r.lane, r.above, r.into, r.below, r.from])).toEqual([
      [3, 0, [], [], [0], [0]],
      [2, 0, [0], [0], [0], [0]],
      [1, 0, [0], [0], [], []]
    ])
    expect(rows[0].width).toBe(1)
  })

  it('two versions made from Version 2 sit side by side, and both lines meet at Version 2', () => {
    const rows = versionGraph([...chain(2), { n: 3, parent: 2 }, { n: 4, parent: 2 }])
    expect(rows.map((r) => [r.n, r.lane])).toEqual([[4, 0], [3, 1], [2, 0], [1, 0]])
    const two = rows.find((r) => r.n === 2)!
    expect(two.into).toEqual([0, 1])
    expect(two.below).toEqual([0])
    expect(rows[0].width).toBe(2)
  })

  it('a combined version has a line to each parent, and the tree closes back to one line under them', () => {
    const vs: GraphVersion[] = [...chain(2), { n: 3, parent: 2 }, { n: 4, parent: 2 }, { n: 5, parent: 3, parents: [3, 4] }]
    const rows = versionGraph(vs)
    expect(rows[0]).toMatchObject({ n: 5, lane: 0, from: [0, 1], below: [0, 1] })
    expect(lanes(vs)).toEqual([[5, 0], [4, 1], [3, 0], [2, 0], [1, 0]])
    expect(rows.find((r) => r.n === 2)).toMatchObject({ into: [0, 1], below: [0] })
  })

  it('a lane freed by a branch that ended is used again rather than widening the tree', () => {
    // 3 branches from 1 and ends; 5 branches from 4 later
    const vs: GraphVersion[] = [{ n: 1, parent: null }, { n: 2, parent: 1 }, { n: 3, parent: 1 }, { n: 4, parent: 2 }, { n: 5, parent: 4 }, { n: 6, parent: 4 }]
    expect(versionGraph(vs)[0].width).toBe(2)
  })

  it('a parent whose folder is gone ends the line instead of drawing to nowhere', () => {
    const rows = versionGraph([{ n: 1, parent: null }, { n: 3, parent: 2 }])
    expect(rows[0]).toMatchObject({ n: 3, from: [], below: [] })
    expect(rows[1]).toMatchObject({ n: 1, above: [], lane: 0 })
  })
})
