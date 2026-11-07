import { join, parse } from 'node:path'
import { expect, it } from 'vitest'
import { isInside } from '../src/main/path-inside'

// audit 06 F01 and F02: footage-sources resolve, library addToLibrary and archive-reels libraryRef used a prefix check
it('fails if a clip at the top of a drive is refused, or a folder named like the Library counts as inside it', () => {
  // a whole drive added as a footage folder (E:\ on Windows, / here): its clips are inside it
  const drive = parse(process.cwd()).root
  expect(isInside(join(drive, 'take.mp4'), drive)).toBe(true)
  expect(isInside(join(drive, 'Shoots', 'take.mp4'), drive)).toBe(true)
  const lib = join(drive, 'Reel Studio', 'Library')
  expect(isInside(join(lib, 'Raw takes', 'a.mp4'), lib)).toBe(true)
  expect(isInside(lib, lib)).toBe(true)
  // next to it, not in it
  expect(isInside(join(drive, 'Reel Studio', 'Library backup', 'a.mp4'), lib)).toBe(false)
  expect(isInside(join(drive, 'Reel Studio', 'a.mp4'), lib)).toBe(false)
  // a name that only starts with two dots is still inside
  expect(isInside(join(lib, '..take.mp4'), lib)).toBe(true)
})
