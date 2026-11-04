import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, promises as fs, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  cleanPartialVersions,
  ensureRoot,
  keptIds,
  listProjects,
  searchProjects,
  listVersions,
  rangesFromKept,
  rangesKeepingOrder,
  readAppState,
  recoverInterrupted,
  slugify,
  titleFromFile,
  uniqueSlug,
  updateAppState,
  writeJson,
  detail,
  rootRelative,
  brollLabel,
  carryScript,
  createPlanned,
  discardIfUntouched,
  planReel,
  readProject,
  settleInterrupted,
  summary,
  stamp
} from '../src/main/store'
import { classifyByExtension } from '../src/main/library'
import { binDir, projectsDir, reelStudioRoot } from '../src/main/paths'
import { pathFromMediaUrl } from '../src/main/media-url'
import { setupPaths } from './helpers'
import type { Word } from '../src/shared/api'
import { takeNote } from '../src/main/note-intake'

function fakeProject(slug: string, opts: { versions?: number[]; partial?: number[] } = {}): string {
  const dir = join(projectsDir(), slug)
  mkdirSync(join(dir, 'work'), { recursive: true })
  const now = new Date().toISOString()
  writeFileSync(
    join(dir, 'project.json'),
    JSON.stringify({ schemaVersion: 1, id: slug, title: `Title ${slug}`, slug, createdAt: now, updatedAt: now, version: Math.max(0, ...(opts.versions ?? [])), cut: { keep: [{ from: 'w0', to: 'w1' }] } })
  )
  writeFileSync(join(dir, 'work', 'transcript.json'), JSON.stringify({ words: words(4) }))
  for (const n of opts.versions ?? []) {
    mkdirSync(join(dir, 'versions', `v${n}`), { recursive: true })
    writeFileSync(join(dir, 'versions', `v${n}`, 'export.mp4'), 'x')
    writeFileSync(join(dir, 'versions', `v${n}`, 'cover.png'), 'x')
  }
  for (const n of opts.partial ?? []) {
    mkdirSync(join(dir, 'versions', `v${n}`), { recursive: true })
    writeFileSync(join(dir, 'versions', `v${n}`, '.rendering'), '')
    writeFileSync(join(dir, 'versions', `v${n}`, 'export.mp4.partial.mp4'), 'half')
  }
  return dir
}

describe('version ancestry', () => {
  it('carries the explicit base from note intake and refuses an unsaved base before chat', async () => {
    setupPaths()
    fakeProject('note-base', { versions: [1, 2, 3] })
    // a note sent while a job runs waits in the queue: intake refuses only a reel kept closed
    const jobs = { refuseIfKeptClosed: () => undefined }
    expect(await takeNote(jobs, 'note-base', 'slower', undefined, 2)).toMatchObject({ note: 'slower', base: 2 })
    await expect(takeNote(jobs, 'note-base', 'slower', undefined, 4)).rejects.toMatchObject({ code: 'BAD_NOTE_BASE' })
  })
  it('reads legacy parents without writing into saved folders, including the root and preview', async () => {
    setupPaths()
    const dir = fakeProject('legacy-tree', { versions: [1, 2, 3] })
    expect((await listVersions(dir)).map((v) => [v.n, v.parent])).toEqual([[1, null], [2, 1], [3, 2]])
    expect(existsSync(join(dir, 'versions/v1/version.json'))).toBe(false)
    const preview = fakeProject('preview-tree')
    mkdirSync(join(preview, 'versions/preview'), { recursive: true })
    writeFileSync(join(preview, 'versions/preview/draft.mp4'), 'draft')
    expect((await listVersions(preview)).map((v) => [v.n, v.parent])).toEqual([[0, null]])
  })

  it('returns a branch parent in the project detail sent to the renderer', async () => {
    setupPaths()
    const dir = fakeProject('branch-tree', { versions: [1, 2, 3, 4] })
    writeFileSync(join(dir, 'versions/v4/version.json'), JSON.stringify({ parent: 2 }))
    expect((await detail('branch-tree')).versions.map((v) => [v.n, v.parent])).toEqual([[1, null], [2, 1], [3, 2], [4, 2]])
  })

  it('exposes both merge parents while preserving the single-parent reader', async () => {
    setupPaths()
    const dir = fakeProject('merge-tree', { versions: [1, 2, 3] })
    writeFileSync(join(dir, 'versions/v3/version.json'), JSON.stringify({ parent: 2, parents: [2, 1] }))
    const versions = await listVersions(dir)
    expect(versions.map((v) => v.parent)).toEqual([null, 1, 2])
    expect(versions[2].parents).toEqual([2, 1])
  })

  it('refuses a second parent that is not an older version', async () => {
    setupPaths()
    const dir = fakeProject('bad-merge-tree', { versions: [1, 2, 3] })
    writeFileSync(join(dir, 'versions/v3/version.json'), JSON.stringify({ parent: 2, parents: [2, 4] }))
    await expect(listVersions(dir)).rejects.toThrow(/parents.*3/i)
  })

  it('refuses corrupt ancestry rather than inventing a linear parent', async () => {
    setupPaths()
    const dir = fakeProject('corrupt-tree', { versions: [1, 2] })
    writeFileSync(join(dir, 'versions/v2/version.json'), JSON.stringify({ parent: 2 }))
    await expect(listVersions(dir)).rejects.toThrow(/parent.*2/i)
  })
})

