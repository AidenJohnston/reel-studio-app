// latest-mac.yml (packaging/latest-mac.js) must describe exactly the zip people download: electron-updater
// refuses an update whose sha512 (base64) or size does not match.
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const { latestMacYml } = createRequire(import.meta.url)('../../packaging/latest-mac.js') as {
  latestMacYml(zip: string, version: string, releaseDate?: string): string
}
const ZIP = join(__dirname, 'fixtures', 'update', 'Reel-Studio-9.9.9-arm64-mac.zip')

describe('latest-mac.yml', () => {
  it('names the zip and carries its sha512 and size', () => {
    const sha512 = createHash('sha512').update(readFileSync(ZIP)).digest('base64')
    const size = statSync(ZIP).size
    expect(latestMacYml(ZIP, '9.9.9', '2026-10-21T00:00:00.000Z')).toBe(
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
  })
})
