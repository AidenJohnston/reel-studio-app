import { posix, win32 } from 'node:path'

/**
 * Whether `file` is `root` itself or somewhere inside it. On Windows the comparison ignores letter case, as NTFS
 * does: `C:\Users\Zoë\Documents` and `c:\users\zoë\documents` are the same folder, and different Windows APIs (a
 * typed folder, a file dialog, app.getPath) can return the same path in different case.
 */
export function isInsideFolder(file: string, root: string, platform: NodeJS.Platform = process.platform): boolean {
  const windows = platform === 'win32'
  const p = windows ? win32 : posix
  const fold = (s: string): string => (windows ? s.toLowerCase() : s)
  const f = fold(p.resolve(file))
  const r = fold(p.resolve(root))
  return f === r || f.startsWith(r.endsWith(p.sep) ? r : r + p.sep)
}
