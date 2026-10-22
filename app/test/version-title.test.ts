import { expect, it } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { listVersions, projectDir } from '../src/main/store'
import { titleVersion } from '../src/main/version-title'
import { setupPaths } from './helpers'

const words = Array.from({ length: 6 }, (_, i) => ({ id: `w${i}`, w: `word${i}`, s: i, e: i + 0.5 }))
const facts = [
  { kind: 'cut.keep', before: [{ from: 'w0', to: 'w5' }], after: [{ from: 'w2', to: 'w5' }] },
  { kind: 'captions.style', field: 'size', before: 105, after: 126 }
]

function versionTwo(slug: string): string {
  const dir = projectDir(slug)
  const v2 = join(dir, 'versions', 'v2')
  mkdirSync(v2, { recursive: true })
  mkdirSync(join(dir, 'work'))
  writeFileSync(join(dir, 'project.json'), JSON.stringify({ version: 2, cut: { keep: [{ from: 'w2', to: 'w5' }] } }))
  writeFileSync(join(dir, 'work', 'transcript.json'), JSON.stringify({ words }))
  writeFileSync(join(v2, 'export.mp4'), 'video')
  writeFileSync(join(v2, 'receipts.json'), JSON.stringify([{ jobId: 'j', renderId: 'r', version: 2, facts }]))
  return dir
}

it('fails if a model rewording that claims a change the receipts lack, or the wrong direction or amount, is kept instead of the app’s own title', async () => {
  setupPaths()
  const dir = versionTwo('bread')
  for (const wrong of [
    { title: 'Shorter cut, new song', summary: 'cut 2 words and added a song' },
    { title: 'Shorter cut, smaller subtitles', summary: 'cut 2 words, smaller subtitles' },
    { title: 'Five words gone, bigger subtitles', summary: 'cut 5 words, bigger subtitles' }
  ]) {
    await titleVersion('bread', 2, async () => wrong)
    expect((await listVersions(dir))[0].wording, wrong.title).toBeUndefined()
  }

  await titleVersion('bread', 2, async (asked) => {
    expect(asked).toEqual({ title: 'Shorter cut, bigger subtitles', summary: 'cut 2 words, bigger subtitles' })
    return { title: 'Two words gone, bigger subtitles', summary: 'cut 2 words and made the subtitles bigger.' }
  })
  expect((await listVersions(dir))[0].wording).toEqual({ title: 'Two words gone, bigger subtitles', summary: 'cut 2 words and made the subtitles bigger' })

  // a later note that changed only the post caption added its receipt to the same version: the old name no longer covers it
  const receipts = join(dir, 'versions', 'v2', 'receipts.json')
  writeFileSync(receipts, JSON.stringify([{ jobId: 'j', renderId: 'r', version: 2, facts }, { jobId: 'k', renderId: 'r2', version: 2, facts: [{ kind: 'post.caption', before: '', after: 'Bread' }] }]))
  expect((await listVersions(dir))[0].wording).toBeUndefined()
})
