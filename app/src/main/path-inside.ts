import { isAbsolute, relative, sep } from 'node:path'

/**
 * Whether `child` is `parent` or inside it, compared by whole path parts. A prefix check is wrong twice: a sibling
 * whose name starts the same ("Library backup" next to "Library") passes it, and a drive root (E:\, /) never
 * matches root + separator. Both paths should already be resolved the same way (realpath, or resolve, on each).
 */
export function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel))
}
