// Names for the "Save to …" buttons, kept free of React and the DOM so it is unit-tested (test/cloud-drive.test.ts).
import type { CloudDrive } from './api'

// What tells two folders of one drive apart, in plain words: the drive letter on Windows ("G:"), the Google
// account on macOS (the part before "@", or the whole address when two accounts share that part), or else the
// folder's own name.
function detail(folder: string): { short: string; full: string } {
  const letter = folder.match(/^([A-Za-z]:)[\\/]My Drive$/)?.[1]
  if (letter) return { short: letter.toUpperCase(), full: letter.toUpperCase() }
  const parts = folder.split(/[\\/]+/).filter(Boolean)
  const account = parts.at(-1) === 'My Drive' ? parts.at(-2)?.match(/^GoogleDrive-(.+)$/)?.[1] : undefined
  if (account) return { short: account.split('@')[0], full: account }
  return { short: `${parts.at(-1)} folder`, full: folder }
}

/** "iCloud Drive", or "Google Drive (G:)" / "Google Drive (sam)" when there is more than one of that drive. */
export function driveNames(drives: CloudDrive[]): string[] {
  const details = drives.map((drive) => detail(drive.folder))
  return drives.map((drive, i) => {
    const others = drives.flatMap((other, j) => (j !== i && other.label === drive.label ? [details[j]] : []))
    if (!others.length) return drive.label
    const clash = others.some((other) => other.short === details[i].short)
    return `${drive.label} (${clash ? details[i].full : details[i].short})`
  })
}
