// An Edit it myself change kept as what changed (shared/hand-edit.ts), so it can wait behind a note and land on
// whatever the note left. Each case below has one right answer.
import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RunEngine } from '../src/main/engine'
import { handEditJob } from '../src/main/hand-edit'
import { createJobManager } from '../src/main/jobs'
import { OWNER_LOCK } from '../src/main/owner'
import { projectDir } from '../src/main/store'
import type { ProjectJson, QueuedNote, Word } from '../src/shared/api'
import { keptIds } from '../src/shared/cut'
import { applyHandEdit, countChanges, diffProject, parseHandEdit } from '../src/shared/hand-edit'
import { setupPaths } from './helpers'

const words: Word[] = ['so', 'my', 'cat', 'Biscuit', 'sits', 'here', 'then', 'fold'].map((w, i) => ({ id: `w${i + 1}`, w, s: i, e: i + 0.8 }))
const ids = (from: number, to: number) => words.slice(from - 1, to).map((w) => w.id)

function project(extra: Partial<ProjectJson> = {}): ProjectJson {
  return {
    schemaVersion: 1, id: 'p', title: 't', slug: 't', createdAt: '', updatedAt: '', version: 1,
    sources: [{ id: 's1', path: 'raw.mov' }],
    cut: { keep: [{ from: 'w1', to: 'w8' }] },
    captions: { enabled: true, style: { size: 105, position: 0.75 } },
    cover: { atSourceTime: 1, source: 's1', text: null },
    broll: [{ id: 'b1', anchor: { from: 'w3', to: 'w4' }, treatment: 'card-above-head', asset: 'Library/Images/cat.jpg' }],
    ...extra
  }
}
const kept = (p: ProjectJson) => new Set(keptIds(words, p.cut?.keep))

