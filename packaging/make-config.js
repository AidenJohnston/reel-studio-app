#!/usr/bin/env node
// Resolve packaging/electron-builder.yml into an absolute-path config.
//
// electron-builder joins a relative-looking `from:` (which `${env.X}/...` is, before expansion) onto the project
// directory, and does not expand ${env.X} in `afterPack` at all, so the template cannot hold absolute paths via
// env vars directly. This script substitutes every ${env.RS_*} with its value (forward slashes, which are valid
// on Windows too) and writes packaging/.build/electron-builder.resolved.yml. The build scripts run it, then pass
// the printed path to `electron-builder --config`.
//
//   node packaging/make-config.js            -> prints the path of the resolved file
const fs = require('fs')
const path = require('path')

const here = __dirname
const src = fs.readFileSync(path.join(here, 'electron-builder.yml'), 'utf8')
const missing = []
let out = src.replace(/\$\{env\.(RS_[A-Z_]+)\}/g, (_m, name) => {
  const v = process.env[name]
  if (!v) { missing.push(name); return '' }
  return v.replace(/[\\]/g, '/')
})
if (missing.length) {
  console.error('make-config: these environment variables must be set: ' + [...new Set(missing)].join(', '))
  process.exit(1)
}
const repo = fs.readFileSync(path.join(here, '..', 'app', 'src', 'shared', 'config.ts'), 'utf8').match(/RELEASES_REPO = '([^/']+)\/([^']+)'/)
if (!repo) {
  console.error('make-config: RELEASES_REPO not found in app/src/shared/config.ts')
  process.exit(1)
}
out += `\npublish:\n  provider: github\n  owner: ${repo[1]}\n  repo: ${repo[2]}\n  releaseType: release\n`
const afterPack = path.join(here, 'after-pack.js').replace(/[\\]/g, '/')
out += `\nafterPack: ${afterPack}\n`
const dir = path.join(here, '.build')
fs.mkdirSync(dir, { recursive: true })
const file = path.join(dir, 'electron-builder.resolved.yml')
fs.writeFileSync(file, out)
process.stdout.write(file + '\n')
