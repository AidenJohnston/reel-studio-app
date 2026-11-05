#!/usr/bin/env node
// Resolve packaging/electron-builder.yml into an absolute-path config.
//
// electron-builder joins a relative-looking `from:` (which `${env.X}/...` is, before expansion) onto the project
// directory, and does not expand ${env.X} in `afterPack` at all, so the template cannot hold absolute paths via
// env vars directly. This script substitutes every ${env.RS_*} with its value (forward slashes, which are valid
// on Windows too) and writes packaging/.build/electron-builder.resolved.yml. The build scripts run it, then pass
// the printed path to `electron-builder --config`.
//
// Windows code signing is optional. With RS_WIN_SIGN=1 the script also puts `azureSignOptions` (Azure Artifact
// Signing, formerly Trusted Signing) into the `win:` mapping, from RS_AZURE_ENDPOINT, RS_AZURE_ACCOUNT (code signing
// account name), RS_AZURE_PROFILE (certificate profile name) and RS_AZURE_PUBLISHER (the certificate's subject), and
// refuses if one of them is missing. Without RS_WIN_SIGN the build is unsigned, exactly as before. The credentials
// (AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET) never reach this file: the TrustedSigning module reads them
// from the environment itself. See packaging/README.md, "Signing the Windows build".
//
//   node packaging/make-config.js            -> prints the path of the resolved file
//
// The release channel comes from app/package.json's version alone (app/src/shared/channel.ts NIGHTLY_VERSION). A
// nightly (`x.y.z-nightly.YYYYMMDD.N`) is its own app beside the stable one: its own name (so its own userData folder),
// appId (on Windows the NSIS uninstall GUID is derived from it, so a shared ID would let the nightly replace the
// stable install), package name (the Windows install folder and electron-updater's cache folder), icons and
// artifact names.
const fs = require('fs')
const path = require('path')

const SHARED = path.join(__dirname, '..', 'app', 'src', 'shared')

/** NIGHTLY_VERSION from shared/channel.ts, the one place the format lives. */
function nightlyPattern() {
  const m = fs.readFileSync(path.join(SHARED, 'channel.ts'), 'utf8').match(/export const NIGHTLY_VERSION = \/(.+)\/\n/)
  if (!m) throw new Error('make-config: NIGHTLY_VERSION not found in app/src/shared/channel.ts')
  return new RegExp(m[1])
}

/** Everything that differs between the stable app and the nightly, for one version string. */
function channelConfig(version) {
  if (!nightlyPattern().test(version)) {
    return { channel: 'stable', overrides: [], icons: 'packaging/icons' }
  }
  const overrides = [
    'appId: dev.reelstudio.app.nightly',
    'productName: Reel Studio (Nightly)',
    'extraMetadata:',
    '  name: reel-studio-nightly',
    '  productName: Reel Studio (Nightly)',
    'dmg.artifactName: Reel-Studio-Nightly-${version}-${arch}.${ext}',
    'dmg.background: ${env.RS_REPO_ROOT}/packaging/.build/dmg-nightly/background.tiff',
    'nsis.artifactName: Reel-Studio-Nightly-Setup-${version}-${arch}.${ext}'
  ]
  return { channel: 'nightly', overrides, icons: 'packaging/icons/nightly' }
}

/** Applies `key: value` and `a.b: value` overrides to the YAML template's top-level keys and their direct children. */
function applyOverrides(yaml, overrides) {
  let out = yaml
  for (let i = 0; i < overrides.length; i++) {
    const line = overrides[i]
    const [, key, value] = line.match(/^([\w.]+):\s*(.*)$/) ?? []
    if (!key) throw new Error(`make-config: bad override ${line}`)
    if (key === 'extraMetadata') {
      const block = []
      while (overrides[i + 1]?.startsWith('  ')) block.push(overrides[++i])
      const re = /^extraMetadata:\n(?:  .*\n)+/m
      if (!re.test(out)) throw new Error('make-config: extraMetadata block not found in electron-builder.yml')
      out = out.replace(re, `extraMetadata:\n${block.join('\n')}\n`)
      continue
    }
    const [parent, child] = key.includes('.') ? key.split('.') : [null, key]
    const re = parent
      ? new RegExp(`(^${parent}:\\n(?:(?:  .*|\\s*)\\n)*?  ${child}:) .*$`, 'm')
      : new RegExp(`(^${child}:) .*$`, 'm')
    if (!re.test(out)) throw new Error(`make-config: ${key} not found in electron-builder.yml`)
    out = out.replace(re, (_m, head) => `${head} ${value}`)
  }
  return out
}

module.exports = { channelConfig, applyOverrides }
if (require.main !== module) return

const here = __dirname
const version = JSON.parse(fs.readFileSync(path.join(here, '..', 'app', 'package.json'), 'utf8')).version
const ch = channelConfig(version)
const src = applyOverrides(fs.readFileSync(path.join(here, 'electron-builder.yml'), 'utf8'), ch.overrides)
// RS_ICONS: the channel's icon folder (the app, Dock and installer icons)
const vars = { ...process.env, RS_ICONS: path.join(here, '..', ch.icons) }
const missing = []
let out = src.replace(/\$\{env\.(RS_[A-Z_]+)\}/g, (_m, name) => {
  const v = vars[name]
  if (!v) { missing.push(name); return '' }
  return v.replace(/[\\]/g, '/')
})
if (missing.length) {
  console.error('make-config: these environment variables must be set: ' + [...new Set(missing)].join(', '))
  process.exit(1)
}
if (process.env.RS_WIN_SIGN === '1') {
  // Option names: app-builder-lib 26.15.3, out/options/winOptions.d.ts (WindowsAzureSigningConfiguration).
  const fields = {
    RS_AZURE_ENDPOINT: 'endpoint',
    RS_AZURE_ACCOUNT: 'codeSigningAccountName',
    RS_AZURE_PROFILE: 'certificateProfileName',
    RS_AZURE_PUBLISHER: 'publisherName'
  }
  const absent = Object.keys(fields).filter((name) => !process.env[name])
  if (absent.length) {
    console.error('make-config: RS_WIN_SIGN=1 needs these environment variables: ' + absent.join(', '))
    process.exit(1)
  }
  // The template already has a top-level `win:` mapping and YAML forbids a second one, so the block goes inside it.
  const marker = /^win:[ \t]*\r?\n/m
  if (!marker.test(out)) {
    console.error('make-config: electron-builder.yml has no top-level `win:` mapping to put azureSignOptions into')
    process.exit(1)
  }
  const lines = Object.entries(fields).map(([name, key]) => `    ${key}: ${JSON.stringify(process.env[name])}`)
  out = out.replace(marker, (m) =>
    m + '  # Azure Artifact Signing (RS_WIN_SIGN=1): the app .exe, the uninstaller and the installer\n' +
    '  azureSignOptions:\n' + lines.join('\n') + '\n')
}
const afterPack = path.join(here, 'after-pack.js').replace(/[\\]/g, '/')
out += `\nafterPack: ${afterPack}\n`
const dir = path.join(here, '.build')
fs.mkdirSync(dir, { recursive: true })
const file = path.join(dir, 'electron-builder.resolved.yml')
fs.writeFileSync(file, out)
process.stdout.write(file + '\n')
