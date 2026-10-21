// Reusing a listening model already on this computer (main/model-cache.ts): where the Hugging Face cache is on each
// system, and the check that a found copy is exactly the pinned files. The stage itself is in e2e/listening.spec.ts.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { adoptCopy, findCachedCopies, hfHubCache, verifyFiles, type PinnedModel } from '../src/main/model-cache'

it('looks where huggingface_hub saves on macOS and Windows, honoring HF_HUB_CACHE and HF_HOME', () => {
  expect(hfHubCache({}, '/Users/zoë', 'darwin')).toBe('/Users/zoë/.cache/huggingface/hub')
  expect(hfHubCache({}, 'C:\\Users\\Zoë', 'win32')).toBe('C:\\Users\\Zoë\\.cache\\huggingface\\hub')
  expect(hfHubCache({ HF_HOME: 'D:\\hf' }, 'C:\\Users\\Zoë', 'win32')).toBe('D:\\hf\\hub')
  // HF_HUB_CACHE wins over HF_HOME, and ~ means the home folder, as in huggingface_hub
  expect(hfHubCache({ HF_HUB_CACHE: '~/models', HF_HOME: '/opt/hf' }, '/Users/zoë', 'darwin')).toBe('/Users/zoë/models')
})

function cache(): { hub: string; snapshot: string; pin: PinnedModel; files: Record<string, Buffer> } {
  const hub = mkdtempSync(join(tmpdir(), 'rs-hf-'))
  const files = { 'model.bin': Buffer.alloc(3 << 20, 7), 'config.json': Buffer.from('{"a":1}') }
  const pin: PinnedModel = {
    repo: 'Systran/faster-whisper-small.en',
    revision: 'abc',
    files: Object.entries(files).map(([name, b]) => ({ name, size: b.length, sha256: createHash('sha256').update(b).digest('hex') }))
  }
  const snapshot = join(hub, 'models--Systran--faster-whisper-small.en', 'snapshots', 'abc')
  mkdirSync(snapshot, { recursive: true })
  for (const [n, b] of Object.entries(files)) writeFileSync(join(snapshot, n), b)
  return { hub, snapshot, pin, files }
}

it('keeps a found copy only when every file has the pinned size and SHA-256', async () => {
  const c = cache()
  expect(await findCachedCopies(c.hub, c.pin)).toEqual([c.snapshot])
  const dest = join(c.hub, 'out', 'small.en')
  expect(await adoptCopy(c.snapshot, dest, c.pin.files)).toEqual({ ok: true })
  expect(readFileSync(join(dest, 'model.bin')).equals(c.files['model.bin'])).toBe(true)

  // same size, one byte different: copied, checked, thrown away
  const bad = Buffer.from(c.files['model.bin'])
  bad[1000] ^= 1
  writeFileSync(join(c.snapshot, 'model.bin'), bad)
  const dest2 = join(c.hub, 'out2', 'small.en')
  expect(await adoptCopy(c.snapshot, dest2, c.pin.files)).toEqual({ ok: false, file: 'model.bin', reason: 'sha256' })
  expect(existsSync(dest2)).toBe(false)
})

it('a partly downloaded copy is not a match', async () => {
  const c = cache()
  writeFileSync(join(c.snapshot, 'model.bin'), c.files['model.bin'].subarray(0, 1 << 20))
  expect(await findCachedCopies(c.hub, c.pin)).toEqual([])
  expect(await verifyFiles(c.snapshot, c.pin.files)).toEqual({ ok: false, file: 'model.bin', reason: 'size' })
})