describe('hand edits', () => {
  it('fails if an edit made on Version 1 undoes what a note changed in Version 2', () => {
    const v1 = project()
    const edited = { ...v1, captions: { enabled: true, style: { size: 105, position: 0.66 } } }
    const edit = diffProject(v1, edited, kept(v1), kept(v1))
    // the note made the subtitles bigger and added a picture meanwhile
    const v2 = project({
      version: 2,
      captions: { enabled: true, style: { size: 126, position: 0.75 } },
      broll: [...v1.broll!, { id: 'b2', anchor: { from: 'w6', to: 'w6' }, treatment: 'full-frame', asset: null }]
    })
    const out = applyHandEdit(v2, edit, words)
    expect(out.captions?.style).toEqual({ size: 126, position: 0.66 })
    expect(out.broll?.map((b) => b.id)).toEqual(['b1', 'b2'])
    expect(out.version).toBe(2)
  })

  it('fails if cutting words drops what a note cut, or brings back words the edit never touched', () => {
    const v1 = project()
    const after = kept(v1)
    for (const id of ids(2, 4)) after.delete(id) // "my cat Biscuit"
    const edit = diffProject(v1, v1, kept(v1), after)
    const v2 = project({ cut: { keep: [{ from: 'w1', to: 'w6' }] } }) // the note cut "then fold"
    expect(keptIds(words, applyHandEdit(v2, edit, words).cut?.keep)).toEqual(['w1', 'w5', 'w6'])
  })

  it('fails if a sound, a picture taken out, or a flip is lost or doubled when the edit is applied twice', () => {
    const v1 = project()
    const edited: ProjectJson = {
      ...v1,
      broll: [],
      sfx: [{ at: { word: 'w3' }, sound: 'whoosh-quick', gainDb: -8 }],
      sources: [{ id: 's1', path: 'raw.mov', mirror: true }]
    }
    const edit = diffProject(v1, edited, kept(v1), kept(v1))
    const once = applyHandEdit(v1, edit, words)
    expect(applyHandEdit(once, edit, words)).toEqual(once)
    expect(once.broll).toBeUndefined()
    expect(once.sfx).toEqual([{ at: { word: 'w3' }, sound: 'whoosh-quick', gainDb: -8 }])
    expect(once.sources).toEqual([{ id: 's1', path: 'raw.mov', mirror: true }])
  })

  it('fails if a changed sound is added beside the old one instead of replacing it', () => {
    const v1 = project({ sfx: [{ at: { word: 'w3' }, sound: 'whoosh-quick' }] })
    const edited = { ...v1, sfx: [{ at: { word: 'w3' }, sound: 'pop-soft', gainDb: 6 }] }
    const out = applyHandEdit(v1, diffProject(v1, edited, kept(v1), kept(v1)), words)
    expect(out.sfx).toEqual([{ at: { word: 'w3' }, sound: 'pop-soft', gainDb: 6 }])
  })

  it('fails if main would apply anything but the parts Edit it myself changes', () => {
    const empty = { items: [], words: { cut: [], keep: [] }, mirror: [] }
    for (const path of [['title'], ['version'], ['sources', 's1', 'path'], ['captions', '__proto__', 'x'], ['captions', 'split']]) {
      expect(() => parseHandEdit({ ...empty, set: [{ path, value: 1 }] })).toThrow()
    }
    expect(() => parseHandEdit({ set: [], items: [{ list: 'broll', key: 'b9', item: { id: 'b1' } }], words: { cut: [], keep: [] }, mirror: [] })).toThrow()
    expect(parseHandEdit({ ...empty, set: [{ path: ['cover', 'text'], value: 'Hi' }] }).set).toEqual([{ path: ['cover', 'text'], value: 'Hi' }])
  })

  it('fails if "2 changes" counts each word of one cut, or each frame value of one new cover', () => {
    const v1 = project()
    const after = kept(v1)
    for (const id of ids(2, 4)) after.delete(id)
    const edited = { ...v1, cover: { atSourceTime: 4, source: 's1', text: null, exact: null, manual: true } }
    expect(countChanges(diffProject(v1, edited, kept(v1), after), words)).toBe(2)
  })

  it('fails if a style the project did not have yet replaces, whole, the style a note gave it meanwhile', () => {
    const v1 = project({ captions: { enabled: true } })
    const edit = diffProject(v1, { ...v1, captions: { enabled: true, style: { size: 126 } } }, kept(v1), kept(v1))
    const v2 = project({ version: 2, captions: { enabled: true, style: { position: 0.66, color: '#FFD60A' } } })
    expect(applyHandEdit(v2, edit, words).captions?.style).toEqual({ position: 0.66, color: '#FFD60A', size: 126 })
  })

  it('fails if a pace lands as half of what was picked on a pace a note changed meanwhile, or taking it off is refused', () => {
    const v1 = project({ cutStyle: { preset: 'clean', seed: 1 } })
    const fast = diffProject(v1, { ...v1, cutStyle: { preset: 'hyper', seed: 1 } }, kept(v1), kept(v1))
    // a note made it punchline with a new seed while the edit waited: the edit's preset alone would pair hyper with
    // the note's seed, moments nobody picked
    const v2 = project({ version: 2, cutStyle: { preset: 'punchline', seed: 9 } })
    expect(applyHandEdit(v2, parseHandEdit(fast), words).cutStyle).toEqual({ preset: 'hyper', seed: 1 })
    const off = parseHandEdit(diffProject(v1, { ...v1, cutStyle: undefined }, kept(v1), kept(v1)))
    expect('cutStyle' in applyHandEdit(v2, off, words)).toBe(false)
    // picking a pace and then other moments for it is one change
    expect(countChanges(diffProject(v1, { ...v1, cutStyle: { preset: 'hyper', seed: 2 } }, kept(v1), kept(v1)), words)).toBe(1)
  })

  it('fails if main queues a pace or zoom-in kind the engine would refuse after the wait', () => {
    const empty = { items: [], words: { cut: [], keep: [] }, mirror: [] }
    for (const value of [{ preset: 'calm', seed: 1 }, { preset: 'hyper', seed: 1.5 }, { preset: 'hyper' }]) {
      expect(() => parseHandEdit({ ...empty, set: [{ path: ['cutStyle'], value }] })).toThrow()
    }
    expect(() => parseHandEdit({ ...empty, set: [{ path: ['cutStyle', 'seed'], value: 3 }] })).toThrow()
    const zoom = { anchor: { from: 'w2', to: 'w3' }, kind: 'whip' }
    expect(() => parseHandEdit({ ...empty, set: [], items: [{ list: 'zooms', key: 'w2>w3', item: zoom }] })).toThrow()
  })

  it('fails if a zoom-in given a new kind plays twice or keeps its old kind, or undoes what a note changed meanwhile', () => {
    const z1 = { anchor: { from: 'w2', to: 'w3' }, kind: 'punch' as const }
    const v1 = project({ zooms: [z1, { anchor: { from: 'w6', to: 'w7' } }] })
    const edit = parseHandEdit(diffProject(v1, { ...v1, zooms: [{ ...z1, kind: 'drift' }, { anchor: { from: 'w6', to: 'w7' } }] }, kept(v1), kept(v1)))
    // meanwhile a note made that zoom-in closer, gave it a second on the same words, and removed the other one
    const v2 = project({ version: 2, zooms: [{ ...z1, scale: 1.3 }, { anchor: { from: 'w2', to: 'w3' } }] })
    const once = applyHandEdit(v2, edit, words)
    expect(once.zooms).toEqual([{ ...z1, scale: 1.3, kind: 'drift' }, { anchor: { from: 'w2', to: 'w3' }, scale: 1.12, kind: 'drift' }])
    expect(applyHandEdit(once, edit, words)).toEqual(once)
    // two zoom-ins on the same words with different kinds, both set to the kind the last one already had: still a change
    const pair = project({ zooms: [{ anchor: { from: 'w2', to: 'w3' }, kind: 'punch' }, { anchor: { from: 'w2', to: 'w3' }, kind: 'snap' }] })
    const quick = diffProject(pair, { ...pair, zooms: pair.zooms!.map((z) => ({ ...z, kind: 'snap' as const })) }, kept(pair), kept(pair))
    expect(applyHandEdit(pair, parseHandEdit(quick), words).zooms?.map((z) => z.kind)).toEqual(['snap', 'snap'])
    expect(countChanges(quick, words)).toBe(1)
    // the drawer never adds or removes a zoom-in, so main refuses an edit that would
    const empty = { set: [], words: { cut: [], keep: [] }, mirror: [] }
    expect(() => parseHandEdit({ ...empty, items: [{ list: 'zooms', key: 'w2>w3', item: null }] })).toThrow()
    expect(() => parseHandEdit({ ...empty, items: [{ list: 'zooms', key: 'w2>w3', item: { anchor: { from: 'w2', to: 'w3' } } }] })).toThrow()
  })
})

