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
 * project at another file). */
export function mergeSourcesPatch(current: Sources | undefined, patch: unknown): Sources {
  const cur = current ?? []
  if (!Array.isArray(patch)) return cur
  const want = new Map<string, boolean>()
  for (const x of patch) {
    if (x && typeof x === 'object' && typeof (x as any).id === 'string') want.set((x as any).id, (x as any).mirror === true)
  }
  return cur.map((s) => {
    if (!want.has(s.id)) return s
    const { mirror: _old, ...rest } = s
    return want.get(s.id) ? { ...rest, mirror: true } : rest
  })
}
