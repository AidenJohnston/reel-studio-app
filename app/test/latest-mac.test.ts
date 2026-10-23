// latest-mac.yml must describe exactly the update zip electron-updater downloads.
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const { latestMacYml } = createRequire(import.meta.url)('../../packaging/latest-mac.js') as {
  latestMacYml(zip: string, version: string): string
}
const ZIP = join(__dirname, 'fixtures', 'update', 'Reel-Studio-9.9.9-arm64-mac.zip')

// This is the same small zip shape the signing script hands to latest-mac.js.
describe('latest-mac.yml', () => {
  it('names the update zip and carries its sha512 and size', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-21T00:00:00.000Z'))
    try {
      const sha512 = createHash('sha512').update(readFileSync(ZIP)).digest('base64')
      const size = statSync(ZIP).size
      expect(latestMacYml(ZIP, '9.9.9')).toBe(
        [
          'version: 9.9.9',
          'files:',
          '  - url: Reel-Studio-9.9.9-arm64-mac.zip',
          `    sha512: ${sha512}`,
          `    size: ${size}`,
          'path: Reel-Studio-9.9.9-arm64-mac.zip',
          `sha512: ${sha512}`,
          "releaseDate: '2026-10-21T00:00:00.000Z'",
          ''
        ].join('\n')
      )
    } finally {
      vi.useRealTimers()
    }
  })
})
