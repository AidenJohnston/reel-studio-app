// Which model made a version (main/made-with.ts): a saved version is never rewritten, so only the run that made it
// says so.
import { expect, it } from 'vitest'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { recordMadeWith } from '../src/main/made-with'
import { projectDir } from '../src/main/store'
import { setupPaths } from './helpers'

it('fails if a note that got a saved version back replaces which model made that version', async () => {
  setupPaths()
  const dir = projectDir('loaf')
  const v1 = join(dir, 'versions', 'v1', 'made-with.json')
  mkdirSync(join(dir, 'versions', 'v1'), { recursive: true })
  writeFileSync(v1, JSON.stringify({ model: 'Model A' }))
  // model B changed only the caption, on Version 1: the engine gave Version 1 back (index.ts startNote, before = 1)
  await recordMadeWith(dir, { model: 'Model B', version: 1 }, 1)
  expect(JSON.parse(readFileSync(v1, 'utf8'))).toEqual({ model: 'Model A' })
  // a note that made Version 2 records its model there
  mkdirSync(join(dir, 'versions', 'v2'), { recursive: true })
  await recordMadeWith(dir, { model: 'Model B', version: 2 }, 1)
  expect(JSON.parse(readFileSync(join(dir, 'versions', 'v2', 'made-with.json'), 'utf8'))).toEqual({ model: 'Model B' })
  expect(JSON.parse(readFileSync(v1, 'utf8'))).toEqual({ model: 'Model A' })
})
