import { promises as fs } from 'node:fs'
import { resolve, sep } from 'node:path'

/** Staging is private even through a symlink inside an otherwise allowed media root. */
export async function allowStagingMedia(file: string, activeRoots: () => string[]): Promise<boolean> {
  const real = await fs.realpath(file).catch(() => file)
  if (![file, real].some((p) => p.split(sep).includes('.staging'))) return true
  const roots = activeRoots()
  for (const root of roots) {
    const resolved = resolve(root)
    const canonical = await fs.realpath(resolved).catch(() => resolved)
    if (real.startsWith(canonical + sep) && activeRoots().includes(root)) return true
  }
  return false
}
