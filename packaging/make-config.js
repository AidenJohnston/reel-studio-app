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
