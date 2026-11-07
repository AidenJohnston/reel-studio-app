import { describe, expect, it } from 'vitest'
import type { ChatMessage, VersionInfo } from '../src/shared/api'
import { editorSaid, handLine, noteToRetry, notesLog, waitingRows, withoutNumber } from '../src/shared/notes-log'

const now = new Date('2026-10-22T15:00:00')
const at = (h: number, day = 22) => new Date(2026, 9, day, h).toISOString()
const v = (n: number, day = 22): VersionInfo => ({ n, parent: n > 1 ? n - 1 : null, video: '', videoPath: '', draft: false, cover: null, createdAt: at(9, day) })
let id = 0
const msg = (from: ChatMessage['from'], text: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({ id: `m${++id}`, from, text, at: at(10), ...extra })

describe('notesLog', () => {
  // Review finding r12: the guard ran over the person's notes too, so "Use w12 for the lower third" showed, and was
  // sent again, as "Use for the lower third".
  it("fails if the person's note, or an editor line quoting it, loses an id-like word", () => {
    const chat = [
      msg('editor', 'Your video is ready.', { version: 1 }),
      msg('you', 'Use w12 for the lower third', { jobId: 'j1', outcome: 'failed' }),
      msg('editor', 'I could not find "w12" in your Library.', { jobId: 'j1' })
    ]
    const log = notesLog({ chat, made: [], versions: [v(1)], running: null, sources: [], now })
    expect(log[1]).toMatchObject({ ask: { text: 'Use w12 for the lower third' }, result: { kind: 'failed', text: 'I could not find "w12" in your Library.' } })
    expect(noteToRetry(chat, log[1].key)).toBe('Use w12 for the lower third')
  })

  // the dev multi-clip run (footage-1106-2): a reel cut from three videos said "Your video, take 1 red.mp4"
  it('fails if a reel cut from several videos names only the first', () => {
    const take = (n: number) => ({ path: `media/take0${n}.mp4`, originalName: `take ${n}.mp4` })
    const first = (n: number) => notesLog({ chat: [], made: [], versions: [v(1)], running: null, sources: [1, 2, 3, 4].slice(0, n).map(take), now })[0].ask.text
    expect([first(1), first(3), first(4)]).toEqual([
      'Your video, take 1.mp4', 'Your 3 videos, take 1.mp4, take 2.mp4 and take 3.mp4', 'Your 4 videos, take 1.mp4, take 2.mp4 and 2 more',
    ])
  })

  it('fails if Try again sends something other than the stored note, or sends anything for an entry with none', () => {
    const chat = [msg('you', 'Use w12 for the lower third', { jobId: 'j1', outcome: 'failed' })]
    expect(noteToRetry(chat, chat[0].id)).toBe('Use w12 for the lower third')
    expect(() => noteToRetry(chat, 'video')).toThrow(/no note of yours/)
  })

  // the tour's Version 2 line (notes/design/r11/tour-1028/04-reel-notes-timeline.png), as a build before the fix saved it
  it('fails if a reply, or a note an old build saved, shows a transcript word id', () => {
    const leaked = 'Done: "At 0:06 (around "engine will write what you actually", words w10, w11, w12, w13, w14, w15): make the subtitles bigger here". It is Version 2.'
    const log = notesLog({
      chat: [
        msg('editor', 'Your video is ready.', { version: 1 }),
        msg('you', 'zoom in', { jobId: 'j1', outcome: 'done' }),
        msg('editor', leaked, { version: 2 }),
        msg('you', 'louder here', { jobId: 'j2', outcome: 'done' }),
        msg('editor', 'Raised the music at words w30 to w33 (around "the drive").', { jobId: 'j2' })
      ],
      made: [],
      versions: [v(1), v(2)],
      running: null,
      sources: [],
      now
    })
    const shown = JSON.stringify(log.map((e) => [e.ask.text, e.result && 'text' in e.result ? e.result.text : null]))
    expect(shown).not.toMatch(/\bw\d+\b|\(around /)
    expect(log[1]).toMatchObject({ ask: { text: 'zoom in' }, result: { kind: 'version', v: 2, text: 'Done: "make the subtitles bigger here". It is Version 2.' } })
    expect(log[2]).toMatchObject({ result: { kind: 'reply', text: 'Raised the music.' } })
  })

  // fails if what the editor found in the video is hidden because the last note was stopped and has no reply
  it('shows a line about more reels from the video after a stopped note', () => {
    const log = notesLog({
      chat: [
        msg('editor', 'Your video is ready.', { version: 1 }),
        msg('you', 'add music', { jobId: 'j1', outcome: 'stopped' }),
        msg('editor', 'I found 3 more reels in this video.', { jobId: 'j2', reels: true })
      ],
      made: [],
      versions: [v(1)],
      running: null,
      sources: [],
      now
    })
    expect(log.at(-1)).toMatchObject({ ask: { text: 'add music' }, result: { kind: 'stopped' }, extra: [{ text: 'I found 3 more reels in this video.' }] })
  })

  it('pairs each note with what came of it, in order, with the running one last', () => {
    const chat = [
      { ...msg('editor', 'Your video is ready.', { version: 1 }), at: at(9, 21) },
      msg('you', 'cut the part about my cat', { jobId: 'j1', outcome: 'done', moment: { at: 12, version: 1, words: ['w1'], quote: 'my cat' } }),
      msg('editor', 'Cut 0:12 to 0:15.', { version: 2 }),
      msg('you', 'make it brighter', { jobId: 'j2', outcome: 'failed' }),
      msg('editor', 'Your AI editor stopped answering.'),
      msg('you', 'add music', { jobId: 'j3', outcome: 'stopped' }),
      msg('editor', 'Version 3: bigger subtitles.', { version: 3 }),
      msg('you', 'zoom in on me', { jobId: 'j4' })
    ]
    const log = notesLog({
      chat,
      made: [{ version: 3, by: 'hand', summary: 'made the subtitles bigger', at: at(10) }],
      versions: [v(1, 21), v(2), v(3)],
      running: { id: 'j4', kind: 'note' },
      // fails if the line names the copy Reel Studio made (media/take01.mov) instead of the file the person brought in
      sources: [{ path: 'media/take01.mov', originalName: 'IMG_2207.MOV' }],
      now
    })
    expect(log.map((e) => [e.day, e.ask.kind, e.ask.text, e.result])).toEqual([
      ['Yesterday', 'video', 'Your video, IMG_2207.MOV', { kind: 'version', v: 1, text: 'Your video is ready.' }],
      ['Today', 'note', 'cut the part about my cat', { kind: 'version', v: 2, text: 'Cut 0:12 to 0:15.' }],
      [null, 'note', 'make it brighter', { kind: 'failed', text: 'Your AI editor stopped answering.' }],
      [null, 'note', 'add music', { kind: 'stopped', kept: 3 }],
      [null, 'hand', 'You made the subtitles bigger.', { kind: 'version', v: 3, text: 'Version 3: bigger subtitles.' }],
      [null, 'note', 'zoom in on me', { kind: 'making', v: 4 }]
    ])
    expect(log[1].ask).toMatchObject({ moment: { at: 12 } })
  })

  it('shows the no-AI answer as the note’s reply, with its buttons', () => {
    const log = notesLog({
      chat: [msg('editor', 'Ready.', { version: 1 }), msg('you', 'bigger subtitles'), msg('editor', 'I can’t change that without an AI editor.', { actions: ['open-captions'] })],
      made: [],
      versions: [v(1)],
      running: null,
      sources: [],
      now
    })
    expect(log[1].result).toMatchObject({ kind: 'reply', actions: ['open-captions'] })
  })

  // fails if a planned reel shows a video it does not have, or its script moves below the video once one arrives
  it('puts the planning first: the idea, then the script, with no video until there is one', () => {
    const script = { hook: 'No mixer.', script: 'Flour, water, salt.', onScreenText: [] }
    const planning = [
      msg('you', 'sourdough without a mixer', { plan: true, jobId: 's1', outcome: 'done' }),
      msg('editor', 'No mixer.', { plan: true, script }),
      msg('you', 'shorter please', { plan: true, jobId: 's2' })
    ]
    const base = { made: [], sources: [], now }
    expect(notesLog({ ...base, chat: planning, versions: [], running: { id: 's2', kind: 'script' }, planned: true }).map((e) => [e.ask.text, e.result])).toEqual([
      ['sourdough without a mixer', { kind: 'script', script }],
      ['shorter please', { kind: 'writing' }]
    ])
    const filmed = notesLog({ ...base, chat: [...planning.slice(0, 2), msg('editor', 'Here it is.', { version: 1 })], versions: [v(1)], running: null })
    expect(filmed.map((e) => [e.ask.kind, e.result?.kind])).toEqual([
      ['note', 'script'],
      ['video', 'version']
    ])
  })

  // fails if the Plan card shows on an older proposal, goes missing for a form-made plan, or the planning chat stays
  // above the video instead of folding into the one Plan card
  it('shows the Plan card on the newest proposal, alone for a form plan, and folded once the video is in', () => {
    const plan = { topic: 'sourdough', hooks: ['A', 'B'], hook: 0, beats: [{ text: 'one' }], shots: [] }
    const planning = [
      msg('you', 'sourdough', { plan: true, jobId: 'p1', outcome: 'done' }),
      msg('editor', 'Who is it for?', { plan: true, planTurn: 'question' }),
      msg('you', 'beginners', { plan: true, jobId: 'p2', outcome: 'done' }),
      msg('editor', 'Here is a plan.', { plan: true, planTurn: 'plan' }),
      msg('you', 'shorter hook', { plan: true, jobId: 'p3', outcome: 'done' }),
      msg('editor', 'I made that change.', { plan: true, planTurn: 'plan' })
    ]
    const base = { made: [], sources: [], now, versions: [], running: null }
    expect(notesLog({ ...base, chat: planning, planned: true, plan }).map((e) => e.result)).toEqual([
      { kind: 'question', text: 'Who is it for?' },
      { kind: 'proposed', text: 'Here is a plan.', card: false },
      { kind: 'proposed', text: 'I made that change.', card: true }
    ])
    expect(notesLog({ ...base, chat: [], planned: true, plan }).map((e) => [e.key, e.ask])).toEqual([['plan', { kind: 'plan', text: 'sourdough' }]])
    const filmed = notesLog({ ...base, chat: [...planning, msg('editor', 'Here it is.', { version: 1 })], versions: [v(1)], plan })
    expect(filmed.map((e) => [e.ask.kind, e.result?.kind ?? null])).toEqual([
      ['plan', null],
      ['video', 'version']
    ])
  })
})

describe('waitingRows', () => {
  // a note that did not finish keeps its queue entry to try again, but must not also show as a waiting row
  it('fails if a stopped or failed note shows both as its line and as a waiting row', () => {
    const queue = [{ id: 'stopped' }, { id: 'failed' }, { id: 'running', attempt: { base: 1 } }, { id: 'next' }]
    const entries = [
      { key: 'stopped', result: { kind: 'stopped' as const, kept: 1 } },
      { key: 'failed', result: { kind: 'failed' as const, text: 'It did not work.' } }
    ]
    expect(waitingRows(queue, entries).map((q) => q.id)).toEqual(['next'])
  })
})

// Try again (Reel.tsx retry) runs a failed note again under a new job and moves its "you" line to that job. Each
// job's reply carries its id (main/jobs.ts), so the first attempt's failure must not become the retry's result.
describe('a note tried again', () => {
  const log = (chat: ChatMessage[], versions: VersionInfo[]) =>
    notesLog({ chat, made: [], versions, running: null, sources: [], now })
  const rows = (entries: ReturnType<typeof log>) => entries.map((e) => [e.ask.kind, e.ask.text, e.result])

  it('fails if a retry that made a version shows the first attempt\'s failure, even with another note in between', () => {
    const chat = [
      msg('editor', 'Your video is ready.', { version: 1 }),
      msg('you', 'make it brighter', { jobId: 'j3', outcome: 'done' }),
      msg('editor', 'Your AI editor stopped answering.', { jobId: 'j1' }),
      msg('you', 'add music', { jobId: 'j2', outcome: 'done' }),
      msg('editor', 'Version 2: music under your voice.', { version: 2, jobId: 'j2' }),
      msg('editor', 'Version 3: brighter.', { version: 3, jobId: 'j3' })
    ]
    expect(rows(log(chat, [v(1), v(2), v(3)]))).toEqual([
      ['video', 'Your video', { kind: 'version', v: 1, text: 'Your video is ready.' }],
      ['note', 'make it brighter', { kind: 'version', v: 3, text: 'Version 3: brighter.' }],
      ['note', 'add music', { kind: 'version', v: 2, text: 'Version 2: music under your voice.' }]
    ])
  })

  it('fails if a retry that was stopped shows as failed, or shows twice with its waiting row', () => {
    const chat = [
      msg('editor', 'Your video is ready.', { version: 1 }),
      msg('you', 'make it brighter', { jobId: 'j2', outcome: 'stopped' }),
      msg('editor', 'Your AI editor stopped answering.', { jobId: 'j1' })
    ]
    const entries = log(chat, [v(1)])
    expect(rows(entries)).toEqual([
      ['video', 'Your video', { kind: 'version', v: 1, text: 'Your video is ready.' }],
      ['note', 'make it brighter', { kind: 'stopped', kept: 1 }]
    ])
    // the stopped note waits in the queue to try again, and shows only as its line
    expect(waitingRows([{ id: chat[1].id }], entries)).toEqual([])
  })
})

describe('a "Remember this for next time?" question', () => {
  // the question keeps its Yes and No: it is never taken as what came of the note
  it('fails if a note that changed nothing shows its question as its result, without the buttons', () => {
    const question = msg('editor', 'Remember this for next time? "always use big subtitles"', {
      jobId: 'j1', actions: ['remember-yes', 'remember-no'], suggestion: 'always use big subtitles'
    })
    const chat = [
      msg('editor', 'Your video is ready.', { version: 1 }),
      msg('you', 'always use big subtitles', { jobId: 'j1', outcome: 'failed' }),
      msg('editor', 'They are already big.', { jobId: 'j1', version: 1 }),
      question
    ]
    const note = notesLog({ chat, made: [], versions: [v(1)], running: null, sources: [], now })[1]
    expect(note.result).not.toMatchObject({ text: question.text })
    expect(note.extra.map((m) => [m.text, m.actions])).toContainEqual([question.text, ['remember-yes', 'remember-no']])
  })
})

describe('a hand edit\'s line', () => {
  // fails if the line reads "You changed new song …", the broken sentence of the 10-28 audit
  it('is one sentence of what the person did, and an old summary keeps its words', () => {
    expect(handLine('added the song “warm acoustic loop”, a picture and a sound effect')).toBe('You added the song “warm acoustic loop”, a picture and a sound effect.')
    expect(handLine('new song "warm acoustic loop", added a picture')).toBe('Your changes: new song "warm acoustic loop", added a picture')
    expect(handLine(undefined)).toBe('You changed it yourself')
  })
})

describe('the editor\'s words under What changed', () => {
  // fails if What changed repeats a sentence that only says the version number or echoes the note
  it('keeps what the editor said beyond the version number', () => {
    expect(editorSaid('Done: "make the subtitles bigger here". It is Version 3.')).toBeNull()
    expect(editorSaid('I made your change. It is Version 4.')).toBeNull()
    expect(editorSaid('That change was saved before you pressed Stop. It is Version 5.')).toBe('That change was saved before you pressed Stop.')
    expect(editorSaid('I made the subtitles bigger and moved them above Instagram’s buttons.')).toBe('I made the subtitles bigger and moved them above Instagram’s buttons.')
    expect(editorSaid('Basic version: pauses cut and subtitles added. Subtitles are lowercase, from My style.')).toBe('Subtitles are lowercase, from My style.')
    expect(editorSaid('Basic version: pauses cut and subtitles added.')).toBeNull()
    // with no rows to say what changed, the words are all there is, less the number its line already says
    expect(withoutNumber('Done: "make the subtitles bigger here". It is Version 3.')).toBe('Done: "make the subtitles bigger here".')
  })
})
