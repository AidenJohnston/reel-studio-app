// The versions of a reel drawn as a tree, newest at the top, as `git log --graph` draws commits. Each version sits in
// a lane (a column); a line runs down from it to its parent, and a version made by combining two has a second line to
// its other parent. Lanes are reused once free, so a reel that never branched is one straight line. Keep free of Node
// and DOM imports.

export interface GraphVersion {
  n: number
  /** the version it was made from (versions/vN/version.json); null for Version 1 */
  parent: number | null
  /** a combined version's two parents, `parent` first */
  parents?: [number, number]
}

export interface GraphRow {
  n: number
  /** the lane its dot is in */
  lane: number
  /** lanes with a line coming in from the row above */
  above: number[]
  /** of those, the lanes whose line ends at this dot (versions made from this one) */
  into: number[]
  /** lanes with a line going on to the row below */
  below: number[]
  /** of those, the lanes whose line starts at this dot (to this version's parents) */
  from: number[]
  /** lanes in use anywhere in the tree, for its width */
  width: number
}

/** Rows newest first. A parent that is not in the list (a version folder removed by hand) ends its line here. */
export function versionGraph(versions: GraphVersion[]): GraphRow[] {
  const known = new Set(versions.map((v) => v.n))
  const sorted = [...versions].sort((a, b) => b.n - a.n)
  // what each lane is waiting for: the version number its line runs down to, or null when free
  const lanes: (number | null)[] = []
  const free = (): number => {
    const i = lanes.indexOf(null)
    return i >= 0 ? i : lanes.push(null) - 1
  }
  const rows: Omit<GraphRow, 'width'>[] = []
  for (const v of sorted) {
    const above = lanes.flatMap((t, i) => (t === null ? [] : [i]))
    const into = above.filter((i) => lanes[i] === v.n)
    const lane = into.length ? into[0] : free()
    for (const i of into) lanes[i] = null
    const parents = (v.parents ?? (v.parent !== null ? [v.parent] : [])).filter((p) => known.has(p) && p < v.n)
    // each parent gets a line of its own; lines to the same parent meet at its dot (`into`), as git draws them
    const from: number[] = []
    for (const [k, p] of parents.entries()) {
      const at = k === 0 ? lane : free()
      lanes[at] = p
      from.push(at)
    }
    const below = lanes.flatMap((t, i) => (t === null ? [] : [i]))
    rows.push({ n: v.n, lane, above, into, below, from: from.sort((a, b) => a - b) })
  }
  const width = Math.max(1, ...rows.flatMap((r) => [r.lane + 1, ...r.above.map((i) => i + 1), ...r.below.map((i) => i + 1)]))
  return rows.map((r) => ({ ...r, width }))
}
