// Stand-in for @reelstudio/ai when the real package is not available. Same interface (ai-types.ts).
// It runs the deterministic "no AI connected" path from docs/architecture.md section 8: transcribe, analyze,
// autocut, music from the Library, render. It never pretends to be a real AI provider.
import { existsSync, promises as fs } from 'node:fs'
import { join, extname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { writeJson } from './store'
import type { AgentEvent, AgentResult, AI, CreateAI, ProviderStatus, ScriptResult } from './ai-types'
import type { Phase } from '../shared/api'

const MUSIC_EXT = new Set(['.mp3', '.m4a', '.wav', '.aac', '.flac', '.ogg'])

const NOT_CONNECTED: ProviderStatus = { id: 'none', connected: true, label: 'No AI' }

/** Maps an engine stage pct (0-100) into an overall window [lo, hi]. */
const span = (lo: number, hi: number, pct: number): number => Math.round(lo + ((hi - lo) * pct) / 100)

export const createMockAI: CreateAI = ({ host }) => {
  const styleFile = (): string => join(host.reelStudioRoot(), 'My style.json')

  async function readRules(): Promise<{ id: string; text: string; createdAt: string }[]> {
    try {
      const j = JSON.parse(await fs.readFile(styleFile(), 'utf8'))
      return Array.isArray(j.rules) ? j.rules : []
    } catch {
      return []
    }
  }
  async function writeRules(rules: { id: string; text: string; createdAt: string }[]): Promise<void> {
    await fs.mkdir(host.reelStudioRoot(), { recursive: true })
    await fs.writeFile(styleFile(), JSON.stringify({ rules }, null, 2) + '\n', 'utf8')
  }

  async function readProject(dir: string): Promise<any> {
    return JSON.parse(await fs.readFile(join(dir, 'project.json'), 'utf8'))
  }
  async function writeProject(dir: string, p: any): Promise<void> {
    p.updatedAt = new Date().toISOString()
    await writeJson(join(dir, 'project.json'), p) // retries on Windows locks (review 32)
  }

  async function firstMusicTrack(): Promise<string | null> {
    const dir = join(host.reelStudioRoot(), 'Library', 'Music')
    if (!existsSync(dir)) return null
    const files = (await fs.readdir(dir)).filter((f) => MUSIC_EXT.has(extname(f).toLowerCase())).sort()
    return files.length ? `Library/Music/${files[0]}` : null
  }

  const ai: AI = {
    async providers() {
      return [
        { id: 'chatgpt', connected: false, label: 'ChatGPT' },
        { id: 'claude', connected: false, label: 'Claude' },
        NOT_CONNECTED
      ]
    },
    async active() {
      return NOT_CONNECTED
    },
    async setActive() {},
    async signInChatGPT() {
      throw { code: 'NOT_READY', userMessage: 'Signing in with ChatGPT is not ready in this build yet. Your videos still work without it.' }
    },
    async signOutChatGPT() {},
    async setClaudeKey(key) {
      if (!key) return { id: 'none', connected: true, label: 'No AI' }
      throw { code: 'NOT_READY', userMessage: 'Claude keys are not ready in this build yet. Your videos still work without it.' }
    },

    async firstEdit(projectDir, onEvent, signal): Promise<AgentResult> {
      const args = ['--project', projectDir]
      // phases like the real package's no-AI path, so the job flow's bar and time left work here too
      const status = (message: string, pct: number, phase?: Phase): void => onEvent({ type: 'status', message, pct, ...(phase ? { phase } : {}) })
      const changed: string[] = []

      status('Listening to your video', 1, 'listen')
      await host.runEngine('transcribe', args, (p) => status(p.message || 'Listening to your video', p.pct, 'listen'), signal)

      status('Picking your best takes', 41, 'analyze')
      await host.runEngine('analyze', args, (p) => status('Picking your best takes', span(0, 50, p.pct), 'analyze'), signal)
      await host.runEngine('autocut', args, (p) => status('Picking your best takes', span(50, 100, p.pct), 'analyze'), signal)
      changed.push('cut')
      onEvent({ type: 'tool', name: 'autocut', summary: 'Cut out the pauses and do-overs' })

      // Tests only (REELSTUDIO_MOCK_FIRST_LOOK=<ms>): act like the real package with an AI: a first look,
      // then a while "thinking", so the Working screen's first look + thinking state can be driven.
      const hold = Number(process.env.REELSTUDIO_MOCK_FIRST_LOOK || 0)
      if (hold > 0) {
        const look = await host.runEngine('render', [...args, '--draft'], undefined, signal)
        onEvent({ type: 'render', version: 0, draft: true, firstLook: true, ...(look?.file ? { file: String(look.file) } : {}) })
        onEvent({ type: 'status', message: 'Watching your video and planning the edit', pct: 5, phase: 'edit', thinking: true })
        await new Promise((r) => setTimeout(r, hold))
      }

      status('Adding music', 56)
      const track = await firstMusicTrack()
      const p = await readProject(projectDir)
      if (track) {
        p.music = { ...(p.music ?? {}), enabled: true, track, startAt: 0, level: 'under-voice' }
        changed.push('music')
        onEvent({ type: 'tool', name: 'choose_music', summary: `Picked a song: ${track.split('/').pop()}` })
      }
      // No post caption here: nothing smart ran, so the user writes it ("Post caption: add your own").
      await writeProject(projectDir, p)

      status('Making your cover', 60)
      status('Putting it all together', 0, 'final')
      const r = await host.runEngine('render', args, (pr) => status(pr.message || 'Putting it all together', pr.pct, 'final'), signal)
      const version = Number(r?.version ?? (await readProject(projectDir)).version ?? 1)
      onEvent({ type: 'render', version, draft: false })
      status('Done', 100)

      return {
        summary: track
          ? 'Your video is ready. I cut out the pauses, added subtitles, music and a cover. Connect ChatGPT and I can also pick your best takes and add pictures.'
          : 'Your video is ready. I cut out the pauses and added subtitles and a cover. Add a song for music, and connect ChatGPT so I can pick your best takes and add pictures.',
        version,
        styleRulesAdded: [],
        changed
      }
    },

    async applyNote(projectDir, note, onEvent): Promise<AgentResult> {
      onEvent({ type: 'status', message: 'Reading your note', pct: 10, phase: 'edit' })
      const p = await readProject(projectDir)
      const added: string[] = []
      if (/\b(always|never|every video|from now on|in general)\b/i.test(note)) {
        const rules = await readRules()
        rules.push({ id: randomUUID(), text: note.trim(), createdAt: new Date().toISOString() })
        await writeRules(rules)
        added.push(note.trim())
      }
      p.notes = [...(p.notes ?? []), { version: p.version ?? 0, text: note, applied: [], at: new Date().toISOString() }]
      await writeProject(projectDir, p)
      onEvent({ type: 'status', message: 'Done', pct: 100 })
      return {
        summary: added.length
          ? 'I saved that to My style. Connect ChatGPT in Settings and I can change this video from your notes too.'
          : 'I saved your note. Connect ChatGPT in Settings and I can change the video from notes like this one. You can also tweak it yourself under "Show me how".',
        version: p.version ?? 0,
        styleRulesAdded: added,
        changed: []
      }
    },

    async writeScript(): Promise<ScriptResult> {
      throw { code: 'NO_AI', userMessage: 'Connect ChatGPT or Claude in Settings and I can help you write a script.' }
    },

    async styleRules() {
      return readRules()
    },
    async addStyleRule(text) {
      const rule = { id: randomUUID(), text, createdAt: new Date().toISOString() }
      await writeRules([...(await readRules()), rule])
      return rule
    },
    async removeStyleRule(id) {
      await writeRules((await readRules()).filter((r) => r.id !== id))
    }
  }
  return ai
}
