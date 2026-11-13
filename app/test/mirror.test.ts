// The "Flip picture (it's mirrored)" toggle in "Edit it myself": what it writes, what the main
// process lets through, and how the change is described.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { STILL_LOOKS_MIRRORED, answerMirror, isMirrored, mergeSourcesPatch, mirrorNotices, withMirror } from '../src/shared/mirror'
import { ACTION_LABELS } from '../src/shared/notes'
import { checklist } from '../src/main/store'
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

// `engine init` looks at each new take (engine/reelengine/mirror_detect.py) and keeps what it saw in
// `sources[].mirrorCheck`. A clear mirror comes in flipped, and the chat says so with "Undo flip"; a
// maybe makes the chat ask. Nothing is ever flipped, undone or asked twice.
describe('mirrored take found at import', () => {
  const WHY = 'the writing behind you reads backwards'
  const MAYBE = 'some writing behind you seems to read backwards'
  const flipped = (id: string) => take(id, { mirror: true, mirrorCheck: { verdict: 'mirrored', why: WHY } })
  const maybe = (id: string) => take(id, { mirrorCheck: { verdict: 'maybe-mirrored', why: MAYBE } })
  const plain = (id: string, verdict = 'unsure') => take(id, { mirrorCheck: { verdict } })

  it('says what it flipped and why, with one button to undo it', () => {
    expect(mirrorNotices([flipped('s1')])).toEqual([
      { text: `I flipped your video: it looked mirrored (${WHY}).`, actions: ['mirror-undo'] }
    ])
    expect(mirrorNotices([flipped('s1'), flipped('s2')])[0].text).toBe(`I flipped your videos: they looked mirrored (${WHY}).`)
    expect(mirrorNotices([plain('s1'), flipped('s2')])[0].text).toBe(`I flipped take 2: it looked mirrored (${WHY}).`)
    expect(ACTION_LABELS['mirror-undo']).toBe('Undo flip')
  })

  it('asks about a take that only looks mirrored, and changes nothing until you answer', () => {
    expect(mirrorNotices([maybe('s1')])).toEqual([
      { text: `Your video looks mirrored (${MAYBE}). Flip it?`, actions: ['mirror-flip', 'mirror-keep'] }
    ])
    expect(mirrorNotices([maybe('s1'), plain('s2'), maybe('s3')])[0].text).toBe(`Take 1 and take 3 look mirrored (${MAYBE}). Flip them?`)
    expect([ACTION_LABELS['mirror-flip'], ACTION_LABELS['mirror-keep']]).toEqual(['Flip it', 'Keep as filmed'])
    // one take flipped and another unsure: one line each
    expect(mirrorNotices([flipped('s1'), maybe('s2')]).map((n) => n.actions)).toEqual([['mirror-undo'], ['mirror-flip', 'mirror-keep']])
  })

  it('says nothing when there is nothing to say', () => {
    for (const v of ['as-filmed', 'unsure', 'unknown']) expect(mirrorNotices([plain('s1', v)])).toEqual([])
    expect(mirrorNotices([take('s1', { mirror: true })])).toEqual([])       // flipped by the AI or the switch
    expect(mirrorNotices([take('s1')])).toEqual([])                         // an older engine
    expect(mirrorNotices(undefined)).toEqual([])
    const answered = take('s1', { mirrorCheck: { verdict: 'maybe-mirrored', why: MAYBE, answer: 'kept' } })
    expect(mirrorNotices([answered])).toEqual([])
    for (const n of mirrorNotices([flipped('s1'), maybe('s2')])) expect(n.text).not.toMatch(/—/)
  })

  it('"Undo flip" puts it back as filmed and remembers, so it is never flipped again', () => {
    const r = answerMirror([flipped('s1'), plain('s2')], 'mirror-undo')
    expect(r.sources).toEqual([take('s1', { mirrorCheck: { verdict: 'mirrored', why: WHY, answer: 'undone' } }), plain('s2')])
    expect(r.change).toBe('picture back the way you filmed it')
    expect(r.reply).toBe('Done: it is back the way you filmed it.')
    expect(mirrorNotices(r.sources)).toEqual([])
    // a second press (or the switch was already turned off): nothing to undo, nothing changes
    expect(answerMirror(r.sources, 'mirror-undo')).toEqual({ sources: r.sources, change: '', reply: null })
    const off = [take('s1', { mirrorCheck: { verdict: 'mirrored', why: WHY } })]
    expect(answerMirror(off, 'mirror-undo').reply).toBeNull()
  })

  it('"Flip it" flips only the takes it asked about; "Keep as filmed" flips nothing', () => {
    const r = answerMirror([maybe('s1'), plain('s2')], 'mirror-flip')
    expect(r.sources[0]).toEqual(take('s1', { mirror: true, mirrorCheck: { verdict: 'maybe-mirrored', why: MAYBE, answer: 'flipped' } }))
    expect(r.sources[1]).toEqual(plain('s2'))
    expect(r.change).toBe('flipped the picture')
    expect(answerMirror(r.sources, 'mirror-flip').reply).toBeNull()        // never flipped twice
    const k = answerMirror([maybe('s1')], 'mirror-keep')
    expect(k.sources).toEqual([take('s1', { mirrorCheck: { verdict: 'maybe-mirrored', why: MAYBE, answer: 'kept' } })])
    expect(k.change).toBe('')
    expect(k.reply).toBe('OK, I left it the way you filmed it.')
    // flipped with the switch before answering: the question has nothing left to do
    expect(answerMirror([take('s1', { mirror: true, mirrorCheck: { verdict: 'maybe-mirrored' } })], 'mirror-flip').reply).toBeNull()
  })

  it('"Flip it" under "It still looks mirrored to me" flips a take the user had kept or undone; Keep keeps it', () => {
    const undone = take('s1', { mirrorCheck: { verdict: 'mirrored', why: WHY, answer: 'undone' } })
    const kept = take('s2', { mirrorCheck: { verdict: 'maybe-mirrored', why: MAYBE, answer: 'kept' } })
    const r = answerMirror([undone, kept, plain('s3')], 'mirror-flip')
    expect(r.sources.map((s) => [s.mirror ?? null, s.mirrorCheck?.answer ?? null])).toEqual([[true, 'flipped'], [true, 'flipped'], [null, null]])
    expect(r.change).toBe('flipped the picture')
    expect(answerMirror([undone], 'mirror-keep').sources[0].mirrorCheck?.answer).toBe('kept')
    expect(STILL_LOOKS_MIRRORED).toMatch(/Flip it\?$/)
    expect(STILL_LOOKS_MIRRORED).not.toMatch(/—/)
  })

  it('the "Flip picture" switch and Undo in What I did keep what init saw, and the choice', () => {
    const off = mergeSourcesPatch([flipped('s1'), take('s2', { mirror: true })], [{ id: 's1', mirror: false }, { id: 's2', mirror: false }])
    expect(off).toEqual([take('s1', { mirrorCheck: { verdict: 'mirrored', why: WHY, answer: 'undone' } }), take('s2')])
    expect(mirrorNotices(off)).toEqual([])
    expect(answerMirror(off, 'mirror-undo').reply).toBeNull()               // the chat's Undo flip has nothing left to do
    const on = mergeSourcesPatch([maybe('s1')], [{ id: 's1', mirror: true }])
    expect(on).toEqual([take('s1', { mirror: true, mirrorCheck: { verdict: 'maybe-mirrored', why: MAYBE, answer: 'flipped' } })])
    expect(mergeSourcesPatch(on, [{ id: 's1', mirror: true }])[0]).toBe(on[0])   // no change, no new answer
  })

  it('"What I did" lists the flip and why', () => {
    const items = (p: ProjectJson) => checklist(p, [], [], [], false)
    expect(items(proj([flipped('s1')])).find((c) => c.key === 'mirror')).toEqual({
      key: 'mirror', label: 'Flipped the picture (it was mirrored)', done: true, detail: WHY
    })
    expect(items(proj([take('s1', { mirror: true })])).find((c) => c.key === 'mirror')?.detail).toBeUndefined()
    expect(items(proj([maybe('s1')])).some((c) => c.key === 'mirror')).toBe(false)
  })

  it('is wired: init result -> chat lines; the buttons -> mirror:answer -> a new version; Undo in What I did', () => {
    const src = (f: string) => readFileSync(join(__dirname, '..', 'src', f), 'utf8')
    const main = src('main/index.ts')
    expect(main).toMatch(/for \(const n of mirrorNotices\(made\?\.sources\)\) await addChat\(slug, 'editor', n\.text, undefined, n\.actions\)/)
    expect(main).toMatch(/handle\('mirror:answer'[\s\S]{0,900}answerMirror\(p\.sources, action\)/)
    expect(main).toMatch(/if \(r\.mirrorDeclined\?\.length\) await addChat\(slug, 'editor', STILL_LOOKS_MIRRORED, undefined, \['mirror-flip', 'mirror-keep'\]\)/)
    // one answer at a time per project, and the message's buttons are disabled while it is answered
    expect(main).toMatch(/handle\('mirror:answer',[\s\S]{0,120}serialized\(`mirror-answer:\$\{slug\}`/)
    expect(src('preload/index.ts')).toMatch(/answer: \(slug, messageId, action\) => call\('mirror:answer', slug, messageId, action\)/)
    const page = src('renderer/src/screens/Reel.tsx')
    expect(page).toMatch(/r\.change \? rerender\(r\.change, 'Flipping your video'\) : load\(\)/)
    expect(page).toMatch(/disabled=\{\(!!job && a !== 'connect'\) \|\| answering === m\.id\}/)
    expect(page).toMatch(/case 'mirror':[\s\S]{0,200}testid: 'undo-flip'/)
    expect(page).toMatch(/withMirror\(d\.project\.sources, false\)/)
  })
})
