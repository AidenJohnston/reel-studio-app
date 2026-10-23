// Stand-in for @reelstudio/ai when the real package is not available. Same interface (ai-types.ts).
// It runs the deterministic "no AI connected" path from docs/architecture.md section 8: transcribe, analyze,
// autocut, music from the Library, render. It never pretends to be a real AI provider.
import { constants, existsSync, promises as fs } from 'node:fs'
import { basename, join, extname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { serialized, writeJson } from './store'
import type { AgentEvent, AgentResult, AI, ClaudeCodeStatus, CreateAI, ProviderStatus, ScriptResult } from './ai-types'
import type { Phase, StyleRule } from '../shared/api'

const MUSIC_EXT = new Set(['.mp3', '.m4a', '.wav', '.aac', '.flac', '.ogg'])

const NOT_CONNECTED: ProviderStatus = { id: 'none', connected: true, label: 'No AI' }

// The person's own Claude Code app, as tests want it (REELSTUDIO_MOCK_CLAUDE). Default: not on this computer.
// `signs_in` starts signed out and becomes ready a moment after the sign-in window "opens" (no terminal opens in
// mock mode), so the Connect screen's waiting and re-checking can be driven.
const CLAUDE_LABEL = 'Claude (your Claude Code app)'
const CLAUDE_REASONS: Record<ClaudeCodeStatus['state'], string | undefined> = {
  missing: 'We could not find the Claude Code app on this computer.',
  broken: 'We found the Claude Code app, but it did not start. Try installing it again.',
  signed_out: 'Your Claude Code app is not signed in yet.',
  ready: undefined
}
const MOCK_CLAUDE_BIN = process.platform === 'win32' ? 'C:\\Program Files\\Mock Claude\\claude.exe' : '/opt/mock claude/bin/claude'

/** Maps an engine stage pct (0-100) into an overall window [lo, hi]. */
const span = (lo: number, hi: number, pct: number): number => Math.round(lo + ((hi - lo) * pct) / 100)

/** Copies `file` to "<name>.damaged.json", or "<name>.damaged 2.json" and so on when that is taken. Never overwrites. */
async function keepDamagedCopy(file: string): Promise<string> {
  const stem = file.replace(/\.json$/i, '')
  for (let n = 1; ; n++) {
    const copy = `${stem}.damaged${n > 1 ? ` ${n}` : ''}.json`
    try {
      await fs.copyFile(file, copy, constants.COPYFILE_EXCL)
      return copy
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
    }
  }
}

/** My style.json: the rules, plus whatever else the real package stores there (kept on every write). */
type StyleData = { rules: StyleRule[]; damaged?: string; [field: string]: unknown }

export const createMockAI: CreateAI = ({ host }) => {
  const styleFile = (): string => join(host.reelStudioRoot(), 'My style.json')

  /** Read as the real package reads it (ai/src/style.ts): no file is an empty My style, a damaged one is kept as a copy
   * next to it and My style starts over, and any other read error throws, so no save replaces rules it could not read. */
  async function readStyle(): Promise<StyleData> {
    let text: string
    try {
      text = await fs.readFile(styleFile(), 'utf8')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { rules: [] }
      throw e
    }
    let j: any = null
    try {
      j = JSON.parse(text.replace(/^\uFEFF/, ''))
    } catch {
      /* damaged: kept below */
    }
    if (Array.isArray(j?.rules)) return j
    const fresh: StyleData = { version: 1, rules: [], damaged: basename(await keepDamagedCopy(styleFile())) }
    await writeJson(styleFile(), fresh)
    return fresh
  }
  /** Each read or change of the whole file runs one at a time, or two changes at once lose one of them. */
  const withStyle = <T>(fn: (s: StyleData) => Promise<T>): Promise<T> => serialized(styleFile(), async () => fn(await readStyle()))
  async function saveRules(s: StyleData, rules: StyleRule[]): Promise<void> {
    await fs.mkdir(host.reelStudioRoot(), { recursive: true })
    await writeJson(styleFile(), { ...s, rules })
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

  const mode = process.env.REELSTUDIO_MOCK_CLAUDE ?? 'missing'
  let claudeState: ClaudeCodeStatus['state'] =
    mode === 'signs_in' ? 'signed_out' : (['missing', 'broken', 'signed_out', 'ready'] as const).find((s) => s === mode) ?? 'missing'
  let claudeChosen = false
  const claudeStatus = (): ClaudeCodeStatus => ({
    state: claudeState,
    ...(claudeState === 'missing' ? {} : { bin: MOCK_CLAUDE_BIN }),
    ...(claudeState === 'signed_out' || claudeState === 'ready' ? { version: '2.1.0' } : {}),
    ...(CLAUDE_REASONS[claudeState] ? { reason: CLAUDE_REASONS[claudeState] } : {})
  })
  const claudeProvider = (): ProviderStatus => {
    const ready = claudeState === 'ready'
    return {
      id: 'claude-cli',
      connected: ready,
      label: CLAUDE_LABEL,
      ...(ready ? {} : { error: { code: `claude_code_${claudeState}`, userMessage: CLAUDE_REASONS[claudeState]! } })
    }
  }

  const ai: AI = {
    async providers() {
      return [
        { id: 'chatgpt', connected: false, label: 'ChatGPT' },
        { id: 'claude', connected: false, label: 'Claude' },
        claudeProvider(),
        NOT_CONNECTED
      ]
    },
    async active() {
      return claudeChosen && claudeState === 'ready' ? claudeProvider() : NOT_CONNECTED
    },
    async setActive(id) {
      if (id === 'claude-cli') {
        if (claudeState !== 'ready') throw { code: 'not_available', userMessage: CLAUDE_REASONS[claudeState] }
        claudeChosen = true
      } else claudeChosen = false
    },
    async claudeCodeStatus() {
      return claudeStatus()
    },
    mockClaudeSignInOpened() {
      if (mode === 'signs_in' && claudeState === 'signed_out') setTimeout(() => (claudeState = 'ready'), 1500)
    },
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

    async applyNote(projectDir, note, onEvent, _signal, opts): Promise<AgentResult> {
      onEvent({ type: 'status', message: 'Reading your note', pct: 10, phase: 'edit' })
      const p = await readProject(projectDir)
      const added: string[] = []
      if (/\b(always|never|every video|from now on|in general)\b/i.test(note)) {
        const rule = { id: randomUUID(), text: note.trim(), createdAt: new Date().toISOString() }
        await withStyle((s) => saveRules(s, [...s.rules, rule]))
        added.push(note.trim())
      }
      const attachments = opts?.attachments?.length ? { attachments: opts.attachments } : {}
      p.notes = [...(p.notes ?? []), { version: p.version ?? 0, text: note, applied: [], at: new Date().toISOString(), ...attachments }]
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
      return withStyle(async (s) => s.rules).catch(() => [])
    },
    async styleWasDamaged() {
      return withStyle(async (s) => typeof s.damaged === 'string' && existsSync(join(host.reelStudioRoot(), basename(s.damaged)))).catch(() => false)
    },
    async addStyleRule(text) {
      const rule = { id: randomUUID(), text, createdAt: new Date().toISOString() }
      await withStyle((s) => saveRules(s, [...s.rules, rule]))
      return rule
    },
    async removeStyleRule(id) {
      await withStyle((s) => saveRules(s, s.rules.filter((r) => r.id !== id)))
    }
  }
  return ai
}
