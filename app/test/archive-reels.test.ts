import { mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { expect, it } from 'vitest'
import { createArchiveReels, libraryRef, seedFromArchive } from '../src/main/archive-reels'
import { projectDir, readAppState, readProject, writeJson } from '../src/main/store'
import { setupPaths } from './helpers'

const A = 'Footage/src-0123abcd/a.mp4'
const B = 'Library/Raw takes/b.mp4'
const CANDIDATES = [
  { id: 'r1', title: 'Keep your starter alive', hook: 'My starter died twice.', why: 'I joined the routine to the sign.', seconds: 20,
    spans: [{ ref: A, t0: 5, t1: 15, said: 'one' }, { ref: B, t0: 2, t1: 7, said: 'two' }, { ref: A, t0: 30, t1: 35, said: 'three' }] },
  { id: 'r2', title: 'Warm water', hook: 'Warm, not hot.', why: 'One tip on its own.', seconds: 16, spans: [{ ref: B, t0: 8, t1: 24, said: 'four' }] },
]
const HASHES = { [A]: 'hash-a', [B]: 'hash-b' }

function setup(over: { start?: () => string; get?: (id: string) => { done: Promise<void> } | undefined; firstEdit?: () => string; now?: Record<string, string> } = {}) {
  const { root } = setupPaths()
  const file = join(root, '..', 'archive-reels.json')
  const started: { slug: string; files: string[]; marked: Record<string, string> }[] = []
  const engine: string[][] = []
  const archive = createArchiveReels({
    jobs: { start: over.start ?? (() => 'job-1'), get: over.get ?? (() => undefined) },
    ai: () => ({ active: async () => ({ id: 'claude', connected: true, label: 'Claude' }), proposeFromArchive: async () => ({ candidates: [], notes: '', attempts: 1 }) }),
    runEngine: async (_cmd, args) => {
      engine.push(args)
      const asked = args.filter((_, i) => args[i - 1] === '--ref')
      return { files: Object.entries(over.now ?? HASHES).filter(([ref]) => asked.includes(ref)).map(([ref, hash]) => ({ ref, hash })) }
    },
    root: () => root,
    file: () => file,
    resolve: async (ref) => `/footage/${ref.split('/').pop()}`,
    // what is on disk as the job is admitted: a quit from here on must not let the pick be made again
    startFirstEdit: over.firstEdit ?? ((slug, init) => (started.push({ slug, files: init.files, marked: JSON.parse(readFileSync(file, 'utf8')).made }), 'job-2'))
  })
  return { root, file, archive, started, engine }
}

const stored = (file: string) => writeJson(file, { at: 'now', candidates: CANDIDATES, notes: '', made: {}, truncated: false, hashes: HASHES })

// what engine init writes for those two files, s1 then s2 (--keep-order)
const copied = (sources: object[]) => JSON.stringify({ title: 'Keep your starter alive', sources, cut: { keep: [], gapCap: 0.25 } })
const S1 = { id: 's1', path: 'media/take01.mp4', originalName: 'a.mp4', duration: 34.996 }
const S2 = { id: 's2', path: 'media/take02.mp4', originalName: 'b.mp4', duration: 30 }

it('fails if a pick copies a file twice, puts spans on the wrong source or past its end, or can be made twice', async () => {
  const { file, archive, started } = setup()
  await stored(file)
  const { made } = await archive.make(['r1'])
  // each file once, in the order the reel first uses it, so engine init numbers them s1, s2
  expect(started).toEqual([{ slug: made[0].slug, files: ['/footage/a.mp4', '/footage/b.mp4'], marked: { r1: made[0].slug } }])
  const st = await readAppState(made[0].slug)
  expect(st.fromArchive!.spans).toEqual([{ file: 0, t0: 5, t1: 15 }, { file: 1, t0: 2, t1: 7 }, { file: 0, t0: 30, t1: 35 }])
  // a quit before the job records what it copies from still leaves a reel that copies in on Resume
  expect(st.copyFrom).toEqual(['/footage/a.mp4', '/footage/b.mp4'])
  expect((await archive.status()).candidates[0].made).toBe(made[0].slug)
  await expect(archive.make(['r1'])).rejects.toMatchObject({ code: 'ALREADY_MADE' })
  await expect(archive.make(['r9'])).rejects.toMatchObject({ code: 'PROPOSAL_GONE' })

  // ---- once engine init copied the files in: the spans become the cut, as clips on s1/s2, once ----
  const dir = projectDir(made[0].slug)
  writeFileSync(join(dir, 'project.json'), copied([S1, S2]))
  await seedFromArchive(made[0].slug)
  const p = await readProject(made[0].slug)
  // the last part ends 4 ms past the copy (times are rounded in the index): it stops at the copy's end
  expect(p.cut!.keep).toEqual([
    { clip: 'c1', source: 's1', in: 5, out: 15 }, { clip: 'c2', source: 's2', in: 2, out: 7 }, { clip: 'c3', source: 's1', in: 30, out: 34.996 },
  ])
  expect(p.proposal).toMatchObject({ archive: true, title: 'Keep your starter alive', files: ['a.mp4', 'b.mp4'] })
  // a resume leaves a seeded reel alone, even after its first edit changed the cut
  p.cut!.keep = []
  writeFileSync(join(dir, 'project.json'), JSON.stringify(p))
  await seedFromArchive(made[0].slug)
  expect((await readProject(made[0].slug)).cut!.keep).toEqual([])
})

it('fails if a reel is cut from sources that did not copy in as proposed', async () => {
  const cases: [string, object[]][] = [
    ['one file missing', [S1]],
    // engine init sorted them by capture date: the times of a.mp4 would land on b.mp4
    ['the files in another order', [{ ...S2, id: 's1' }, { ...S1, id: 's2' }]],
    // the copy is far shorter than the parts the editor read
    ['a shorter file', [{ ...S1, duration: 20 }, S2]],
  ]
  for (const [what, sources] of cases) {
    const { file, archive } = setup()
    await stored(file)
    const { made } = await archive.make(['r1'])
    writeFileSync(join(projectDir(made[0].slug), 'project.json'), copied(sources))
    await expect(seedFromArchive(made[0].slug), what).rejects.toMatchObject({ code: 'SOURCES_CHANGED' })
  }
})

it('fails if a file swapped since the editor read it is cut by its times, or one bad pick leaves others made', async () => {
  const { file, archive, started, engine } = setup({ now: { ...HASHES, [B]: 'another-b' } })
  await stored(file)
  await expect(archive.make(['r1', 'r2'])).rejects.toMatchObject({ code: 'FOOTAGE_CHANGED', userMessage: 'b.mp4 changed since your editor read it. Find reels again.' })
  // the engine is asked about these files only
  expect(engine).toEqual([['digest', '--root', expect.any(String), '--ref', A, '--ref', B]])
  expect(started).toEqual([])
  expect((await archive.status()).candidates.map((c) => c.made)).toEqual([null, null])
})

it('fails if a reel whose first edit could not start is left behind or counted as made', async () => {
  const { file, archive } = setup({ firstEdit: () => { throw { code: 'QUITTING', userMessage: 'Reel Studio is closing.' } } })
  await stored(file)
  const reels = dirname(projectDir('any'))
  const list = () => (readdirSync(reels, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name))
  mkdirSync(reels, { recursive: true })
  const before = list()
  await expect(archive.make(['r2'])).rejects.toMatchObject({ code: 'QUITTING' })
  expect((await archive.status()).candidates.map((c) => c.made)).toEqual([null, null])
  expect(list()).toEqual(before)
})

it('fails if a second Find starts a second look, or a look stopped before it began stays "finding"', async () => {
  let ended!: () => void
  const done = new Promise<void>((r) => (ended = r))
  let starts = 0
  // the job is queued behind another: its work never runs before the Stop
  const { archive } = setup({ start: () => `job-${++starts}`, get: (id) => (id === 'job-1' ? { done } : undefined) })
  const [one, two] = await Promise.all([archive.find(), archive.find()])
  expect([one, two, starts]).toEqual([{ jobId: 'job-1' }, { jobId: 'job-1' }, 1])
  expect((await archive.status()).state).toBe('finding')
  ended()
  await done
  await Promise.resolve()
  expect(await archive.status()).toMatchObject({ state: 'idle', jobId: undefined })
})

it('fails if a Library ref reaches a file outside the Library or something that is not a file', async () => {
  const { root } = setupPaths()
  const lib = join(root, 'Library')
  mkdirSync(join(lib, 'Raw takes'), { recursive: true })
  writeFileSync(join(lib, 'Raw takes', 'b.mp4'), 'v')
  writeFileSync(join(root, 'secret.mp4'), 'v')
  const refused = ['Library/../secret.mp4', 'Library\\..\\secret.mp4', 'Library/Raw takes', 'Library/gone.mp4', 'Footage/x/b.mp4']
  try {
    symlinkSync(join(root, 'secret.mp4'), join(lib, 'Raw takes', 'link.mp4'))
    refused.push('Library/Raw takes/link.mp4')
  } catch {
    /* Windows without the right to make links: no link can be planted there either */
  }
  expect(await libraryRef('Library/Raw takes/b.mp4', lib)).toBe(realpathSync(join(lib, 'Raw takes', 'b.mp4')))
  for (const ref of refused) {
    await expect(libraryRef(ref, lib), ref).rejects.toMatchObject({ code: 'FILE_GONE' })
  }
})
