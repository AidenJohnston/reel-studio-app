import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createArchiveReels, seedFromArchive } from '../src/main/archive-reels'
import { projectDir, readAppState, readProject, writeJson } from '../src/main/store'
import { setupPaths } from './helpers'

const CANDIDATES = [
  { id: 'r1', title: 'Keep your starter alive', hook: 'My starter died twice.', why: 'I joined the routine to the sign.', seconds: 20,
    spans: [
      { ref: 'Footage/src-0123abcd/a.mp4', t0: 5, t1: 15, said: 'one' },
      { ref: 'Library/Raw takes/b.mp4', t0: 2, t1: 7, said: 'two' },
      { ref: 'Footage/src-0123abcd/a.mp4', t0: 30, t1: 35, said: 'three' },
    ] },
]

function setup() {
  const { root } = setupPaths()
  const file = join(root, '..', 'archive-reels.json')
  const started: { slug: string; files: string[] }[] = []
  const archive = createArchiveReels({
    jobs: { start: () => 'job-1' },
    ai: () => ({ active: async () => ({ id: 'claude', connected: true, label: 'Claude' }), proposeFromArchive: async () => ({ candidates: [], notes: '', attempts: 1 }) }),
    runEngine: async () => ({ files: [] }),
    root: () => root,
    file: () => file,
    resolve: async (ref) => `/footage/${ref.split('/').pop()}`,
    startFirstEdit: (slug, init) => (started.push({ slug, files: init.files }), 'job-2')
  })
  return { root, file, archive, started }
}

it('fails if a pick copies a file twice, puts spans on the wrong source, or can be made twice', async () => {
  const { file, archive, started } = setup()
  await writeJson(file, { at: 'now', candidates: CANDIDATES, notes: '', made: {}, truncated: false })
  const { made } = await archive.make(['r1'])
  // each file once, in the order the reel first uses it, so engine init numbers them s1, s2
  expect(started).toEqual([{ slug: made[0].slug, files: ['/footage/a.mp4', '/footage/b.mp4'] }])
  const seed = (await readAppState(made[0].slug)).fromArchive!
  expect(seed.spans).toEqual([{ file: 0, t0: 5, t1: 15 }, { file: 1, t0: 2, t1: 7 }, { file: 0, t0: 30, t1: 35 }])
  expect((await archive.status()).candidates[0].made).toBe(made[0].slug)
  await expect(archive.make(['r1'])).rejects.toMatchObject({ code: 'ALREADY_MADE' })
  await expect(archive.make(['r9'])).rejects.toMatchObject({ code: 'PROPOSAL_GONE' })

  // ---- once engine init copied the files in: the spans become the cut, as clips on s1/s2, once ----
  const dir = projectDir(made[0].slug)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'project.json'), JSON.stringify({ title: 'Keep your starter alive', sources: [{ id: 's1', path: 'media/take01.mp4' }, { id: 's2', path: 'media/take02.mp4' }], cut: { keep: [], gapCap: 0.25 } }))
  await seedFromArchive(made[0].slug)
  const p = await readProject(made[0].slug)
  expect(p.cut!.keep).toEqual([
    { clip: 'c1', source: 's1', in: 5, out: 15 }, { clip: 'c2', source: 's2', in: 2, out: 7 }, { clip: 'c3', source: 's1', in: 30, out: 35 },
  ])
  expect(p.proposal).toMatchObject({ archive: true, title: 'Keep your starter alive', files: ['a.mp4', 'b.mp4'] })
  // a resume leaves a seeded reel alone, even after its first edit changed the cut
  p.cut!.keep = []
  writeFileSync(join(dir, 'project.json'), JSON.stringify(p))
  await seedFromArchive(made[0].slug)
  expect((await readProject(made[0].slug)).cut!.keep).toEqual([])
})

it('fails if a reel is cut from sources that did not copy in as proposed', async () => {
  const { file, archive } = setup()
  await writeJson(file, { at: 'now', candidates: CANDIDATES, notes: '', made: {}, truncated: false })
  const { made } = await archive.make(['r1'])
  const dir = projectDir(made[0].slug)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'project.json'), JSON.stringify({ title: 'x', sources: [{ id: 's1', path: 'media/take01.mp4' }], cut: { keep: [] } }))
  await expect(seedFromArchive(made[0].slug)).rejects.toMatchObject({ code: 'SOURCES_CHANGED' })
})
