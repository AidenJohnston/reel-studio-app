import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { editDrafts, handPairs, type HandPair } from '../src/main/memory-loop'

const reel = (size: number, extra: Record<string, unknown> = {}) => ({ captions: { enabled: true, style: { size, maxWords: 3 } }, music: { track: 'song.mp3', level: 'under-voice' }, ...extra })
const pair = (slug: string, before: unknown, after: unknown): HandPair => ({ reel: slug, title: `Reel ${slug}`, before, after })

describe('habits in hand edits', () => {
  it('fails if one reel made by hand becomes a suggestion: a habit needs two reels', () => {
    expect(editDrafts([pair('a', reel(105), reel(126))])).toEqual([])
    expect(editDrafts([pair('a', reel(105), reel(126)), pair('b', reel(96), reel(120))])).toEqual([
      {
        kind: 'captions', line: 'Use bigger subtitles', text: 'Use bigger subtitles.',
        from: { kind: 'edits', reels: ['a', 'b'], n: 2, evidence: 'You made the subtitles bigger by hand in 2 reels: “Reel a” and “Reel b”.' }
      }
    ])
  })

  it('fails if a reel changed the other way does not stop the suggestion', () => {
    const drafts = editDrafts([pair('a', reel(105), reel(126)), pair('b', reel(105), reel(126)), pair('c', reel(126), reel(96))])
    expect(drafts).toEqual([])
  })

  it('fails if several hand edits in one reel count as several reels', () => {
    expect(editDrafts([pair('a', reel(105), reel(120)), pair('a', reel(120), reel(140))])).toEqual([])
  })

  it('fails if a nudge too small to see counts as choosing a size', () => {
    expect(editDrafts([pair('a', reel(105), reel(108)), pair('b', reel(105), reel(108))])).toEqual([])
  })

  it('reads music, words per subtitle and pace as their own habits', () => {
    const quieter = (s: number) => reel(s, { music: { track: 'x.mp3', level: 'quiet' } })
    const fast = (s: number) => reel(s, { cutStyle: { preset: 'hyper', seed: 4 } })
    const texts = editDrafts([
      pair('a', reel(105), quieter(105)), pair('b', reel(105), quieter(105)),
      pair('c', reel(105), fast(105)), pair('d', reel(105), fast(105))
    ]).map((d) => [d.kind, d.text])
    expect(texts).toEqual([['music', 'Keep the music quieter under my voice.'], ['pacing', 'Cut my reels at the Fast pace.']])
  })
})

describe('the versions made by hand', () => {
  it('fails if a version not made by hand, or one whose parent is gone, is read as a hand edit', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rs memory '))
    const write = (path: string, value: unknown) => {
      mkdirSync(join(root, path, '..'), { recursive: true })
      writeFileSync(join(root, path), JSON.stringify(value))
    }
    write('bread/project.json', { title: 'Baking bread' })
    write('bread/app.json', { chat: [], versionsMade: [{ version: 2, by: 'hand' }, { version: 3, by: 'note' }, { version: 5, by: 'hand' }] })
    write('bread/versions/v1/project.json', reel(105))
    write('bread/versions/v2/project.json', reel(126))
    write('bread/versions/v2/version.json', { parent: 1 })
    write('bread/versions/v3/project.json', reel(140))
    write('bread/versions/v3/version.json', { parent: 2 })
    // made by hand from version 4, whose folder was removed
    write('bread/versions/v5/project.json', reel(80))
    write('bread/versions/v5/version.json', { parent: 4 })
    mkdirSync(join(root, 'broken'))
    writeFileSync(join(root, 'broken', 'app.json'), '{not json')
    expect(await handPairs(root)).toEqual([{ reel: 'bread', title: 'Baking bread', before: reel(105), after: reel(126) }])
  })
})