describe('a hand edit that sets the exposure', () => {
  it('fails if an exposure outside what the engine renders gets past the main process', () => {
    const e = (value: unknown) => ({ set: [{ path: ['exposure'], value }], items: [], words: { cut: [], keep: [] }, mirror: [], joins: [] })
    expect(parseHandEdit(e(1.08)).set).toEqual([{ path: ['exposure'], value: 1.08 }])
    for (const bad of [0, 9, '1.1', null]) expect(() => parseHandEdit(e(bad)), String(bad)).toThrow()
  })
})

describe('a hand edit whose engine would not stop', () => {
  it('fails if its private project is removed, or the video lets go, while that engine may still write', async () => {
    setupPaths()
    const slug = 'stuck-hand'
    const dir = projectDir(slug)
    mkdirSync(join(dir, 'work'), { recursive: true })
    const v1 = project()
    writeFileSync(join(dir, 'project.json'), JSON.stringify(v1))
    const edited = { ...v1, captions: { enabled: true, style: { size: 105, position: 0.66 } } }
    const entry = { id: 'h1', text: 'subtitles up', attachments: [], seenVersion: 1, hand: { edit: diffProject(v1, edited, kept(v1), kept(v1)), changes: 1 } } as QueuedNote & { hand: NonNullable<QueuedNote['hand']> }
    // the preview renders; the final's engine would not stop (engine.ts ENGINE_STUCK)
    const runEngine = (async (_command: string, args: string[]) => {
      if (args.includes('--draft')) return { version: 0 }
      throw { code: 'ENGINE_STUCK', userMessage: "Part of Reel Studio's video engine would not stop." }
    }) as RunEngine
    const jobs = createJobManager(() => undefined, () => undefined)
    jobs.start(slug, 'rerender', handEditJob(runEngine, slug, entry))
    await jobs.forSlug(slug)?.done
    const scratch = join(dir, 'work', 'hand', 'h1')
    expect(existsSync(join(scratch, 'edit.json'))).toBe(true)
    expect(JSON.parse(readFileSync(join(scratch, 'edit.json'), 'utf8')).captions.style.position).toBe(0.66)
    expect(existsSync(join(dir, OWNER_LOCK))).toBe(true)
    expect(() => jobs.start(slug, 'rerender', handEditJob(runEngine, slug, entry))).toThrow(expect.objectContaining({ code: 'ENGINE_STUCK' }))
  })
})