const words = (n: number): Word[] => Array.from({ length: n }, (_, i) => ({ id: `w${i}`, w: `word${i}`, s: i, e: i + 0.5 }))

describe('titles and slugs', () => {
  it('makes a readable title from a file name', () => {
    expect(titleFromFile('/x/2026-10-14_my-first_take.mp4')).toBe('My first take')
    expect(titleFromFile('/x/2026-07-18_talkinghead_morning-routine-tips_take01.mp4')).toBe('Morning routine tips')
    expect(titleFromFile('/x/IMG_4412.MOV')).toBe('My reel')
    expect(titleFromFile('/x/20261017_093015.mp4')).toBe('My reel')
    expect(titleFromFile(join(tmpdir(), 'a', 'why so many apps.MOV'))).toBe('Why so many apps')
    expect(titleFromFile('/x/.mp4')).toBe('.mp4')
  })
  it('slugifies unicode safely', () => {
    expect(slugify('Café Crème: Take 2!')).toBe('cafe-creme-take-2')
    expect(slugify('文档 视频')).toBe('文档-视频')
    expect(slugify('***')).toBe('video')
    // fails if a reel titled after a Windows device name gets a folder Windows can't make
    for (const name of ['CON', 'prn', 'Aux', 'NUL', 'com1', 'LPT9']) expect(slugify(name)).toBe(`${name.toLowerCase()}-reel`)
    expect(slugify('Con artists')).toBe('con-artists')
    expect(slugify('COM10')).toBe('com10')
  })
  it('never reuses a slug', async () => {
    setupPaths()
    await ensureRoot()
    fakeProject('my-video')
    expect(await uniqueSlug('My video')).toBe('my-video-2')
  })
  // fails if two reels made at the same moment with one title get the same folder
  it('gives two reels made at once with the same title a folder each', async () => {
    setupPaths()
    const slugs = await Promise.all([uniqueSlug('Same title'), uniqueSlug('Same title'), uniqueSlug('Same title')])
    expect(slugs.sort()).toEqual(['same-title', 'same-title-2', 'same-title-3'])
    for (const slug of slugs) expect(existsSync(join(projectsDir(), slug))).toBe(true)
  })
})

