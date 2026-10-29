import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { adoptCopy, findCachedCopies, hfHubCache, type PinnedModel } from '../src/main/model-cache'

it('looks where huggingface_hub saves on macOS and Windows, honoring HF_HUB_CACHE and HF_HOME', () => {
  expect(hfHubCache({}, '/Users/zoë', 'darwin')).toBe('/Users/zoë/.cache/huggingface/hub')
  expect(hfHubCache({}, 'C:\\Users\\Zoë', 'win32')).toBe('C:\\Users\\Zoë\\.cache\\huggingface\\hub')
  expect(hfHubCache({ HF_HOME: 'D:\\hf' }, 'C:\\Users\\Zoë', 'win32')).toBe('D:\\hf\\hub')
  // HF_HUB_CACHE wins over HF_HOME, and ~ means the home folder, as in huggingface_hub
  expect(hfHubCache({ HF_HUB_CACHE: '~/models', HF_HOME: '/opt/hf' }, '/Users/zoë', 'darwin')).toBe('/Users/zoë/models')
})

/** Laid out as huggingface_hub does: snapshot files are relative links into the repo's blobs folder. */
function cache(): { hub: string; snapshot: string; pin: PinnedModel; files: Record<string, Buffer> } {
  const hub = mkdtempSync(join(tmpdir(), 'rs-hf-'))
  const files = { 'model.bin': Buffer.alloc(3 << 20, 7), 'config.json': Buffer.from('{"a":1}') }
  const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')
  const pin: PinnedModel = {
    repo: 'Systran/faster-whisper-small.en',
    revision: 'abc',
    files: Object.entries(files).map(([name, b]) => ({ name, size: b.length, sha256: sha(b) }))
  }
  const repo = join(hub, 'models--Systran--faster-whisper-small.en')
  const snapshot = join(repo, 'snapshots', 'abc')
  mkdirSync(snapshot, { recursive: true })
  mkdirSync(join(repo, 'blobs'))
  for (const [n, b] of Object.entries(files)) {
    writeFileSync(join(repo, 'blobs', sha(b)), b)
    symlinkSync(join('..', '..', 'blobs', sha(b)), join(snapshot, n))
  }
  return { hub, snapshot, pin, files }
}

it('keeps a found copy only when every file has the pinned size and SHA-256', async () => {
  const c = cache()
  const partial = join(c.hub, 'models--Systran--faster-whisper-small.en', 'snapshots', 'partial')
  mkdirSync(partial)
  writeFileSync(join(partial, 'model.bin'), c.files['model.bin'].subarray(0, 1 << 20))
  writeFileSync(join(partial, 'config.json'), c.files['config.json'])
  const [copy, ...others] = await findCachedCopies(c.hub, c.pin)
  expect(copy.dir).toBe(c.snapshot)
  expect(others).toEqual([])
  const dest = join(c.hub, 'out', 'small.en')
  expect(await adoptCopy(copy, dest, c.pin.files)).toEqual({ ok: true })
  expect(readFileSync(join(dest, 'model.bin')).equals(c.files['model.bin'])).toBe(true)

  // same size, one byte different: copied, checked, thrown away
  const bad = Buffer.from(c.files['model.bin'])
  bad[1000] ^= 1
  writeFileSync(join(c.snapshot, 'model.bin'), bad)
  const dest2 = join(c.hub, 'out2', 'small.en')
  expect(await adoptCopy(copy, dest2, c.pin.files)).toEqual({ ok: false, file: 'model.bin', reason: 'sha256' })
  expect(existsSync(dest2)).toBe(false)
})

it('never reads a cached file whose link leads outside the cache', async () => {
  const c = cache()
  const outside = join(mkdtempSync(join(tmpdir(), 'rs-outside-')), 'model.bin')
  writeFileSync(outside, c.files['model.bin'])
  rmSync(join(c.snapshot, 'model.bin'))
  symlinkSync(outside, join(c.snapshot, 'model.bin'))
  expect(await findCachedCopies(c.hub, c.pin)).toEqual([])
})
