import { promises as fs } from 'node:fs'
import { dirname, sep } from 'node:path'

// A Library link grants access only while it still points to the registered file.
const linked = new Map<string, string>()

export function allowLinkedMedia(entry: string, target: string): void {
  linked.set(entry, target)
}

export async function isLinkedMedia(realPath: string, roots: string[]): Promise<boolean> {
  let ok = false
  for (const [entry, target] of linked) {
    if (target !== realPath) continue
    const parent = await fs.realpath(dirname(entry)).catch(() => null)
    const allowed = parent !== null && roots.some((root) => parent === root || parent.startsWith(root.endsWith(sep) ? root : root + sep))
    const still = allowed && (await fs.lstat(entry).catch(() => null))?.isSymbolicLink() && (await fs.realpath(entry).catch(() => null)) === target
    if (still) ok = true
    else linked.delete(entry)
  }
  return ok
}