describe('cut ranges', () => {
  it('round-trips keep ranges through kept ids', () => {
    const w = words(10)
    const keep = [
      { from: 'w0', to: 'w2' },
      { from: 'w5', to: 'w9' }
    ]
    const ids = keptIds(w, keep)
    expect(ids).toEqual(['w0', 'w1', 'w2', 'w5', 'w6', 'w7', 'w8', 'w9'])
    expect(rangesFromKept(w, new Set(ids))).toEqual(keep)
  })
  it('restoring one struck word merges ranges', () => {
    const w = words(5)
    const kept = new Set(keptIds(w, [{ from: 'w0', to: 'w1' }, { from: 'w3', to: 'w4' }]))
    kept.add('w2')
    expect(rangesFromKept(w, kept)).toEqual([{ from: 'w0', to: 'w4' }])
    expect(rangesKeepingOrder(w, [{ from: 'w0', to: 'w1' }, { from: 'w3', to: 'w4' }], kept)).toEqual([{ from: 'w0', to: 'w4' }])
  })
  it('hand edits keep a reordered cut in its order (review 28)', () => {
    const w = words(12)
    // The AI put the later take (w8-w11) first, then w0-w3.
    const keep = [
      { from: 'w8', to: 'w11' },
      { from: 'w0', to: 'w3' }
    ]
    const kept = new Set(keptIds(w, keep))
    kept.add('w4') // un-strike the word after w3
    expect(rangesKeepingOrder(w, keep, kept)).toEqual([
      { from: 'w8', to: 'w11' },
      { from: 'w0', to: 'w4' }
    ])
    kept.delete('w9') // strike a word inside the first range: it splits in place
    expect(rangesKeepingOrder(w, keep, kept)).toEqual([
      { from: 'w8', to: 'w8' },
      { from: 'w10', to: 'w11' },
      { from: 'w0', to: 'w4' }
    ])
    kept.add('w6') // a lone word comes back right after the nearest earlier kept word (w4)
    expect(rangesKeepingOrder(w, keep, kept).map((r) => r.from)).toEqual(['w8', 'w10', 'w0', 'w6'])
  })
  it('refuses manual word cuts on a mixed timeline instead of dropping clip items', () => {
    const keep = [{ from: 'w0', to: 'w2' }, { clip: 'c1', source: 's2', in: 0, out: 2 }]
    let refusal: unknown
    try {
      rangesKeepingOrder(words(3), keep, new Set(['w0', 'w2']))
    } catch (error) {
      refusal = error
    }
    expect(refusal).toMatchObject({ code: 'CLIP_CUT', userMessage: expect.stringMatching(/clip/i) })
    expect(keep).toHaveLength(2)
    expect(keep[1].clip).toBe('c1')
  })

  it('ignores ranges that point at unknown words', () => {
    expect(keptIds(words(3), [{ from: 'w9', to: 'w10' }])).toEqual([])
  })
})

