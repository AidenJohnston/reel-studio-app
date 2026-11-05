import { expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// packaging/make-config.js resolves the electron-builder template. The build is unsigned unless RS_WIN_SIGN=1, and then
// the Azure Artifact Signing values must all be present and land inside the existing `win:` mapping.
const script = resolve(__dirname, '../../packaging/make-config.js')
const paths = {
  RS_REPO_ROOT: 'C:\\x\\repo',   // backslashes must come out as forward slashes
  RS_RUNTIME_DIR: '/x/runtime/win-x64',
  RS_ENGINE_DIR: '/x/engine',
  RS_TEMPLATES_DIR: '/x/templates',
  RS_APP_DIR: '/x/app'
}
const azure = {
  RS_AZURE_ENDPOINT: 'https://example.invalid',
  RS_AZURE_ACCOUNT: 'example-account',
  RS_AZURE_PROFILE: 'example-profile',
  RS_AZURE_PUBLISHER: 'CN=Example Publisher, O=Example Publisher, C=US'
}
const signingVars = ['RS_WIN_SIGN', ...Object.keys(azure)]

function run(env: Record<string, string>) {
  const full: NodeJS.ProcessEnv = { ...process.env, ...paths, ...env }
  for (const name of signingVars) if (!(name in env)) delete full[name]
  const r = spawnSync(process.execPath, [script], { env: full, encoding: 'utf8' })
  const file = r.stdout.trim()
  const yaml = r.status === 0 && existsSync(file) ? readFileSync(file, 'utf8').replace(/\r\n/g, '\n') : ''
  return { status: r.status, stderr: r.stderr, yaml }
}

it('resolves the template without signing when RS_WIN_SIGN is not set', () => {
  const r = run({})
  expect(r.status, r.stderr).toBe(0)
  expect(r.yaml).not.toMatch(/\$\{env\.RS_[A-Z_]+\}/)   // every placeholder substituted (the comments say `${env.RS_*}`)
  expect(r.yaml).toContain('from: C:/x/repo/packaging/fonts')
  expect(r.yaml).toMatch(/\nafterPack: .*packaging\/after-pack\.js\n/)
  expect(r.yaml).not.toMatch(/^\s*azureSignOptions:/m)   // the template's comments may mention the option; no key
})

it('ignores the Azure values unless RS_WIN_SIGN is exactly 1', () => {
  const r = run({ RS_WIN_SIGN: '0', ...azure })
  expect(r.status, r.stderr).toBe(0)
  expect(r.yaml).not.toMatch(/^\s*azureSignOptions:/m)
  expect(r.yaml).not.toContain('example-account')
})

it('puts win.azureSignOptions into the existing win mapping with RS_WIN_SIGN=1', () => {
  const r = run({ RS_WIN_SIGN: '1', ...azure, AZURE_CLIENT_SECRET: 'never-in-the-config' })
  expect(r.status, r.stderr).toBe(0)
  expect(r.yaml.match(/^win:/gm)).toHaveLength(1)   // a second top-level `win:` would be a YAML duplicate key
  expect(r.yaml).toMatch(new RegExp(
    '\\nwin:\\n(?:  #.*\\n)*' +
    '  azureSignOptions:\\n' +
    '    endpoint: "https://example\\.invalid"\\n' +
    '    codeSigningAccountName: "example-account"\\n' +
    '    certificateProfileName: "example-profile"\\n' +
    '    publisherName: "CN=Example Publisher, O=Example Publisher, C=US"\\n' +
    '  icon: C:/x/repo/packaging/icons/icon\\.ico\\n'))
  expect(r.yaml).not.toContain('never-in-the-config')
})

it('refuses RS_WIN_SIGN=1 with a missing Azure value and names every missing one', () => {
  const r = run({ RS_WIN_SIGN: '1', RS_AZURE_ENDPOINT: azure.RS_AZURE_ENDPOINT })
  expect(r.status).toBe(1)
  expect(r.stderr).toContain('RS_WIN_SIGN=1 needs these environment variables: RS_AZURE_ACCOUNT, RS_AZURE_PROFILE, RS_AZURE_PUBLISHER')
})

it('still refuses a missing path variable', () => {
  const full: NodeJS.ProcessEnv = { ...process.env, ...paths }
  delete full.RS_TEMPLATES_DIR
  const r = spawnSync(process.execPath, [script], { env: full, encoding: 'utf8' })
  expect(r.status).toBe(1)
  expect(r.stderr).toContain('RS_TEMPLATES_DIR')
})
