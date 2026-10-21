// Files outside the allowed folders that the reel-media: protocol may still serve: the targets of
// symlinks the person put in their own Library. Keyed by the Library entry, so listing it again
// replaces its target, and checked again on every request, so a deleted or re-pointed link stops
// serving its old target.
import { promises as fs } from 'node:fs'

const linked = new Map<string, string>() // Library entry path -> its resolved target

export function allowLinkedMedia(entry: string, target: string): void {
  linked.set(entry, target)
}

/** Whether `realPath` is the current target of a listed Library link. Entries that no longer are drop out. */
export async function isLinkedMedia(realPath: string): Promise<boolean> {
  let ok = false
  for (const [entry, target] of linked) {
    if (target !== realPath) continue
    const still = (await fs.lstat(entry).catch(() => null))?.isSymbolicLink() && (await fs.realpath(entry).catch(() => null)) === target
    if (still) ok = true
    else linked.delete(entry)
  }
  return ok
}