describe('project store', () => {
  it('creates the Library folders with readable names', async () => {
    const { root } = setupPaths()
    await ensureRoot()
    for (const f of ['Raw takes', 'B-roll', 'Music', 'Images', 'Exports']) expect(existsSync(join(root, 'Library', f))).toBe(true)
    expect(existsSync(join(root, 'Projects'))).toBe(true)
  })

  it('lists projects with versions and skips broken folders', async () => {
    setupPaths()
    await ensureRoot()
    fakeProject('alpha', { versions: [1, 2] })
    mkdirSync(join(projectsDir(), 'broken'), { recursive: true })
    writeFileSync(join(projectsDir(), 'broken', 'project.json'), '{not json')
    const list = await listProjects()
    expect(list.map((p) => p.slug)).toEqual(['alpha'])
    expect(list[0].version).toBe(2)
    expect(list[0].status).toBe('ready')
    const d = await detail('alpha')
    expect(d.versions.map((v) => v.n)).toEqual([1, 2])
    expect(d.keptIds).toEqual(['w0', 'w1'])
    expect(d.versions[0].video.startsWith('reel-media://')).toBe(true)
  })

  it('fails if a reel is not found by a word said in it, or by its title', async () => {
    setupPaths()
    await ensureRoot()
    const dir = fakeProject('starter', { versions: [1] })
    fakeProject('other', { versions: [1] })
    const said = ['So', 'my', 'sourdough', 'starter', 'died,', 'twice.', 'Crème', 'fraîche', 'helps']
    writeFileSync(join(dir, 'work', 'transcript.json'), JSON.stringify({ words: said.map((w, i) => ({ id: `w${i}`, w, s: i, e: i + 0.5 })) }))
    expect(await searchProjects('died')).toEqual(['starter'])
    expect(await searchProjects('DIED twice')).toEqual(['starter'])
    expect(await searchProjects('creme fraiche')).toEqual(['starter'])
    expect(await searchProjects('starter cat')).toEqual([])
    expect(await searchProjects('ied')).toEqual([])
    expect(await searchProjects('title other')).toEqual(['other'])
  })

  it('fails if a reel counts as posted (Insights in the sidebar) without a posted record, or not with one', async () => {
    setupPaths()
    await ensureRoot()
    fakeProject('quiet', { versions: [1] })
    fakeProject('shared', { versions: [1] })
    await updateAppState('shared', (s) => {
      s.posted = [{ version: 1, platform: 'instagram', at: new Date().toISOString() }]
    })
    const list = await listProjects()
    expect(Object.fromEntries(list.map((p) => [p.slug, p.posted]))).toEqual({ quiet: false, shared: true })
  })

  it("fails if a Didn't finish card can't say why, or a reel that has a version still carries an old failure", async () => {
    setupPaths()
    await ensureRoot()
    fakeProject('stuck')
    fakeProject('recovered', { versions: [1] })
    for (const slug of ['stuck', 'recovered'])
      await updateAppState(slug, (s) => {
        s.status = 'failed'
        s.lastError = { code: 'NO_SPEECH', userMessage: 'No speech was heard in this video.' }
      })
    const list = await listProjects()
    expect(Object.fromEntries(list.map((p) => [p.slug, [p.status, p.failedWhy]]))).toEqual({
      stuck: ['failed', 'No speech was heard in this video.'],
      recovered: ['ready', null]
    })
  })

  it('cleans half-written versions and temp files', async () => {
    setupPaths()
    await ensureRoot()
    const dir = fakeProject('beta', { versions: [1], partial: [2] })
    mkdirSync(join(dir, 'versions', 'v3'), { recursive: true }) // empty: never got a video
    writeFileSync(join(dir, 'versions', 'v1', 'export.mp4.partial.mp4'), 'stray')
    mkdirSync(join(dir, 'versions', 'preview'), { recursive: true }) // engine scratch: left alone
    writeFileSync(join(dir, 'versions', 'preview', 'draft.mp4'), 'preview')
    const removed = await cleanPartialVersions(dir)
    expect(removed.length).toBe(3)
    expect((await listVersions(dir)).map((v) => v.n)).toEqual([1])
    expect(existsSync(join(dir, 'versions', 'v2'))).toBe(false)
    expect(existsSync(join(dir, 'versions', 'v1', 'export.mp4'))).toBe(true)
    expect(existsSync(join(dir, 'versions', 'preview', 'draft.mp4'))).toBe(true)
  })

  it('shows only finished versions; the preview only when there is no version yet (docs/versions.md)', async () => {
    setupPaths()
    await ensureRoot()
    const dir = fakeProject('epsilon', {})
    mkdirSync(join(dir, 'versions', 'preview'), { recursive: true })
    writeFileSync(join(dir, 'versions', 'preview', 'draft.mp4'), 'preview')
    mkdirSync(join(dir, 'versions', 'v1'), { recursive: true })
    writeFileSync(join(dir, 'versions', 'v1', 'draft.mp4'), 'old-style draft-only folder')
    expect((await listVersions(dir)).map((v) => [v.n, v.draft])).toEqual([[0, true]])
    writeFileSync(join(dir, 'versions', 'v1', 'export.mp4'), 'final')
    const p = JSON.parse(await fs.readFile(join(dir, 'project.json'), 'utf8'))
    writeFileSync(join(dir, 'project.json'), JSON.stringify({ ...p, version: 1 }))
    expect((await listVersions(dir)).map((v) => [v.n, v.draft])).toEqual([[1, false]])
  })

  it('cleanup after a failed job keeps a saved version that has lost its video', async () => {
    setupPaths()
    await ensureRoot()
    const dir = fakeProject('iota', { versions: [1] })
    await fs.rm(join(dir, 'versions', 'v1', 'export.mp4'))
    await cleanPartialVersions(dir)
    expect(existsSync(join(dir, 'versions', 'v1', 'cover.png'))).toBe(true)
  })

  it('the Subtitles list shows the lines of the saved version, not an older render\'s', async () => {
    setupPaths()
    await ensureRoot()
    const dir = fakeProject('kappa', { versions: [1] })
    const cues = (w: string) => ({ cues: [{ run: 0, tokens: [{ w, ids: ['w0'] }] }] })
    writeFileSync(join(dir, 'versions', 'v1', 'captions.json'), JSON.stringify(cues('now')))
    writeFileSync(join(dir, 'work', 'captions.json'), JSON.stringify(cues('before')))
    expect((await detail('kappa')).captionLines).toEqual([[{ w: 'now', ids: ['w0'], run: 0 }]])
  })

  it('before there is a version, the Subtitles list shows the preview\'s lines', async () => {
    setupPaths()
    await ensureRoot()
    const dir = fakeProject('lambda', {})
    mkdirSync(join(dir, 'versions', 'preview'), { recursive: true })
    writeFileSync(join(dir, 'versions', 'preview', 'captions.json'), JSON.stringify({ cues: [{ run: 0, tokens: [{ w: 'first', ids: ['w0'] }] }] }))
    expect((await detail('lambda')).captionLines).toEqual([[{ w: 'first', ids: ['w0'], run: 0 }]])
  })

  it("fails if a version stops carrying its receipts' facts, or a version from before receipts loses its chat tooltip", async () => {
    setupPaths()
    await ensureRoot()
    const dir = fakeProject('zeta', { versions: [1, 2, 3] })
    const fact = (after: number) => ({ kind: 'captions.style', field: 'size', before: 105, after })
    writeFileSync(join(dir, 'versions', 'v2', 'render.json'), JSON.stringify({ renderId: 'r_2' }))
    writeFileSync(join(dir, 'versions', 'v3', 'render.json'), JSON.stringify({ renderId: 'r_3b' }))
    writeFileSync(join(dir, 'versions', 'v3', 'receipts.json'), JSON.stringify([
      { jobId: 'j1', renderId: 'r_3a', version: 3, facts: [fact(126)] },
      { jobId: 'j2', renderId: 'r_3b', version: 3, facts: [fact(90)] }
    ]))
    const [v1, v2, v3] = await listVersions(dir)
    expect([v1.facts, v1.beforeReceipts]).toEqual([undefined, true])
    expect([v2.facts, v2.beforeReceipts]).toEqual([undefined, undefined])
    expect([v3.facts, v3.beforeReceipts]).toEqual([[fact(126), fact(90)], undefined])
  })

  it('recovers a project that was mid-render when the app quit', async () => {
    setupPaths()
    await ensureRoot()
    const dir = fakeProject('gamma', { versions: [1], partial: [2] })
    await updateAppState('gamma', (s) => {
      s.job = { id: 'j1', kind: 'note', startedAt: new Date().toISOString() }
    })
    const firstOnly = fakeProject('delta', {})
    await updateAppState('delta', (s) => {
      s.job = { id: 'j2', kind: 'first-edit', startedAt: new Date().toISOString() }
      s.status = 'working'
    })
    expect(await recoverInterrupted()).toEqual(expect.arrayContaining(['gamma', 'delta']))
    const g = await readAppState('gamma')
    expect(g.job).toBeNull()
    expect(g.status).toBe('ready')
    expect(g.chat.at(-1)?.text).toMatch(/closed before that change was finished/)
    expect(existsSync(join(dir, 'versions', 'v2'))).toBe(false)
    const d = await readAppState('delta')
    expect(d.status).toBe('interrupted')
    expect(existsSync(firstOnly)).toBe(true)
    // Running it again finds nothing to do.
    expect(await recoverInterrupted()).toEqual([])
  })

  it('an app.json that cannot be read is never taken for an empty one, so a write never erases the chat and the waiting notes', async () => {
    setupPaths()
    await ensureRoot()
    const dir = fakeProject('theta', { versions: [1] })
    const damaged = '{"chat": [{"id": "m1", "from": "you", "text": "make it pop"'
    writeFileSync(join(dir, 'app.json'), damaged)
    await expect(updateAppState('theta', (s) => void s.chat.push({ id: 'm2', from: 'editor', text: 'hi', at: '' }))).rejects.toMatchObject({ code: 'STATE_UNREADABLE' })
    expect(await fs.readFile(join(dir, 'app.json'), 'utf8')).toBe(damaged)
    expect((await listProjects()).map((p) => p.slug)).toContain('theta')
  })

  it('a note that never got saved is not a version, and leaves no private copy, before or after the app restarts', async () => {
    setupPaths()
    await ensureRoot()
    const dir = fakeProject('zeta', { versions: [1] })
    mkdirSync(join(dir, 'versions', 'v2'), { recursive: true }) // the app closed between the final render and the save
    writeFileSync(join(dir, 'versions', 'v2', 'export.mp4'), 'never saved')
    mkdirSync(join(dir, 'work', 'notes', 'j5'), { recursive: true })
    writeFileSync(join(dir, 'work', 'notes', 'j5', 'edit.json'), '{}')
    expect((await listVersions(dir)).map((v) => v.n)).toEqual([1])
    await updateAppState('zeta', (s) => {
      s.job = { id: 'j5', kind: 'note', startedAt: new Date().toISOString() }
    })
    await recoverInterrupted()
    expect((await readAppState('zeta')).chat.at(-1)?.text).toMatch(/closed before that change was finished/)
    expect((await listVersions(dir)).map((v) => v.n)).toEqual([1])
    expect(existsSync(join(dir, 'work', 'notes', 'j5'))).toBe(false)
  })

  it('the app closed right after a note was saved: once project.json can be read, its reply and question are posted once', async () => {
    setupPaths()
    await ensureRoot()
    const dir = fakeProject('eta', { versions: [1, 2] })
    const p = JSON.parse(await fs.readFile(join(dir, 'project.json'), 'utf8'))
    p.notes = [{ id: 'j6', version: 2, text: 'from now on more room', applied: ['cut'], at: p.updatedAt,
      reply: 'I gave the pauses more room. I also saved this to My style for your future reels: "Leave more room." You can remove it in Settings.',
      styleRulesAdded: ['Leave more room.'] }]
    await updateAppState('eta', (s) => {
      s.job = { id: 'j6', kind: 'note', startedAt: new Date().toISOString() }
    })
    // unreadable for now (another program is writing it): the note may be saved, so nothing is said yet
    writeFileSync(join(dir, 'project.json'), JSON.stringify(p).slice(0, 80))
    expect(await recoverInterrupted()).toEqual([])
    expect((await readAppState('eta')).job?.id).toBe('j6')
    expect((await readAppState('eta')).chat).toEqual([])
    writeFileSync(join(dir, 'project.json'), JSON.stringify(p))
    await recoverInterrupted()
    const chat = (await readAppState('eta')).chat
    expect(chat.map((m) => [m.text, m.version, m.suggestion])).toEqual([
      ['I gave the pauses more room.', 2, undefined],
      ['Remember this for next time? "Leave more room."', undefined, 'Leave more room.']
    ])
    expect(await recoverInterrupted()).toEqual([])
    expect((await readAppState('eta')).chat).toHaveLength(2)
  })

  it('writes json atomically (no temp files left behind)', async () => {
    const { home } = setupPaths()
    const f = join(home, 'a b.json')
    await writeJson(f, { x: 1 })
    await writeJson(f, { x: 2 })
    expect(JSON.parse(await fs.readFile(f, 'utf8'))).toEqual({ x: 2 })
    expect((await fs.readdir(home)).filter((n) => n.endsWith('.tmp'))).toEqual([])
  })

  it('shows an attached clip the AI placed, now its frozen copy, with the attachment\'s still', async () => {
    setupPaths()
    await ensureRoot()
    const dir = fakeProject('zeta', { versions: [1] })
    const clip = `work/assets/frozen/video/${'a'.repeat(64)}.mp4`
    const other = `work/assets/frozen/video/${'b'.repeat(64)}.mp4`
    const p = JSON.parse(await fs.readFile(join(dir, 'project.json'), 'utf8'))
    p.broll = [clip, other].map((asset, i) => ({ id: `b${i + 1}`, anchor: { from: 'w0', to: 'w1' }, treatment: 'side-card', asset }))
    writeFileSync(join(dir, 'project.json'), JSON.stringify(p))
    mkdirSync(join(dir, 'work', 'thumbs'), { recursive: true })
    mkdirSync(join(dir, 'work', 'assets'), { recursive: true })
    const still = join(dir, 'work', 'thumbs', 'attach-0a1b2c3d-dance.jpg')
    writeFileSync(still, 'still')
    writeFileSync(join(dir, 'work', 'thumbs', 'secret.jpg'), 'not a still')
    // the AI's asset ledger: a torn line, and a record whose source is not an attachment
    const ledger = [
      { committedPath: clip, provenance: { intent: 'work/assets/attach-0a1b2c3d-dance.mp4' } },
      { committedPath: other, provenance: { intent: 'work/thumbs/secret.jpg' } }
    ]
    writeFileSync(join(dir, 'work', 'assets', 'manifest.jsonl'), `{"committedPath":\n${ledger.map((r) => JSON.stringify(r)).join('\n')}\n`)
    const d = await detail('zeta')
    expect(pathFromMediaUrl(d.brollThumbs.b1)).toBe(still)
    expect(d.brollThumbs.b2).toBeUndefined()
  })

  it('stores Library paths relative to the root', () => {
    setupPaths()
    expect(rootRelative(join(reelStudioRoot(), 'Library', 'Music', 'song.mp3'))).toBe('Library/Music/song.mp3')
    expect(rootRelative('/elsewhere/song.mp3')).toBe('/elsewhere/song.mp3')
  })
})

