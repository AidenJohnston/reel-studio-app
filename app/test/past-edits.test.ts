import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { countsOf, findPastEdits, type FindDeps } from '../src/main/past-edits'
import { readLesson } from '../src/main/style-learn'
import { validateIpcArgs } from '../src/main/ipc-guard'
import { makePastEditsHome } from '../e2e/past-edits-home'
import { APP_DIR, PYTHON } from './helpers'

const fresh = (): string => mkdtempSync(join(tmpdir(), 'past-edits-'))
const shape = (found: Awaited<ReturnType<typeof findPastEdits>>['edits']) => found.map((f) => [f.file, f.app, f.kind, f.readable, f.where])

describe('Learn from my past edits: finding them', () => {
  it('finds each editor’s exports, libraries and projects where they are kept, newest first, and leaves out copies', async () => {
    const home = fresh()
    makePastEditsHome(home)
    const look = await findPastEdits({ platform: 'darwin', home, spotlight: null })
    expect(look.cut).toBe(false)
    expect(shape(look.edits)).toEqual([
      ['Spring launch.fcpxml', 'Final Cut Pro', 'fcpxml', true, 'Movies › Exports'],
      ['Untitled.fcpbundle', 'Final Cut Pro', 'fcpbundle', false, 'Movies'],
      ['talking-head.xml', 'Premiere Pro', 'premiere-xml', true, 'Desktop'],
      ['Interview.prproj', 'Premiere Pro', 'prproj', false, 'Documents › Adobe › Premiere Pro › 26.0'],
      ['Kitchen tour.fcpxmld', 'Final Cut Pro', 'fcpxmld', true, 'Movies › Exports']
    ])
  })

  it('adds what Spotlight finds on another drive, but nothing from system folders or inside a bundle', async () => {
    const home = fresh()
    const drive = fresh()
    mkdirSync(join(drive, 'Edits', 'Big day.fcpbundle'), { recursive: true })
    mkdirSync(join(drive, 'Edits', 'Cut.fcpxmld'), { recursive: true })
    writeFileSync(join(drive, 'Edits', 'Cut.fcpxmld', 'Info.fcpxml'), '<fcpxml/>')
    const asked: string[] = []
    const found = await findPastEdits({
      platform: 'darwin',
      home,
      spotlight: async (q) => {
        asked.push(q)
        return { paths: [join(drive, 'Edits', 'Big day.fcpbundle'), join(drive, 'Edits', 'Cut.fcpxmld', 'Info.fcpxml'), '/Library/Application Support/Sample.fcpxml'], cut: false }
      }
    })
    expect(found.edits.map((f) => f.file)).toEqual(['Big day.fcpbundle'])
    expect(asked).toHaveLength(3)
  })

  it('fails if a CapCut project where CapCut keeps it is missed, listed twice, or its recycle bin is listed', async () => {
    for (const [platform, base] of [['darwin', 'Movies'], ['win32', join('AppData', 'Local')]] as const) {
      const home = fresh()
      const projects = join(home, base, 'CapCut', 'User Data', 'Projects', 'com.lveditor.draft')
      const draft = (folder: string, files: string[]) => {
        mkdirSync(join(projects, folder), { recursive: true })
        for (const f of files) writeFileSync(join(projects, folder, f), '{}')
      }
      // CapCut on a Mac writes draft_info.json; some builds keep draft_content.json beside it
      draft('Bread reel', ['draft_content.json', 'draft_info.json', 'draft_meta_info.json'])
      draft('.recycle_bin', ['draft_content.json'])
      const look = await findPastEdits({ platform, home, spotlight: null })
      expect(shape(look.edits)).toEqual([['Bread reel/draft_content.json', 'CapCut', 'capcut', true, 'CapCut']])
      expect(look.edits[0].name).toBe('Bread reel')
    }
  })

  it('keeps the same id for the same file across looks, so ticks survive a refresh', async () => {
    const home = fresh()
    makePastEditsHome(home)
    const a = (await findPastEdits({ platform: 'darwin', home, spotlight: null })).edits
    const b = (await findPastEdits({ platform: 'darwin', home, spotlight: null })).edits
    expect(b.map((f) => f.id)).toEqual(a.map((f) => f.id))
    expect(new Set(a.map((f) => f.id)).size).toBe(a.length)
  })

  it('pairs reference-scan’s counts and reasons back to the edits by path, and refuses another shape', () => {
    const edit = (id: string, path: string) => ({ id, path, name: id, file: id, where: '', app: 'Premiere Pro' as const, kind: 'premiere-xml' as const, modified: '', readable: true })
    const found = [edit('a', '/x/a.xml'), edit('b', '/x/b.xml')]
    expect(countsOf(found, { files: [{ path: '/x/a.xml', timelines: 2 }, { path: '/x/b.xml', error: { code: 'NO_TIMELINE', message: 'No timeline.' } }, { path: '/elsewhere.xml', timelines: 1 }] })).toEqual({
      a: { timelines: 2 },
      b: { problem: 'No timeline.' }
    })
    expect(() => countsOf(found, { timelines: 1 })).toThrow('reference-scan returned no files list')
  })

  it('takes found edits by id only, never a path from the page', () => {
    expect(() => validateIpcArgs('style:learn', [['0123456789abcdef']])).not.toThrow()
    expect(() => validateIpcArgs('style:learn', [])).not.toThrow()
    expect(() => validateIpcArgs('style:learn', [['/Users/someone/secret.xml']])).toThrow()
    expect(() => validateIpcArgs('style:learn', [[]])).toThrow()
    expect(() => validateIpcArgs('style:reveal', ['/etc/passwd'])).toThrow()
  })

  it('says it was cut short when a limit stops the walk, and keeps what it found', async () => {
    const home = fresh()
    makePastEditsHome(home)
    const look = await findPastEdits({ platform: 'darwin', home, spotlight: null, limits: { walk: 3 } })
    expect(look.cut).toBe(true)
    expect(look.edits.length).toBeLessThan(5)
  })

  it('opens only the newest XML files to look for Premiere exports, and says older ones were not looked at', async () => {
    const home = fresh()
    const desk = join(home, 'Desktop')
    mkdirSync(desk)
    const xml = readFileSync(join(APP_DIR, '..', 'engine', 'tests', 'fixtures', 'reference-import', 'talking-head.xml'))
    for (let day = 1; day <= 5; day++) {
      const p = join(desk, `cut ${day}.xml`)
      writeFileSync(p, xml)
      utimesSync(p, new Date(Date.UTC(2026, 9, day)), new Date(Date.UTC(2026, 9, day)))
    }
    const look = await findPastEdits({ platform: 'darwin', home, spotlight: null, limits: { sniff: 2 } })
    expect(look).toMatchObject({ cut: true })
    expect(look.edits.map((e) => e.name)).toEqual(['cut 5', 'cut 4'])
    expect((await findPastEdits({ platform: 'darwin', home, spotlight: null, limits: { sniff: 5 } })).cut).toBe(false)
  })

  it('takes at most the Spotlight limit from each query, and says so when Spotlight had more', async () => {
    const home = fresh()
    const drive = fresh()
    const libraries = Array.from({ length: 6 }, (_, i) => join(drive, `Edit ${i}.fcpbundle`))
    for (const l of libraries) mkdirSync(l)
    const asked: number[] = []
    const spotlight: FindDeps['spotlight'] = async (q, max) => {
      asked.push(max)
      // a Spotlight that hands back everything is still held to the limit
      return q.includes('fcpbundle') ? { paths: libraries, cut: false } : { paths: [], cut: false }
    }
    const look = await findPastEdits({ platform: 'darwin', home, spotlight, limits: { spotlight: 4 } })
    expect(asked).toEqual([4, 4])
    expect(look.cut).toBe(true)
    expect(look.edits).toHaveLength(4)
  })

  it('reads at most the concurrency limit of files at once', async () => {
    const home = fresh()
    const paths = Array.from({ length: 40 }, (_, i) => `/Volumes/Drive/Edit ${i}.fcpbundle`)
    let now = 0
    let most = 0
    const look = await findPastEdits({
      platform: 'darwin',
      home,
      spotlight: async () => ({ paths, cut: false }),
      limits: { concurrency: 4 },
      fs: {
        async stat() {
          most = Math.max(most, ++now)
          await new Promise((r) => setTimeout(r, 2))
          now--
          return { mtimeMs: 0, size: 0, isDirectory: () => true }
        },
        head: async () => null
      }
    })
    expect(look.edits).toHaveLength(40)
    expect(most).toBe(4)
  })

  // fails if a lesson carries a file's path to the page; discovery names edits by id, and so does what it read
  // fails if a CapCut lesson says "draft_content.json" with no project, or names another editor
  it('names a CapCut project in a lesson by its folder and the draft read in it', async () => {
    const lesson = await readLesson(['/x/Bread reel'], async () => ({ source: { adapter: 'capcut', path: '/x/Bread reel/draft_info.json', writer: 'CapCut' }, timelines: [] }))
    expect(lesson.files).toEqual([{ id: expect.stringMatching(/^[0-9a-f]{16}$/), name: 'Bread reel/draft_info.json', editor: 'CapCut' }])
  })

  it('what a lesson says about its files has names and ids, never a path', async () => {
    const dir = fresh()
    const good = join(dir, 'Spring launch.fcpxml')
    const bad = join(dir, 'broken.xml')
    const lesson = await readLesson([good, bad], async (file) => {
      if (file === bad) throw { code: 'BAD_XML', userMessage: 'This file isn’t a readable edit export.' }
      return { source: { adapter: 'fcpx_xml', path: file }, timelines: [] }
    })
    expect(lesson.files).toEqual([{ id: expect.stringMatching(/^[0-9a-f]{16}$/), name: 'Spring launch.fcpxml', editor: 'Final Cut Pro' }])
    expect(lesson.skipped).toEqual([{ name: 'broken.xml', reason: 'This file isn’t a readable edit export.' }])
    expect(JSON.stringify(lesson)).not.toContain(dir)
  })

  // fails if the e2e stand-in engine counts timelines differently from the real one (it once showed 2 for an
  // export the real engine reads 1 from, because it counted every event's projects)
  it('the stand-in engine’s reference-scan counts timelines as the real engine does', () => {
    const fixtures = join(APP_DIR, '..', 'engine', 'tests', 'fixtures', 'reference-import')
    // talking-head.xml with its sequence listed again under a project's children, by the same id: one timeline
    const text = readFileSync(join(fixtures, 'talking-head.xml'), 'utf8')
    const sequence = text.slice(text.indexOf('  <sequence id="seq-1">'), text.indexOf('</xmeml>'))
    const twice = join(fresh(), 'same-id-twice.xml')
    writeFileSync(twice, text.replace('</xmeml>', `<project><name>Cuts</name><children>${sequence}</children></project></xmeml>`))
    const files = [
      ...['cut.fcpxmld', 'ntsc-lanes.fcpxml', 'talking-head.xml', 'resolve-timeline.fcpxml', 'resolve-cut.edl', 'capcut-draft', join('capcut-draft', 'draft_content.json')].map((f) => join(fixtures, f)),
      twice
    ]
    // each package as `python -m reelengine` runs it: the real one starts in cli.run, the stand-in in __main__.main
    const scan = (pythonPath: string) => {
      const out = execFileSync(PYTHON, ['-I', '-c', 'import runpy, sys; sys.path.insert(0, sys.argv.pop(1)); sys.argv[0] = "reelengine"; runpy.run_module("reelengine", run_name="__main__")', pythonPath, 'reference-scan', ...files], { encoding: 'utf8' })
      const done = JSON.parse(out.trim().split('\n').pop()!)
      return done.result.files.map((f: { timelines?: number }) => f.timelines)
    }
    const real = scan(join(APP_DIR, '..', 'engine'))
    expect(real).toEqual([1, 1, 1, 1, 1, 1, 1, 1])
    expect(scan(join(APP_DIR, 'dev', 'fake-engine'))).toEqual(real)
  })
})
