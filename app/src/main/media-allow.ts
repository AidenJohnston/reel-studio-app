import { promises as fs } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import { BIN_FOLDERS, libraryDir } from './paths'

function inside(file: string, root: string): boolean {
  const rel = relative(root, file)
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel))
}

export async function isLinkedMedia(realPath: string, roots: string[]): Promise<boolean> {
  const library = await fs.realpath(libraryDir()).catch(() => null)
  if (library === null || !roots.some((root) => inside(library, root))) return false
  // Only direct Library bins grant access outside the root. Re-resolve each link on every request.
  for (const name of Object.values(BIN_FOLDERS)) {
    const bin = join(library, name)
    if (!(await fs.lstat(bin).catch(() => null))?.isSymbolicLink()) continue
    const target = await fs.realpath(bin).catch(() => null)
    if (target !== null && inside(realPath, target)) return true
  }
  return false
}