describe('library sorting fallback', () => {
  it('sorts by file type and explains what it left alone', async () => {
    const { home } = setupPaths()
    await ensureRoot()
    const song = join(home, 'my song.mp3')
    const pic = join(home, 'logo ü.png')
    const doc = join(home, 'notes.docx')
    for (const f of [song, pic, doc]) writeFileSync(f, 'x')
    const r = await classifyByExtension([song, pic, doc, song])
    expect(r.map((x) => x.bin)).toEqual(['music', 'images', null, 'music'])
    expect(r[2].reason).toMatch(/not a video, song or picture/)
    expect(r[3].dest).toBe(join(binDir('music'), 'my song (2).mp3'))
  })
})

describe('app.json under concurrent access', () => {
  it('keeps every update and leaves no temp files while being read constantly', async () => {
    setupPaths()
    await ensureRoot()
    const dir = fakeProject('busy', { versions: [1] })
    let reading = true
    const reader = (async () => {
      let n = 0
      while (reading) {
        await readAppState('busy')
        // Another process (antivirus, the AI package) reading the file now and then.
        if (n % 3 === 0) await fs.readFile(join(dir, 'app.json')).catch(() => null)
        await new Promise((r) => setTimeout(r, 1))
        n++
      }
      return n
    })()
    await Promise.all(
      Array.from({ length: 60 }, (_, i) =>
        updateAppState('busy', (s) => {
          s.chat.push({ id: String(i), from: 'you', text: `note ${i}`, at: '' })
        })
      )
    )
    reading = false
    expect(await reader).toBeGreaterThan(0)
    const s = await readAppState('busy')
    expect(s.chat.map((m) => m.id).sort((a, b) => Number(a) - Number(b))).toEqual(Array.from({ length: 60 }, (_, i) => String(i)))
    expect((await fs.readdir(dir)).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })
})

describe('brollLabel (grandma3 #9: only pictures are called pictures)', () => {
  const b = (treatment: string, asset: string | null) => ({ id: treatment, anchor: { from: 'w0', to: 'w1' }, treatment, asset })
  it('names pictures, animations and text cards apart', () => {
    expect(brollLabel([b('card-above-head', 'Library/Images/a.jpg')])).toBe('Added 1 picture')
    expect(brollLabel([b('text-pop', null), b('animation', 'anim-1'), b('animation', 'anim-2')])).toBe('Added 2 animations and 1 text card')
    expect(brollLabel([b('side-card', 'x.jpg'), b('full-frame', 'y.mp4'), b('animation', 'a'), b('text-pop', null)])).toBe(
      'Added 2 pictures, 1 animation and 1 text card'
    )
  })
})

describe('a reel planned before it has a video', () => {
  // fails if New reel (⌘N) pressed again makes a second empty reel, or leaving one keeps it on Reels
  it('reuses an untouched New reel and removes it on leaving; anything done to it keeps it', async () => {
    setupPaths()
    const idle = () => false
    const first = await planReel(idle)
    expect(await planReel(idle)).toBe(first)
    // a job running on it (a script being written) keeps it, and New reel makes another
    expect(await discardIfUntouched(first, (s) => s === first)).toBe(false)
    expect(await planReel((s) => s === first)).not.toBe(first)
    expect(await discardIfUntouched(first, idle)).toBe(true)
    const left = (await listProjects()).map((p) => p.slug)
    expect(left).not.toContain(first)
    expect(left).toHaveLength(1)

    const renamed = left[0]
    await updateAppState(renamed, (s) => void (s.title = 'Sourdough'))
    const planned = await planReel(idle)
    await updateAppState(planned, (s) => void s.chat.push(stamp({ from: 'you', text: 'an idea', plan: true })))
    const dropped = await planReel(idle)
    fakeProject(dropped) // its video arrived
    for (const slug of [renamed, planned, dropped]) expect(await discardIfUntouched(slug, idle)).toBe(false)
    expect((await listProjects()).map((p) => p.slug).sort()).toEqual([renamed, planned, dropped].sort())
  })

  // fails if attaching a video to a planned reel loses its script: the editor reads it from project.json
  it('lists as planned, then carries its newest script into the project the video makes', async () => {
    setupPaths()
    const slug = await createPlanned()
    expect((await listProjects()).find((p) => p.slug === slug)).toMatchObject({ title: 'New reel', status: 'planned', version: 0 })
    // writing a script is a job, and the reel stays planned through it
    await updateAppState(slug, (s) => void (s.job = { id: 'j1', kind: 'script', startedAt: '' }))
    expect((await listProjects()).find((p) => p.slug === slug)?.status).toBe('planned')
    await updateAppState(slug, (s) => void (s.job = null))
    const older = { hook: 'old hook', script: 'old script', onScreenText: [] }
    const newest = { hook: 'Flour, water, salt.', script: 'You do not need a mixer.', onScreenText: ['No mixer'], title: 'Sourdough in 60 seconds' }
    await updateAppState(slug, (s) => {
      s.chat.push(stamp({ from: 'you', text: 'sourdough without a mixer', plan: true }))
      s.chat.push(stamp({ from: 'editor', text: 'Here is a script.', plan: true, script: older }))
      s.chat.push(stamp({ from: 'editor', text: 'Here is another.', plan: true, script: newest }))
      s.status = 'working'
    })
    // what `engine init` leaves when the video arrives
    fakeProject(slug)
    await carryScript(slug)
    expect((await readProject(slug)).script).toEqual(newest)
    expect((await detail(slug)).chat.filter((m) => m.script).map((m) => m.script)).toEqual([older, newest])
  })

  // fails if quitting while a script is written leaves the idea with no answer and no way to send it again
  it('settles a script cut short by a quit as stopped, and stays planned', async () => {
    setupPaths()
    const slug = await createPlanned()
    await updateAppState(slug, (s) => {
      s.chat.push(stamp({ from: 'you', text: 'an idea', plan: true, jobId: 'j9' }))
      s.job = { id: 'j9', kind: 'script', startedAt: '' }
    })
    expect(await settleInterrupted(slug)).toBe('settled')
    const st = await readAppState(slug)
    expect([st.status, st.job, st.chat[0].outcome]).toEqual(['planned', null, 'stopped'])
  })

  // fails if a reel stopped during its copy (no project.json) whose dropped file is gone reads as a pause that Resume
  // continues, or one whose file is still there reads as failed; and if a partial copy counts as the video
  it('a Version 1 stopped during its copy is a pause while its file opens, and COPY_GONE once it does not', async () => {
    setupPaths()
    await ensureRoot()
    const dir = join(projectsDir(), 'half-copied')
    mkdirSync(join(dir, 'media'), { recursive: true })
    writeFileSync(join(dir, 'media', 'take01.mp4'), 'half')
    const dropped = join(tmpdir(), `dropped-${process.pid}.mp4`)
    writeFileSync(dropped, 'a video')
    await updateAppState('half-copied', (s) => {
      s.status = 'interrupted'
      s.title = 'My take'
      s.copyFrom = [dropped]
    })
    const there = await summary('half-copied')
    expect([there?.status, there?.failedCode, there?.take]).toEqual(['interrupted', null, null])
    await fs.rm(dropped)
    const gone = await summary('half-copied')
    expect([gone?.status, gone?.failedCode, gone?.failedWhy]).toEqual(['failed', 'COPY_GONE', 'Your video was only partly copied, and the file you dropped can’t be opened any more.'])
    expect((await detail('half-copied')).lastError?.code).toBe('COPY_GONE')
  })

  // fails if Home lists a reel as being made while the editor only reads it for more reels, or a quit then leaves
  // "Send your note again" for a note nobody sent
  it('keeps a reel ready on Home while the editor looks for more reels in it, and settles a look cut short without a line', async () => {
    setupPaths()
    await ensureRoot()
    fakeProject('looked', { versions: [1] })
    await updateAppState('looked', (s) => void (s.job = { id: 'j7', kind: 'propose', startedAt: '' }))
    expect((await summary('looked'))?.status).toBe('ready')
    expect(await settleInterrupted('looked')).toBe('settled')
    const st = await readAppState('looked')
    expect([st.job, st.chat]).toEqual([null, []])
  })
})
