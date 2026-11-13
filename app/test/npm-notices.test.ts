import { expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// packaging/licenses/npm-licenses.txt (written by packaging/gen_npm_notices.py) must name exactly the npm packages,
// at the versions, that ship. What ships is worked out here from package-lock.json the way Node resolves a require: a
// package can carry a nested copy at another version than the top-level one (electron-updater's semver 7.7.4 beside
// a dev-only 7.8.5). The lock's own dev flags are not used.
const repo = resolve(__dirname, '../..')
type Entry = { version?: string; link?: boolean; resolved?: string; dev?: boolean; dependencies?: Record<string, string>; optionalDependencies?: Record<string, string>; peerDependencies?: Record<string, string>; peerDependenciesMeta?: Record<string, { optional?: boolean }> }
const lock = JSON.parse(readFileSync(resolve(repo, 'package-lock.json'), 'utf8')).packages as Record<string, Entry>
// The front-end libraries vite bundles into the window (devDependencies, but they ship).
const BUNDLED = ['react', 'react-dom', 'scheduler']

/** The lock path Node would load `name` from, for a package at lock path `from` ('' is the repo root). */
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

/** The packages the app loads at run time, lock path to name: the workspaces' production dependencies, followed. */
function runtime(): Map<string, string> {
  const seen = new Map<string, string>()
  const queue = ['app', 'ai'] // the workspaces; only their production dependencies ship
  while (queue.length) {
    const at = queue.pop()!
    const { dependencies, optionalDependencies, peerDependencies, peerDependenciesMeta } = lock[at]
    for (const name of Object.keys({ ...dependencies, ...optionalDependencies, ...peerDependencies })) {
      const path = locate(name, at)
      // a missing optional peer isn't installed, so nothing loads it
      if (path === null && peerDependenciesMeta?.[name]?.optional) continue
      if (path === null || seen.has(path)) continue
      seen.set(path, name)
      queue.push(path)
    }
  }
  return seen
}

function shipped(): Set<string> {
  const out = new Set<string>()
  for (const [path, name] of runtime()) if (!name.startsWith('@reelstudio/')) out.add(`${name} ${lock[path].version}`)
  for (const name of BUNDLED) out.add(`${name} ${lock[locate(name, 'app')!].version}`)
  return out
}

function noticed(): Set<string> {
  const lines = readFileSync(resolve(repo, 'packaging/licenses/npm-licenses.txt'), 'utf8').split(/\r?\n/)
  const out = new Set<string>()
  lines.forEach((line, i) => {
    const head = line === '='.repeat(78) ? /^(\S+) (\S+) {2}\(/.exec(lines[i + 1] ?? '') : null
    if (head) out.add(`${head[1]} ${head[2]}`)
  })
  return out
}

it('fails if the npm licence notices miss a shipped package version or name one that does not ship', () => {
  const ships = shipped()
  const notices = noticed()
  expect([...notices].filter((n) => !ships.has(n)).sort()).toEqual([])
  expect([...ships].filter((n) => !notices.has(n)).sort()).toEqual([])
})

it('fails if package-lock.json marks a package the app loads at run time as dev-only', () => {
  // electron-builder collects the app's node_modules by asking npm for production and optional packages, omitting
  // dev ones, so a dev flag here leaves the package out and electron-updater fails to load in the packaged app.
  // (devOptional is kept by that omit, so only dev counts.)
  const devOnly = [...runtime().keys()].filter((path) => lock[path].dev)
  expect(devOnly.sort()).toEqual([])
})
