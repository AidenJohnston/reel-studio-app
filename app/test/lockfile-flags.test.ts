import { expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// electron-builder collects the app's node_modules by asking npm for production and optional packages and omitting
// dev ones, so a package the app loads at run time must not be marked dev in package-lock.json, or the packaged app
// fails to load it (electron-updater's debug, ms and graceful-fs were). What the app loads is worked out from the
// lock the way Node resolves a require, from the workspaces' production dependencies; the lock's flags aren't used.
type Entry = {
  link?: boolean
  resolved?: string
  dev?: boolean
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
}
const lock = JSON.parse(readFileSync(resolve(__dirname, '../../package-lock.json'), 'utf8')).packages as Record<string, Entry>

function locate(name: string, from: string): string | null {
  for (let at: string | null = from; at !== null; ) {
    const path = `${at ? `${at}/` : ''}node_modules/${name}`
    const entry = lock[path]
    if (entry) return entry.link ? entry.resolved! : path
    const up = at.lastIndexOf('/node_modules/')
    at = up >= 0 ? at.slice(0, up) : at ? '' : null
  }
  return null
}

it('fails if package-lock.json marks a package the app loads at run time as dev-only', () => {
  const seen = new Set<string>()
  const queue = ['app', 'ai']
  while (queue.length) {
    const at = queue.pop()!
    const { dependencies, optionalDependencies, peerDependencies } = lock[at]
    for (const name of Object.keys({ ...dependencies, ...optionalDependencies, ...peerDependencies })) {
      const path = locate(name, at)
      if (path === null || seen.has(path)) continue // a missing optional peer isn't installed
      seen.add(path)
      queue.push(path)
    }
  }
  expect([...seen].filter((path) => lock[path].dev).sort()).toEqual([])
})
