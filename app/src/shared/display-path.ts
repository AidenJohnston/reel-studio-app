// "Documents › Reel Studio" instead of C:\Users\USERNA~1\Documents\Reel Studio. Keep free of Node and DOM imports.

function parts(p: string): string[] {
  return p.split(/[\\/]+/).filter(Boolean)
}

function under(path: string[], base: string[], caseless: boolean): boolean {
  if (base.length === 0 || path.length < base.length) return false
  return base.every((b, i) => (caseless ? b.toLowerCase() === path[i].toLowerCase() : b === path[i]))
}

/** A friendly name for a folder: relative to Documents, Desktop or home when it is inside one of them. */
export function displayPath(path: string, places: { documents?: string; desktop?: string; home?: string }, platform: string): string {
  const caseless = platform === 'win32' || platform === 'darwin'
  const p = parts(path)
  const named: [string | undefined, string][] = [
    [places.documents, 'Documents'],
    [places.desktop, 'Desktop'],
    [places.home, 'Home']
  ]
  for (const [base, label] of named) {
    if (!base) continue
    const b = parts(base)
    if (under(p, b, caseless)) return [label, ...p.slice(b.length)].join(' › ')
  }
  return p.join(' › ')
}
