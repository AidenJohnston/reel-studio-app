// A Library song the AI picks is frozen into the project. The checklist names the song and the Music tab
// checks it, both from music.track, so track must stay Library/Music/<name> after choose_music.
import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, promises as fs, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { executeTool, newToolState, StyleStore, withDefaults, type EngineHost } from '@reelstudio/ai'
import { checklist } from '../src/main/store'
import type { ProjectJson } from '../src/shared/api'

/** Only `freeze-asset`, as the engine does it: the song copied to work/assets/frozen/music/<sha256>.mp3. */
function freezingEngine(root: string): EngineHost {
  return {
    reelStudioRoot: () => root,
    renderAnimation: async () => {
      throw new Error('not used')
    },
    async runEngine(command, args) {
      if (command !== 'freeze-asset') throw { code: 'UNKNOWN_COMMAND', userMessage: `unknown ${command}` }
      const dir = args[args.indexOf('--project') + 1]
      const bytes = await fs.readFile(join(root, args[args.indexOf('--asset') + 1]))
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      const committedPath = `work/assets/frozen/music/${sha256}.mp3`
      await fs.mkdir(join(dir, 'work', 'assets', 'frozen', 'music'), { recursive: true })
      await fs.writeFile(join(dir, committedPath), bytes)
      return { committedPath, sha256, mime: 'audio/mpeg' }
    }
  }
}

describe('a song the AI froze', () => {
  it('is named on the checklist and keeps the Library path the Music tab checks', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rs frozen song ü '))
    const dir = join(root, 'Projects', 'my video')
    mkdirSync(join(root, 'Library', 'Music'), { recursive: true })
    mkdirSync(join(dir, 'work'), { recursive: true })
    writeFileSync(join(root, 'Library', 'Music', 'lofi beat.mp3'), Buffer.concat([Buffer.from('ID3'), Buffer.alloc(32)]))
    writeFileSync(join(dir, 'work', 'transcript.json'), JSON.stringify({ words: [{ id: 'w0', source: 's1', s: 0, e: 0.3, w: 'hi' }] }))
    writeFileSync(join(dir, 'project.json'), JSON.stringify(withDefaults({ title: 'My video', slug: 'my-video' })))
    const ctx = { projectDir: dir, host: freezingEngine(root), style: new StyleStore(() => root), emit: () => {}, state: newToolState(), supportsImages: false }

    const r = await executeTool(ctx, 'choose_music', { track: 'Library/Music/lofi beat.mp3', startAt: 12 })
    expect(r.isError, r.content).toBe(false)

    const p: ProjectJson = JSON.parse(await fs.readFile(join(dir, 'project.json'), 'utf8'))
    expect(checklist(p, [], [], []).find((i) => i.key === 'music')).toMatchObject({ label: 'Added music', done: true, detail: 'lofi beat' })
    expect(p.music?.track).toBe('Library/Music/lofi beat.mp3')
  })
})
