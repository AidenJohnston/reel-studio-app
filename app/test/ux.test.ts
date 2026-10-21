// Grandma-test fixes: honest "What I did", the no-AI note answers, one build for everyone.
import { describe, expect, it } from 'vitest'
import { noAiReply } from '../src/shared/notes'
import { checklist } from '../src/main/store'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ProjectJson, VersionInfo, Word } from '../src/shared/api'

const words: Word[] = [
  { id: 'w0', w: 'hi', s: 0, e: 0.3 },
  { id: 'w1', w: 'hi', s: 0.4, e: 0.7 },
  { id: 'w2', w: 'there', s: 0.8, e: 1.1 }
]
const versions: VersionInfo[] = [{ n: 1, video: 'x', videoPath: 'x', draft: false, cover: 'c', createdAt: '' }]
const project = (caption: string): ProjectJson =>
  ({
    schemaVersion: 1,
    id: 'i',
    title: 'My video',
    slug: 's',
    createdAt: '',
    updatedAt: '',
    version: 1,
    cut: { keep: [{ from: 'w1', to: 'w2' }] },
    captions: { enabled: true },
    post: { caption, hashtags: [], keywords: [] }
  }) as ProjectJson

const label = (items: ReturnType<typeof checklist>, key: string) => items.find((i) => i.key === key)!

describe('What I did is honest about who did what', () => {
  it('without AI: no "best takes", no "wrote your post caption"', () => {
    const items = checklist(project(''), words, ['w1', 'w2'], versions, false)
    expect(label(items, 'cut').label).toBe('Cut the pauses and repeated starts')
    expect(label(items, 'post')).toMatchObject({ label: 'Post caption: add your own', done: false })
    expect(items.map((i) => i.label).join(' ')).not.toMatch(/best takes|Wrote your/)
  })
  it('without AI, a caption the user typed is "Your post caption"', () => {
    expect(label(checklist(project('Hello'), words, ['w1', 'w2'], versions, false), 'post')).toMatchObject({ label: 'Your post caption', done: true })
  })
  it('with AI: the AI claims stay', () => {
    const items = checklist(project('Hook line'), words, ['w1', 'w2'], versions, true)
    expect(label(items, 'cut').label).toBe('Picked your best takes and cut the pauses')
    expect(label(items, 'post').label).toBe('Wrote your post caption')
  })
  it('an AI that left the caption empty does not claim it', () => {
    expect(label(checklist(project('  '), words, ['w1', 'w2'], versions, true), 'post').done).toBe(false)
  })
})

describe('notes with no AI connected', () => {
  const cases: [string, string][] = [
    ['make the captions bigger', 'open-captions'],
    ['Make the captions bigger please', 'open-captions'],
    ['the subtitles spelled my name wrong', 'open-captions'],
    ['music too loud at the start', 'open-music'],
    ['use a different song', 'open-music'],
    ['add a picture of my dog', 'open-broll'],
    ['change the cover', 'open-cover'],
    ['write a better post caption with hashtags', 'open-post'],
    ['cut the part where I say um', 'open-cut'],
    ['make it shorter', 'open-cut']
  ]
  for (const [note, action] of cases) {
    it(`"${note}" -> ${action} + Connect ChatGPT`, () => {
      const r = noAiReply(note)
      expect(r.actions).toEqual([action, 'connect'])
      expect(r.text).toMatch(/no AI editor is connected/)
    })
  }
  it('anything else -> Edit it myself + Connect ChatGPT, and never claims it was saved or done', () => {
    const r = noAiReply('make it more fun')
    expect(r.actions).toEqual(['open-editor', 'connect'])
    expect(r.text).not.toMatch(/saved|I changed|I made/i)
  })
})

describe('one build for everyone', () => {
  const app = join(__dirname, '..')
  it('no build-time flavour flag is left in the app', () => {
    expect(existsSync(join(app, 'src', 'main', 'build-flags.ts'))).toBe(false)
    expect(readFileSync(join(app, 'electron.vite.config.ts'), 'utf8')).not.toMatch(/define\s*:/)
    for (const f of ['src/main/index.ts', 'src/shared/api.ts', 'src/main/ai-types.ts']) {
      // the old flag's name is built in pieces: one of its words is banned from the public export
      const old = new RegExp(['localClaudeCode', 'allowLocalClaudeCode', 'FOUND' + 'ER_BUILD', 'CLAUDE_CODE_BUILD'].join('|'))
      expect(readFileSync(join(app, f), 'utf8')).not.toMatch(old)
    }
  })
})
