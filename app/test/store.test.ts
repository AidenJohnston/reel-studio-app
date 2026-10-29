import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, promises as fs, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  cleanPartialVersions,
  ensureRoot,
  keptIds,
  listProjects,
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
  brollLabel
} from '../src/main/store'
import { classifyByExtension } from '../src/main/library'
import { binDir, projectsDir, reelStudioRoot } from '../src/main/paths'
import { setupPaths } from './helpers'
import type { Word } from '../src/shared/api'

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

const words = (n: number): Word[] => Array.from({ length: n }, (_, i) => ({ id: `w${i}`, w: `word${i}`, s: i, e: i + 0.5 }))

describe('titles and slugs', () => {
  it('makes a readable title from a file name', () => {
    expect(titleFromFile('/x/2026-10-14_my-first_take.mp4')).toBe('My first take')
    expect(titleFromFile('/x/2026-07-18_talkinghead_morning-routine-tips_take01.mp4')).toBe('Morning routine tips')
    expect(titleFromFile('/x/IMG_4412.MOV')).toBe('My video')
    expect(titleFromFile('/x/20261017_093015.mp4')).toBe('My video')
    expect(titleFromFile(join(tmpdir(), 'a', 'why so many apps.MOV'))).toBe('Why so many apps')
    expect(titleFromFile('/x/.mp4')).toBe('.mp4')
  })
  it('slugifies unicode safely', () => {
    expect(slugify('Café Crème: Take 2!')).toBe('cafe-creme-take-2')
    expect(slugify('文档 视频')).toBe('文档-视频')
    expect(slugify('***')).toBe('video')
  })
  it('never reuses a slug', async () => {
    setupPaths()
    await ensureRoot()
    fakeProject('my-video')
    expect(await uniqueSlug('My video')).toBe('my-video-2')
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
    expect(g.chat.at(-1)?.text).toMatch(/closed before I finished/)
    expect(existsSync(join(dir, 'versions', 'v2'))).toBe(false)
    const d = await readAppState('delta')
    expect(d.status).toBe('interrupted')
    expect(existsSync(firstOnly)).toBe(true)
    // Running it again finds nothing to do.
    expect(await recoverInterrupted()).toEqual([])
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
    expect((await readAppState('zeta')).chat.at(-1)?.text).toMatch(/closed before I finished/)
    expect((await listVersions(dir)).map((v) => v.n)).toEqual([1])
    expect(existsSync(join(dir, 'work', 'notes', 'j5'))).toBe(false)
  })

  it('the app closed right after a note was saved: once project.json can be read, its reply and question are posted once', async () => {
    setupPaths()
    await ensureRoot()
    const dir = fakeProject('eta', { versions: [1, 2] })
    const p = JSON.parse(await fs.readFile(join(dir, 'project.json'), 'utf8'))
    p.notes = [{ id: 'j6', version: 2, text: 'from now on more room', applied: ['cut'], at: p.updatedAt,
      reply: 'I gave the pauses more room. I also saved this to My style for your future videos: "Leave more room." You can remove it in Settings.',
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
