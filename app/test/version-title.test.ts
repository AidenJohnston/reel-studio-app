import { expect, it } from 'vitest'
import { acceptRewrite, describeFacts, versionTitle, versionTooltip } from '../src/shared/describe'
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

const cutWords = Array.from({ length: 24 }, (_, i) => ({ id: `w${i}`, w: `word${i}`, s: i, e: i + 0.5 }))
const cutAndMusic = [
  { kind: 'cut.keep', before: [{ from: 'w0', to: 'w23' }], after: [{ from: 'w20', to: 'w23' }] },
  { kind: 'music.enabled', before: true, after: false }
]

it.each([
  { title: 'Shorter cut', summary: 'cut 20 words' },
  { title: 'Shorter cut, no music', summary: 'cut 20 words' },
  { title: 'Shorter cut', summary: 'cut 20 words, no music' },
  { title: 'Shorter cut and more', summary: 'cut 20 words and more' },
  { title: 'Shorter cut, more', summary: 'cut 20 words, no music' }
])('rejects an incomplete rewording: $title / $summary', (reply) => {
  expect(describeFacts(cutAndMusic, cutWords)).toBe('cut 20 words, no music')
  expect(acceptRewrite(reply, cutAndMusic, cutWords)).toBeNull()
})

it('keeps a complete rewording or a title ending in the app\'s own "and more" form', () => {
  const facts = [...cutAndMusic, { kind: 'post.caption', before: '', after: 'Bread' }]
  const summary = 'cut 20 words, no music, new post caption'
  expect(versionTitle(facts, cutWords)).toBe('Shorter cut, no music and more')
  for (const title of ['Shorter cut, no music, new post caption', versionTitle(facts, cutWords)]) {
    expect(acceptRewrite({ title, summary }, facts, cutWords)).toEqual({ title, summary })
  }
})

it('keeps the app\'s own name and music removal in the tooltip when the model omits them', async () => {
  setupPaths()
  const dir = versionTwo('bread')
  writeFileSync(join(dir, 'work', 'transcript.json'), JSON.stringify({ words: cutWords }))
  writeFileSync(join(dir, 'versions', 'v2', 'receipts.json'), JSON.stringify([{ jobId: 'j', renderId: 'r', version: 2, facts: cutAndMusic }]))
  await titleVersion('bread', 2, async () => ({ title: 'Shorter cut', summary: 'cut 20 words' }))
  const version = (await listVersions(dir))[0]
  expect(version.wording).toBeUndefined()
  expect(versionTitle(version.facts!, cutWords)).toBe('Shorter cut, no music')
  expect(versionTooltip(version, [], cutWords)).toBe('Version 2: cut 20 words, no music.')
})

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
    return { title: 'Bigger subtitles, two words cut', summary: 'cut 2 words and made the subtitles bigger.' }
  })
  expect((await listVersions(dir))[0].wording).toEqual({ title: 'Bigger subtitles, two words cut', summary: 'cut 2 words and made the subtitles bigger' })

  // a later note that changed only the post caption added its receipt to the same version: the old name no longer covers it
  const receipts = join(dir, 'versions', 'v2', 'receipts.json')
  writeFileSync(receipts, JSON.stringify([{ jobId: 'j', renderId: 'r', version: 2, facts }, { jobId: 'k', renderId: 'r2', version: 2, facts: [{ kind: 'post.caption', before: '', after: 'Bread' }] }]))
  expect((await listVersions(dir))[0].wording).toBeUndefined()
})
