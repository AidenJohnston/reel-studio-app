import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { fontNames } from '../src/main/fonts'
import { APP_DIR } from './helpers'

const FONTS = join(APP_DIR, '..', 'packaging', 'fonts')

it('fails if Library › Fonts names a bundled face differently from the name a caption style uses', () => {
  // caption-presets.ts and captions.py DEFAULT_FONT name the subtitle face "Montserrat SemiBold"
  expect(fontNames(readFileSync(join(FONTS, 'Montserrat-SemiBold.ttf')))).toEqual({ family: 'Montserrat', full: 'Montserrat SemiBold' })
  expect(fontNames(readFileSync(join(FONTS, 'Fraunces-Bold.ttf')))?.family).toBe('Fraunces')
  // a file that only claims to be a font is not listed
  expect(fontNames(Buffer.from('not a font at all, just some text'))).toBeNull()
  expect(fontNames(readFileSync(join(FONTS, 'Inter-OFL.txt')))).toBeNull()
})

it('fails if an added font is sorted as media, a damaged one is kept, or the engine cannot find the person\'s fonts', async () => {
  const { setupPaths } = await import('./helpers')
  const { addToLibrary, listLibrary } = await import('../src/main/library')
  const { binDir, engineEnv } = await import('../src/main/paths')
  const { mkdtempSync, writeFileSync, copyFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { delimiter } = await import('node:path')
  setupPaths()
  const from = mkdtempSync(join(tmpdir(), 'rs-fonts-'))
  copyFileSync(join(FONTS, 'Inter-Bold.ttf'), join(from, 'My Brand.ttf'))
  writeFileSync(join(from, 'broken.otf'), 'not a font')
  const engine: string[] = []
  const r = await addToLibrary([join(from, 'My Brand.ttf'), join(from, 'broken.otf')], async (cmd) => (engine.push(cmd), []), () => {})
  expect(engine).toEqual([])
  expect(r.map((x) => [x.name, x.bin])).toEqual([['My Brand.ttf', 'fonts'], ['broken.otf', null]])
  const fonts = (await listLibrary()).find((b) => b.key === 'fonts')!
  expect(fonts.files.map((f) => [f.name, f.font?.full])).toEqual([['My Brand.ttf', 'Inter Bold']])
  // the person's fonts come before the bundled ones, which stay last (engine tools.font_dirs)
  expect(engineEnv().REELENGINE_FONTS!.split(delimiter)).toEqual([binDir('fonts'), FONTS])
})
