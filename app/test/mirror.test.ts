// The "Flip picture (it's mirrored)" toggle in "Edit it myself": what it writes, what the main
// process lets through, and how the change is described.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { answerMirror, declinedQuestion, isMirrored, mergeSourcesPatch, mirrorNotices, withMirror } from '../src/shared/mirror'
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
// maybe makes the chat ask. Each question carries its takes' ids, and its buttons act on those only.
describe('mirrored take found at import', () => {
  const WHY = 'the writing behind you reads backwards'
  const MAYBE = 'some writing behind you seems to read backwards'
  const flipped = (id: string) => take(id, { mirror: true, mirrorCheck: { verdict: 'mirrored', why: WHY } })
  const maybe = (id: string) => take(id, { mirrorCheck: { verdict: 'maybe-mirrored', why: MAYBE } })
  const plain = (id: string, verdict = 'unsure') => take(id, { mirrorCheck: { verdict } })
  const undone = (id: string) => take(id, { mirrorCheck: { verdict: 'mirrored', why: WHY, answer: 'undone' } })
  const kept = (id: string) => take(id, { mirrorCheck: { verdict: 'maybe-mirrored', why: MAYBE, answer: 'kept' } })
  const state = (s: NonNullable<ProjectJson['sources']>) => s.map((x) => [x.id, x.mirror ?? null, x.mirrorCheck?.answer ?? null])

  it('says what it flipped and why, with one button to undo it', () => {
    expect(mirrorNotices([flipped('s1')])).toEqual([
      { text: `I flipped your video: it looked mirrored (${WHY}).`, actions: ['mirror-undo'], sources: ['s1'] }
    ])
    expect(mirrorNotices([flipped('s1'), flipped('s2')])[0].text).toBe(`I flipped your videos: they looked mirrored (${WHY}).`)
    expect(mirrorNotices([plain('s1'), flipped('s2')])[0]).toMatchObject({ text: `I flipped take 2: it looked mirrored (${WHY}).`, sources: ['s2'] })
    expect(ACTION_LABELS['mirror-undo']).toBe('Undo flip')
  })

  it('asks about a take that only looks mirrored, and changes nothing until you answer', () => {
    expect(mirrorNotices([maybe('s1')])).toEqual([
      { text: `Your video looks mirrored (${MAYBE}). Flip it?`, actions: ['mirror-flip', 'mirror-keep'], sources: ['s1'] }
    ])
    expect(mirrorNotices([maybe('s1'), plain('s2'), maybe('s3')])[0]).toMatchObject({
      text: `Take 1 and take 3 look mirrored (${MAYBE}). Flip them?`, sources: ['s1', 's3']
    })
    expect([ACTION_LABELS['mirror-flip'], ACTION_LABELS['mirror-keep']]).toEqual(['Flip it', 'Keep as filmed'])
    // one take flipped and another unsure: one line each, each about its own take
    expect(mirrorNotices([flipped('s1'), maybe('s2')]).map((n) => [n.actions, n.sources])).toEqual([
      [['mirror-undo'], ['s1']], [['mirror-flip', 'mirror-keep'], ['s2']]
    ])
  })

  it('says nothing when there is nothing to say', () => {
    for (const v of ['as-filmed', 'unsure', 'unknown']) expect(mirrorNotices([plain('s1', v)])).toEqual([])
    expect(mirrorNotices([take('s1', { mirror: true })])).toEqual([])       // flipped by the AI or the switch
    expect(mirrorNotices([take('s1')])).toEqual([])                         // an older engine
    expect(mirrorNotices(undefined)).toEqual([])
    expect(mirrorNotices([kept('s1')])).toEqual([])
    for (const n of mirrorNotices([flipped('s1'), maybe('s2')])) expect(n.text).not.toMatch(/—/)
  })

  it('"Undo flip" puts its take back as filmed and remembers, so it is never flipped again', () => {
    const r = answerMirror([flipped('s1'), plain('s2')], 'mirror-undo', ['s1'])
    expect(r.sources).toEqual([undone('s1'), plain('s2')])
    expect(r.change).toBe('picture back the way you filmed it')
    expect(r.reply).toBe('Done: it is back the way you filmed it.')
    expect(mirrorNotices(r.sources)).toEqual([])
    // a second press (or the switch was already turned off): nothing to undo, nothing changes
    expect(answerMirror(r.sources, 'mirror-undo', ['s1'])).toEqual({ sources: r.sources, change: '', reply: null })
  })

  it('"Flip it" flips only the takes it asked about; "Keep as filmed" flips nothing', () => {
    const r = answerMirror([maybe('s1'), plain('s2')], 'mirror-flip', ['s1'])
    expect(r.sources[0]).toEqual(take('s1', { mirror: true, mirrorCheck: { verdict: 'maybe-mirrored', why: MAYBE, answer: 'flipped' } }))
    expect(r.sources[1]).toEqual(plain('s2'))
    expect(r.change).toBe('flipped the picture')
    expect(answerMirror(r.sources, 'mirror-flip', ['s1']).reply).toBeNull()        // never flipped twice
    const k = answerMirror([maybe('s1')], 'mirror-keep', ['s1'])
    expect(k.sources).toEqual([kept('s1')])
    expect(k.change).toBe('')
    expect(k.reply).toBe('OK, I left it the way you filmed it.')
    // flipped with the switch before answering: the question has nothing left to do
    expect(answerMirror([take('s1', { mirror: true, mirrorCheck: { verdict: 'maybe-mirrored' } })], 'mirror-flip', ['s1']).reply).toBeNull()
  })

  it('two takes: answering one take\'s question never touches the other', () => {
    // take 1 was undone by the user, take 2 is still being asked about at import
    const two = [undone('s1'), maybe('s2')]
    const q2 = mirrorNotices(two)[0]
    expect(q2.sources).toEqual(['s2'])
    expect(state(answerMirror(two, 'mirror-flip', q2.sources).sources)).toEqual([['s1', null, 'undone'], ['s2', true, 'flipped']])
    // the AI later wanted take 1 flipped: its question is about take 1 only
    const q1 = declinedQuestion(two, ['s1'])!
    expect(q1.sources).toEqual(['s1'])
    expect(state(answerMirror(two, 'mirror-flip', q1.sources).sources)).toEqual([['s1', true, 'flipped'], ['s2', null, null]])
    expect(state(answerMirror(two, 'mirror-keep', q1.sources).sources)).toEqual([['s1', null, 'kept'], ['s2', null, null]])
  })

  it('the AI\'s refused flip becomes a one-tap question about exactly those takes', () => {
    expect(declinedQuestion([undone('s1')], ['s1'])).toEqual({
      text: 'It still looks mirrored to me (some writing behind you seems to read backwards), so I left your video the way you chose. Flip it?',
      actions: ['mirror-flip', 'mirror-keep'],
      sources: ['s1']
    })
    expect(declinedQuestion([undone('s1'), kept('s2'), plain('s3')], ['s1', 's2'])?.text).toMatch(/so I left take 1 and take 2 the way you chose\. Flip them\?$/)
    expect(declinedQuestion([undone('s1')], [])).toBeNull()
    expect(declinedQuestion([take('s1', { mirror: true, mirrorCheck: { verdict: 'mirrored', answer: 'flipped' } })], ['s1'])).toBeNull()   // already flipped
    expect(declinedQuestion([undone('s1')], ['s9'])).toBeNull()
    expect(declinedQuestion([undone('s1')], ['s1'])!.text).not.toMatch(/—/)
  })

  it('the "Flip picture" switch and Undo in What I did keep what init saw, and the choice', () => {
    const off = mergeSourcesPatch([flipped('s1'), take('s2', { mirror: true })], [{ id: 's1', mirror: false }, { id: 's2', mirror: false }])
    expect(off).toEqual([undone('s1'), take('s2')])
    expect(mirrorNotices(off)).toEqual([])
    expect(answerMirror(off, 'mirror-undo', ['s1']).reply).toBeNull()               // the chat's Undo flip has nothing left to do
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

  it('is wired: questions with their takes -> mirror:answer on those takes -> a new version; Undo in What I did', () => {
    const src = (f: string) => readFileSync(join(__dirname, '..', 'src', f), 'utf8')
    const main = src('main/index.ts')
    expect(main).toMatch(/for \(const q of mirrorNotices\(made\?\.sources\)\) await askMirror\(slug, q\)/)
    expect(main).toMatch(/addChat\(slug, 'editor', q\.text, undefined, q\.actions, undefined, undefined, q\.sources\)/)
    expect(main).toMatch(/declinedQuestion\(\(await readProject\(slug\)\)\.sources, r\.mirrorDeclined\)/)
    expect(main).toMatch(/answerMirror\(p\.sources, action, asked\.sources \?\? \[\]\)/)
    // one answer at a time per project, and the message's buttons are disabled while it is answered
    expect(main).toMatch(/handle\('mirror:answer',[\s\S]{0,120}serialized\(`mirror-answer:\$\{slug\}`/)
    expect(src('main/store.ts')).toMatch(/\.\.\.\(sources\?\.length \? \{ sources \} : \{\}\)/)
    expect(src('preload/index.ts')).toMatch(/answer: \(slug, messageId, action\) => call\('mirror:answer', slug, messageId, action\)/)
    const page = src('renderer/src/screens/Reel.tsx')
    expect(page).toMatch(/r\.change \? rerender\(r\.change, 'Flipping your video'\) : load\(\)/)
    expect(page).toMatch(/disabled=\{\(!!job && a !== 'connect'\) \|\| answering === m\.id\}/)
    expect(page).toMatch(/case 'mirror':[\s\S]{0,200}testid: 'undo-flip'/)
    expect(page).toMatch(/withMirror\(d\.project\.sources, false\)/)
  })
})
