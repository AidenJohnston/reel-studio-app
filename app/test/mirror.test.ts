// The "Flip picture (it's mirrored)" toggle in "Edit it myself": what it writes, what the main
// process lets through, and how the change is described.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isMirrored, mergeSourcesPatch, withMirror } from '../src/shared/mirror'
import { describeChange } from '../src/shared/describe'
import type { ProjectJson } from '../src/shared/api'

const take = (id: string, extra: Record<string, unknown> = {}) => ({ id, path: `media/${id}.mp4`, duration: 30, ...extra })
const proj = (sources: NonNullable<ProjectJson['sources']>) => ({ sources }) as ProjectJson

describe('flip picture', () => {
  it('is on only when every take is flipped', () => {
    expect(isMirrored(proj([take('s1')]))).toBe(false)
    expect(isMirrored(proj([take('s1', { mirror: true })]))).toBe(true)
    expect(isMirrored(proj([take('s1', { mirror: true }), take('s2')]))).toBe(false)
    expect(isMirrored({ sources: [] })).toBe(false)
    expect(isMirrored({} as ProjectJson)).toBe(false)
  })

  it('turning it off removes the flag, so the project is exactly as it was', () => {
    const on = withMirror([take('s1'), take('s2')], true)
    expect(on.map((s) => s.mirror)).toEqual([true, true])
    const off = withMirror(on, false)
    expect(off).toEqual([take('s1'), take('s2')])
    expect(off.every((s) => !('mirror' in s))).toBe(true)
  })

  it('the main process takes ONLY the mirror flag of takes the project already has', () => {
    const cur = [take('s1'), take('s2', { mirror: true })]
    const evil = [{ id: 's1', path: 'C:/Windows/win.ini', mirror: true, duration: 1 }, { id: 's2', mirror: false }, { id: 's9', path: 'x', mirror: true }]
    const out = mergeSourcesPatch(cur, evil)
    expect(out).toEqual([take('s1', { mirror: true }), take('s2')])   // paths untouched, no new take
    expect(mergeSourcesPatch(cur, 'nope')).toEqual(cur)
    expect(mergeSourcesPatch(cur, [{ id: 's1', mirror: 'yes' }])).toEqual([take('s1'), take('s2', { mirror: true })])
  })

  it('says what changed in plain words', () => {
    const before = proj([take('s1')])
    expect(describeChange(before, { sources: withMirror(before.sources, true) })).toBe('flipped the picture')
    expect(describeChange(proj([take('s1', { mirror: true })]), { sources: [take('s1')] })).toBe('picture back the way you filmed it')
    expect(describeChange(before, { sources: before.sources })).toBe('')
  })

  it('is wired: the drawer toggle, the update handler, and the flipped stills', () => {
    const src = (f: string) => readFileSync(join(__dirname, '..', 'src', f), 'utf8')
    const drawer = src('renderer/src/screens/ShowMeHow.tsx')
    expect(drawer).toMatch(/Flip picture \(it's mirrored\)/)
    expect(drawer).toMatch(/set\('sources', withMirror\(p\.sources, e\.target\.checked\)\)/)
    expect(src('main/index.ts')).toMatch(/p\.sources = mergeSourcesPatch\(p\.sources, patch\.sources\)/)
    expect(src('renderer/src/screens/Reel.tsx')).toMatch(/stillMirrored=\{d\.project\.sources\?\.\[0\]\?\.mirror === true\}/)
    expect(src('renderer/src/screens/Working.tsx')).toMatch(/still\$\{mirrored \? ' mirrored' : ''\}/)
    expect(src('renderer/src/styles.css')).toMatch(/video\.mirrored \{ transform: scaleX\(-1\); \}/)
  })
})
