// A song the AI places is frozen into the project. The checklist names the song and the Music tab checks
// it from music.track: a Library song keeps its Library path there, and a song from anywhere else keeps its
// frozen path, which the checklist names by its ledger title instead of the hash.
import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdirSync, promises as fs, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { executeTool, newToolState, StyleStore, withDefaults, type EngineHost, type ToolContext } from '@reelstudio/ai'
import { detail, ensureRoot } from '../src/main/store'
import { projectsDir } from '../src/main/paths'
import { setupPaths } from './helpers'

const SONG = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(32)])

/** The engine commands choose_music and resolve_asset use for a song, reduced to what they write. */
function songEngine(root: string): EngineHost {
  const file = (dir: string, ref: string) => (ref.startsWith('Library/') ? join(root, ref) : join(dir, ref))
  return {
    reelStudioRoot: () => root,
    renderAnimation: async () => {
      throw new Error('not used')
    },
    async runEngine(command, args) {
      const dir = args[args.indexOf('--project') + 1]
      const ref = args[args.indexOf('--asset') + 1]
      if (command === 'inspect-audio') {
        const preview = args[args.indexOf('--preview') + 1]
        await fs.mkdir(join(dir, 'work', 'thumbs'), { recursive: true })
        await fs.writeFile(join(dir, preview), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])) // a PNG's signature
        const sha256 = createHash('sha256').update(await fs.readFile(file(dir, ref))).digest('hex')
        return { previewPath: preview, durationSec: 2, loudnessLufs: -20, sha256, mime: 'audio/mpeg' }
      }
      if (command === 'freeze-asset') {
        const bytes = await fs.readFile(file(dir, ref))
        const sha256 = createHash('sha256').update(bytes).digest('hex')
        const committedPath = `work/assets/frozen/music/${sha256}.mp3`
        await fs.mkdir(join(dir, 'work', 'assets', 'frozen', 'music'), { recursive: true })
        await fs.writeFile(join(dir, committedPath), bytes)
        return { committedPath, sha256, mime: 'audio/mpeg' }
      }
      if (command === 'hash-asset') return { sha256: createHash('sha256').update(await fs.readFile(file(dir, ref))).digest('hex') }
      throw { code: 'UNKNOWN_COMMAND', userMessage: `unknown ${command}` }
    }
  }
}

async function project(slug: string): Promise<{ ctx: ToolContext; dir: string }> {
  const { root } = setupPaths()
  await ensureRoot()
  const dir = join(projectsDir(), slug)
  mkdirSync(join(root, 'Library', 'Music'), { recursive: true })
  mkdirSync(join(dir, 'work'), { recursive: true })
  writeFileSync(join(dir, 'work', 'transcript.json'), JSON.stringify({ words: [{ id: 'w0', source: 's1', s: 0, e: 0.3, w: 'hi' }] }))
  writeFileSync(join(dir, 'project.json'), JSON.stringify(withDefaults({ title: 'My video', slug })))
  const ctx = { projectDir: dir, host: songEngine(root), style: new StyleStore(() => root), emit: () => {}, state: newToolState(), supportsImages: false }
  return { ctx, dir }
}

const musicItem = async (slug: string) => (await detail(slug)).checklist.find((i) => i.key === 'music')

describe('a song the AI froze', () => {
  it('is named on the checklist and keeps the Library path the Music tab checks', async () => {
    const { ctx, dir } = await project('library-song')
    writeFileSync(join(ctx.host.reelStudioRoot(), 'Library', 'Music', 'lofi beat.mp3'), SONG)
    const r = await executeTool(ctx, 'choose_music', { track: 'Library/Music/lofi beat.mp3', startAt: 12 })
    expect(r.isError, r.content).toBe(false)
    expect(await musicItem('library-song')).toMatchObject({ label: 'Added music', done: true, detail: 'lofi beat' })
    expect(JSON.parse(await fs.readFile(join(dir, 'project.json'), 'utf8')).music.track).toBe('Library/Music/lofi beat.mp3')
  })

  it('from outside the Library is named on the checklist by its ledger title, not its hash', async () => {
    const { ctx } = await project('project-song')
    mkdirSync(join(ctx.projectDir, 'work', 'downloads'), { recursive: true })
    writeFileSync(join(ctx.projectDir, 'work', 'downloads', 'beach walk.mp3'), SONG)
    // a project file has no licence of its own: only the commentary policy offers it
    const staged = await executeTool(ctx, 'resolve_asset', { kind: 'music', intent: 'work/downloads/beach walk.mp3', licensePolicy: 'commentary' })
    expect(staged.isError, staged.content).toBe(false)
    const candidateId = JSON.parse(staged.content).candidates[0].id
    const committed = await executeTool(ctx, 'resolve_asset', { kind: 'music', intent: 'work/downloads/beach walk.mp3', phase: 'commit', candidateId })
    expect(committed.isError, committed.content).toBe(false)
    const r = await executeTool(ctx, 'choose_music', { track: JSON.parse(committed.content).asset.assetId })
    expect(r.isError, r.content).toBe(false)
    expect(await musicItem('project-song')).toMatchObject({ label: 'Added music', done: true, detail: 'beach walk' })
  })
})
