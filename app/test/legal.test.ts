import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { initPaths, legalFile } from '../src/main/paths'

const REPO = resolve(__dirname, '..', '..')

it('fails if Settings > About opens a license file the installer does not ship', () => {
  const builder = readFileSync(join(REPO, 'packaging', 'electron-builder.yml'), 'utf8')
  const block = /- from: \$\{env\.RS_REPO_ROOT\}\n\s+to: (\S+)\n\s+filter:\n((?:\s+- .+\n)+)/.exec(builder)
  const shipped = block?.[2].split('\n').map((l) => l.trim().replace(/^- /, '')).filter(Boolean) ?? []

  initPaths({ isPackaged: true, resourcesPath: '/Resources', documentsDir: '/d', userDataDir: '/u', appDir: join(REPO, 'app') })
  for (const doc of ['license', 'notices']) {
    const file = legalFile(doc)
    expect(dirname(file)).toBe(join('/Resources', block?.[1] ?? '?'))
    expect(shipped).toContain(basename(file))
  }
  initPaths({ isPackaged: false, resourcesPath: '', documentsDir: '/d', userDataDir: '/u', appDir: join(REPO, 'app') })
  expect([legalFile('license'), legalFile('notices')].every(existsSync)).toBe(true)
  expect(() => legalFile('../package.json')).toThrow()
})
