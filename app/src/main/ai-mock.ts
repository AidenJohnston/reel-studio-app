// Stand-in for @reelstudio/ai when the real package is not available. Same interface (ai-types.ts).
// It runs the deterministic "no AI connected" path from docs/architecture.md section 8: transcribe, analyze,
// autocut, music from the Library, render. It never pretends to be a real AI provider.
import { constants, existsSync, promises as fs } from 'node:fs'
import { basename, join, extname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { serialized, writeJson } from './store'
import type { AgentEvent, AgentResult, AI, ClaudeCodeStatus, CreateAI, NoteSteer, PlanTurnResult, ProviderStatus } from './ai-types'
import type { NicheTurnResult } from '../shared/niche'
import type { MemorySuggestion, NoteRunnerInfo, Phase, RuleCheck, StyleAnswerStatus, StyleProposal, StyleRule } from '../shared/api'
import { MERGE_LAYERS } from '../shared/api'

const MUSIC_EXT = new Set(['.mp3', '.m4a', '.wav', '.aac', '.flac', '.ogg'])

const NOT_CONNECTED: ProviderStatus = { id: 'none', connected: true, label: 'No AI' }

// The person's own Claude Code app and Codex app, as tests want them (REELSTUDIO_MOCK_CLAUDE / REELSTUDIO_MOCK_CODEX).
// Default: not on this computer. Modes:
//   missing        not on this computer (the row links to the maker's install page; nothing installs)
//   broken         found, but it does not start                signed_out      found, signed out (the sign-in finishes)
//   browser        signed out; the browser sign-in never comes back (until Cancel / Open again)
//   signs_in       signed out; the terminal window's sign-in finishes 1.5 s after it "opens" (no terminal opens)
//   free           the sign-in finishes on a plan the app reports as "free"
//   ready          installed and signed in (Claude Code on the Max plan)
//   status_unknown installed, but its status cannot be told (slow, unclear) until a sign-in finishes
//   port_reserved  signed out; the browser sign-in cannot open its port (Windows reserved it); the sign-in with a code
//                  shows MOCK-26CODE after 0.4 s and finishes 4 s later (the person typed it on OpenAI's page)
//   code_off       as port_reserved, but sign-in with a code is turned off for the account
//   port_in_use    as port_reserved, but the port is only in use by another program (Try again stays first)
type MockMode = 'missing' | 'broken' | 'signed_out' | 'browser' | 'signs_in' | 'free' | 'ready' | 'port_reserved' | 'code_off' | 'port_in_use' | 'status_unknown'
const MODES: MockMode[] = ['missing', 'broken', 'signed_out', 'browser', 'signs_in', 'free', 'ready', 'port_reserved', 'code_off', 'port_in_use', 'status_unknown']
export const MOCK_DEVICE_CODE = { url: 'https://auth.openai.com/codex/device', code: 'MOCK-26CODE' }
const CLAUDE_LABEL = 'Claude (your Claude Code app)'
const CODEX_LABEL = 'ChatGPT (your Codex app)'
const REASONS: Record<'claude' | 'chatgpt', Record<ClaudeCodeStatus['state'], string | undefined>> = {
  claude: {
    missing: 'We could not find the Claude Code app on this computer.',
    broken: 'We found the Claude Code app, but it did not start. Install it again from Anthropic’s page.',
    signed_out: 'Your Claude Code app is not signed in yet.',
    ready: undefined
  },
  chatgpt: {
    missing: 'We could not find the Codex app on this computer.',
    broken: 'We found the Codex app, but it did not start. Install it again from OpenAI’s page.',
    signed_out: 'Your Codex app is not signed in yet.',
    ready: undefined
  }
}
const MOCK_BIN = { claude: process.platform === 'win32' ? 'C:\\Program Files\\Mock Claude\\claude.exe' : '/opt/mock claude/bin/claude', chatgpt: process.platform === 'win32' ? 'C:\\Program Files\\Mock Codex\\codex.exe' : '/opt/mock codex/bin/codex' }
const until = (signal: AbortSignal, ms: number): Promise<boolean> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve(false)
    const t = ms === Infinity ? null : setTimeout(() => resolve(true), ms)
    signal.addEventListener('abort', () => {
      if (t) clearTimeout(t)
      resolve(false)
    }, { once: true })
  })

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

/** A rule's words as the real store keeps them (cleanRuleText in ai/src/style.ts): one sentence, capitalised,
 * ending in a full stop. */
function cleanRule(text: string): string {
  let clean = text.replace(/\s*—\s*/g, ', ').replace(/\s+/g, ' ').trim()
  if (!clean) throw { code: 'EMPTY', userMessage: 'Type the rule first, or press Remove.' }
  if (!/[.!?]$/.test(clean)) clean += '.'
  return clean[0].toUpperCase() + clean.slice(1)
}

/** Rules with these equal are the same rule (normalize in ai/src/style.ts). */
const sameRule = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N} ]+/gu, '')
    .replace(/\s+/g, ' ')
    .trim()

/** My style.json: the rules, plus whatever else the real package stores there (kept on every write). */
type StyleData = {
  rules: StyleRule[]
  damaged?: string
  forgotten?: string[]
  proposals?: MemorySuggestion[]
  seq?: number
  questions?: Record<string, { yes: boolean; status: StyleAnswerStatus; at: string }>
  [field: string]: unknown
}

const LOWERCASE_CAPTIONS = 'Use lowercase subtitles.'
/** The one typed rule there is (isCaptionCase in ai/src/style.ts). Anything else in `payload`, such as a hand edit,
 * makes the rule a plain sentence. */
const isCaptionCase = (x: unknown): boolean => {
  const c = x as { kind?: unknown; case?: unknown } | null
  return c?.kind === 'caption-case' && c.case === 'lower'
}
const OLD_LOWERCASE_TEXT = 'Use lowercase captions.'
type Answer = { yes: boolean; seq: number; at: string }
/** The rule's answers, and the questions they answer (answersOf and answered in ai/src/style.ts). */
const answersOf = (r: StyleRule): [string, Answer][] =>
  Object.entries(r.answers && typeof r.answers === 'object' ? r.answers : {}).filter(
    (e): e is [string, Answer] => typeof e[1]?.yes === 'boolean' && typeof e[1]?.seq === 'number'
  )
const answered = (r: StyleRule): string[] => answersOf(r).map(([q]) => q)
const nextSeq = (s: StyleData): number => (s.seq = (typeof s.seq === 'number' ? s.seq : 0) + 1)
/** As settle in ai/src/style.ts: answers matter only to a rule that is on because of them (`held`). It stays on while
 * some question's latest answer is a Yes newer than the last direct change, and otherwise falls back to `held`. */
function settle(rules: StyleRule[], r: StyleRule): StyleRule[] {
  if (!r.held) return rules
  const since = typeof r.seq === 'number' ? r.seq : 0
  if (answersOf(r).some(([, a]) => a.yes && a.seq > since)) {
    delete r.paused
    return rules
  }
  if (r.held === 'gone') {
    const rest = rules.filter((x) => x !== r)
    // a rule replaced comes back unless another rule has taken its place since
    const back = (r.replaced ?? []).filter((old) => !rest.some((x) => x.id === old.id || (old.check && x.check?.kind === old.check.kind)))
    return [...rest, ...back]
  }
  r.paused = true
  delete r.held
  return rules
}
/** As fromConsent in ai/src/style.ts: a file saved before answers were numbered keeps a rule's questions in
 * `consent`; each becomes a numbered Yes answer. A paused rule is simply paused; one still on is held by them. */
function fromConsent(s: StyleData): void {
  const ids = (x: unknown): string[] => (Array.isArray(x) ? x.filter((y): y is string => typeof y === 'string') : [])
  for (const r of s.rules as (StyleRule & { consent?: any })[]) {
    const c = r.consent
    delete r.consent
    if (!c || typeof c.proposal !== 'string' || r.answers) continue
    const at = typeof c.at === 'string' ? c.at : r.createdAt
    const answers: Record<string, Answer> = {}
    for (const q of [c.proposal, ...ids(c.also)]) answers[q] = { yes: true, seq: nextSeq(s), at }
    r.answers = answers
    if (!r.paused) r.held = 'gone'
  }
}
/** A direct change (My style, or an edit): the rule simply is as it was left, and older answers stop counting. */
function changedDirectly(s: StyleData, r: StyleRule): void {
  r.seq = nextSeq(s)
  delete r.held
  delete r.replaced
}

/** The practice editor's three reels in one video, in its own voice. */
const PRACTICE_REELS = [
  { title: 'The one fold that fixed my crumb', why: 'I cut it to the fix and its reason, which stands on its own.' },
  { title: 'Why I stopped using a mixer', why: 'I kept the before and after, since the middle repeats the first reel.' },
  { title: 'Bake it hot in a closed pot', why: 'I kept the bake on its own, because it needs nothing said before it.' }
]

export const createMockAI: CreateAI = ({ host, managedCodex }) => {
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
    if (Array.isArray(j?.rules)) {
      fromConsent(j)
      return j
    }
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
  /** As the real package's StyleStore.add: the same words again turn a paused rule back on instead of adding a copy. */
  const addRule = (text: string, from?: Pick<StyleRule, 'source' | 'imported' | 'byYou'>, check?: RuleCheck): Promise<{ added: boolean; rule: StyleRule }> =>
    withStyle(async (s) => {
      const dup = s.rules.find((r) => sameRule(r.text) === sameRule(text))
      if (dup && check) {
        // as the real store: a checked rule replaces any rule checking the same kind
        const rule: StyleRule = { id: randomUUID(), text: cleanRule(text), createdAt: new Date().toISOString(), ...from, check }
        changedDirectly(s, rule)
        await saveRules(s, [...s.rules.filter((r) => r.check?.kind !== check.kind && r !== dup), rule])
        return { added: true, rule }
      }
      if (dup) {
        if (dup.paused) {
          delete dup.paused
          changedDirectly(s, dup)
          await saveRules(s, s.rules)
        }
        return { added: false, rule: dup }
      }
      const rule: StyleRule = { id: randomUUID(), text: cleanRule(text), createdAt: new Date().toISOString(), ...from, ...(check ? { check } : {}) }
      changedDirectly(s, rule)
      await saveRules(s, [...s.rules.filter((r) => !check || r.check?.kind !== check.kind), rule])
      return { added: true, rule }
    })

  async function readProject(dir: string): Promise<any> {
    return JSON.parse(await fs.readFile(join(dir, 'project.json'), 'utf8'))
  }
  async function writeProject(dir: string, p: any): Promise<void> {
    p.updatedAt = new Date().toISOString()
    await writeJson(join(dir, 'project.json'), p) // retries on Windows locks (review 32)
  }

  // Tests and walkthroughs only (REELSTUDIO_MOCK_NOTE=<ms>): a connected editor whose every note thinks
  // for that long, then renders a new version, so notes can pile up behind each other and Stop lands mid-note.
  // Like the real applyNote, it edits a private copy and publishes it in one project.json write that
  // carries the note's id.
  const noteMs = Number(process.env.REELSTUDIO_MOCK_NOTE || 0)
  // With REELSTUDIO_MOCK_MOMENTS=1 too, a note that changes the picture shows it first, as the real package's
  // moments.ts does: the engine's `moments` stills and window, then its draft, while the editor "thinks". A note about
  // the music changes nothing on screen, so it draws nothing, as the real package starts no run for one.
  const mockMoments = process.env.REELSTUDIO_MOCK_MOMENTS === '1'
  // Tests only (REELSTUDIO_MOCK_EDITS=1, e2e/easy-ai.spec.ts): the editor a test connected (the Codex app, or a saved
  // connection) answers a note with a new version, as the practice editor does, without replacing the editor in use.
  const mockEdits = process.env.REELSTUDIO_MOCK_EDITS === '1'
  const EDIT_MS = 300
  const PRACTICE: ProviderStatus = { id: 'replay', connected: true, label: 'Practice editor (test)' }
  async function slowNote(dir: string, note: string, onEvent: (e: AgentEvent) => void, signal?: AbortSignal, opts?: { id?: string; owner?: string; steer?: NoteSteer; base?: number; mergeParent?: number }): Promise<AgentResult> {
    const id = opts?.id ?? randomUUID()
    const copy = join(dir, 'work', 'notes', id, 'edit.json')
    const p = await readProject(dir)
    // the climb's editor (REELSTUDIO_MOCK_FIRST_EDIT=editor) does what a note about bigger subtitles asks, so the new
    // version's "What changed" and reply read as an editor's would
    const bigger = process.env.REELSTUDIO_MOCK_FIRST_EDIT === 'editor' && /\bsubtitles? bigger\b/i.test(note)
    if (bigger) p.captions = { ...p.captions, style: { ...p.captions?.style, size: 125 } }
    p.notes = [...(p.notes ?? []), { id, version: p.version ?? 0, text: note, applied: [bigger ? 'captions' : 'note'], at: new Date().toISOString() }]
    await fs.mkdir(join(copy, '..'), { recursive: true })
    await writeJson(copy, p)
    onEvent({ type: 'status', message: `Working on "${note}"`, pct: 5, phase: 'edit', thinking: true })
    if (mockMoments && !/\b(music|song|quieter|louder)\b/i.test(note)) {
      const owner = opts?.owner ? ['--owner', opts.owner] : []
      const r = await host.runEngine('moments', ['--project', dir, '--project-file', copy, '--out', join(copy, '..'), ...owner], (pr) => {
        if (!pr.ready) return onEvent({ type: 'status', message: pr.message || 'Looking at what changed', pct: pr.pct, phase: 'edit' })
        const m = pr.ready
        onEvent(m.kind === 'still' ? { type: 'moment', kind: 'still', t: m.t, file: m.file, run: 1 } : { type: 'moment', kind: 'window', from: m.from, to: m.to, file: m.file, run: 1 })
      }, signal)
      if (r?.draft?.file) onEvent({ type: 'render', version: Number(r.draft.version ?? 0), draft: true, file: String(r.draft.file) })
    }
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, noteMs || (mockEdits ? EDIT_MS : 0))
      signal?.addEventListener('abort', () => (clearTimeout(t), reject({ code: 'CANCELLED', userMessage: 'Stopped.' })), { once: true })
    })
    // like the real package: words added while it worked are read before it can finish (ai steer.ts)
    const added: string[] = []
    while (opts?.steer && !opts.steer.seal()) added.push(...opts.steer.take())
    if (added.length) {
      const edit = JSON.parse(await fs.readFile(copy, 'utf8'))
      edit.notes[edit.notes.length - 1].text = [note, ...added].join('\n')
      await writeJson(copy, edit)
    }
    onEvent({ type: 'status', message: 'Making the final version', pct: 0, phase: 'final' })
    // a note on an older version, or a combination of two, records the version(s) it came from (version-tree)
    const from = [...(opts?.base !== undefined ? ['--parent', String(opts.base)] : []), ...(opts?.mergeParent !== undefined ? ['--merge-parent', String(opts.mergeParent)] : [])]
    const r = await host.runEngine('render', ['--project', dir, '--project-file', copy, ...from, ...(opts?.owner ? ['--owner', opts.owner] : [])], (pr) => onEvent({ type: 'status', message: pr.message || 'Making the final version', pct: pr.pct, phase: 'final' }), signal)
    const version = Number(r?.version)
    if (signal?.aborted) throw { code: 'CANCELLED', userMessage: 'Stopped.' }
    const done = JSON.parse(await fs.readFile(copy, 'utf8'))
    done.notes[done.notes.length - 1].version = version
    await writeProject(dir, done)
    onEvent({ type: 'render', version, draft: false, ...(r?.file ? { file: String(r.file) } : {}) })
    const also = added.length ? ` Also: ${added.map((w) => `"${w}"`).join(', ')}.` : ''
    const took = added.length ? `, and took in what you added: ${added.map((w) => `"${w}"`).join(', ')}` : ''
    if (bigger) return { summary: `I made the subtitles bigger, so they read at a glance on a phone${took}.`, version, styleRulesAdded: [], changed: ['captions'] }
    return { summary: `Done: "${note}".${also} It is Version ${version}.`, version, styleRulesAdded: [], changed: ['note'] }
  }

  async function firstMusicTrack(): Promise<string | null> {
    const dir = join(host.reelStudioRoot(), 'Library', 'Music')
    if (!existsSync(dir)) return null
    const files = (await fs.readdir(dir)).filter((f) => MUSIC_EXT.has(extname(f).toLowerCase())).sort()
    return files.length ? `Library/Music/${files[0]}` : null
  }

  const modeOf = (v: string | undefined): MockMode => MODES.find((m) => m === v) ?? 'missing'
  const mode = { claude: modeOf(process.env.REELSTUDIO_MOCK_CLAUDE), chatgpt: modeOf(process.env.REELSTUDIO_MOCK_CODEX) }
  const startState = (m: MockMode): ClaudeCodeStatus['state'] =>
    m === 'ready' ? 'ready' : m === 'broken' ? 'broken' : ['signed_out', 'browser', 'signs_in', 'free', 'port_reserved', 'code_off', 'port_in_use', 'status_unknown'].includes(m) ? 'signed_out' : 'missing'
  const state = { claude: startState(mode.claude), chatgpt: startState(mode.chatgpt) }
  const plan: { claude?: string; chatgpt?: string } = mode.claude === 'ready' ? { claude: 'max' } : {}
  let chosen: 'claude-cli' | 'codex-cli' | 'custom' | null = null
  // A saved connection to an OpenAI-compatible server, as the real package keeps one (the guided Reel Studio AI
  // sign-in saves publik's key this way). Saving asks the server once, so a test sees the key and model arrive there.
  let custom: { id: string; label: string; baseURL: string; model: string; key: string } | null = null
  const customProvider = (): ProviderStatus => ({ id: 'custom', connected: true, label: custom!.label, connectionId: custom!.id })
  // Settings › How notes run, as the real package keeps it (ai index.ts noteRunner). REELSTUDIO_MOCK_HARNESS=refused:
  // the app's self-test fails on the first note run in the app, so that note runs on Reel Studio's editor instead.
  let runInApp = false
  let fellBack: NoteRunnerInfo['fellBack']
  const runnerApp = (): NoteRunnerInfo['app'] =>
    chosen === 'claude-cli' && state.claude === 'ready' ? 'claude-code' : chosen === 'codex-cli' && state.chatgpt === 'ready' ? 'codex' : null
  const noteRunner = async (): Promise<NoteRunnerInfo> => ({ runner: runInApp && runnerApp() ? 'app' : 'reelstudio', app: runnerApp(), ...(fellBack ? { fellBack } : {}) })
  let checking: AbortController | null = null
  const cliStatus = (v: 'claude' | 'chatgpt'): ClaudeCodeStatus => ({
    state: state[v],
    ...(state[v] === 'missing' ? {} : { bin: MOCK_BIN[v] }),
    ...(state[v] === 'signed_out' || state[v] === 'ready' ? { version: v === 'claude' ? '2.1.0' : '0.164.0' } : {}),
    ...(plan[v] ? { plan: plan[v] } : {}),
    ...(mode[v] === 'status_unknown' && state[v] === 'signed_out' ? { unknown: true } : {}),
    ...(REASONS[v][state[v]] ? { reason: REASONS[v][state[v]] } : {})
  })
  const claudeStatus = (): ClaudeCodeStatus => cliStatus('claude')
  const cliProvider = (v: 'claude' | 'chatgpt'): ProviderStatus => {
    const ready = state[v] === 'ready'
    return {
      id: v === 'claude' ? 'claude-cli' : 'codex-cli',
      connected: ready,
      label: v === 'claude' ? CLAUDE_LABEL : CODEX_LABEL,
      ...(ready ? {} : { error: { code: `${v === 'claude' ? 'claude_code' : 'codex'}_${state[v]}`, userMessage: REASONS[v][state[v]]! } })
    }
  }
  const claudeProvider = (): ProviderStatus => cliProvider('claude')

  const ai: AI = {
    async providers() {
      return [{ id: 'claude', connected: false, label: 'Claude' }, claudeProvider(), cliProvider('chatgpt'), NOT_CONNECTED]
    },
    async active() {
      // the climb's screenshots (REELSTUDIO_MOCK_FIRST_EDIT=editor) start with no editor and choose the Claude Code app,
      // as a person does; the practice editor is a test's own and never on a person's screen
      if (process.env.REELSTUDIO_MOCK_FIRST_EDIT === 'editor') return chosen === 'claude-cli' && state.claude === 'ready' ? claudeProvider() : NOT_CONNECTED
      if (noteMs > 0) return PRACTICE
      if (chosen === 'claude-cli' && state.claude === 'ready') return claudeProvider()
      if (chosen === 'codex-cli' && state.chatgpt === 'ready') return cliProvider('chatgpt')
      if (chosen === 'custom' && custom) return customProvider()
      return NOT_CONNECTED
    },
    async setActive(id) {
      if (id === 'claude-cli' || id === 'codex-cli') {
        const v = id === 'claude-cli' ? 'claude' : 'chatgpt'
        if (state[v] !== 'ready') throw { code: 'not_available', userMessage: REASONS[v][state[v]] }
        if (id === 'claude-cli') {
          // The real package checks Claude with one short call here (about 4-5 s). REELSTUDIO_MOCK_CLAUDE_CHECK:
          // a number waits that many ms; `limited` and `no-answer` fail the check the way the real one does.
          const check = process.env.REELSTUDIO_MOCK_CLAUDE_CHECK ?? ''
          if (check === 'limited') throw { code: 'cli_limited', userMessage: 'The account in your Claude Code app has hit its weekly limit. It resets tomorrow at 9:00 AM (in 14 h).' }
          if (check === 'no-answer') throw { code: 'cli_error', userMessage: 'The AI did not answer.' }
          if (Number(check) > 0) {
            const stop = (checking = new AbortController())
            await new Promise<void>((resolve, reject) => {
              const t = setTimeout(resolve, Number(check))
              stop.signal.addEventListener('abort', () => (clearTimeout(t), reject({ code: 'cancelled', userMessage: 'Stopped.' })))
            }).finally(() => void (checking === stop && (checking = null)))
          }
        }
        chosen = id
      } else if (id === 'custom' && custom) chosen = 'custom'
      else chosen = null
    },
    cancelCheck() {
      checking?.abort()
    },
    async claudeCodeStatus() {
      return claudeStatus()
    },
    async codexStatus() {
      // the Codex app Reel Studio fetched (easy-ai.ts) is found like the real package finds it: signed out at first
      if ((state.chatgpt === 'missing' || state.chatgpt === 'broken') && managedCodex?.()) state.chatgpt = 'signed_out'
      return cliStatus('chatgpt')
    },
    async connections() {
      return custom ? [{ id: custom.id, label: custom.label, kind: 'openai' as const, baseURL: custom.baseURL, model: custom.model, supportsImages: false, hasKey: true, active: chosen === 'custom' }] : []
    },
    async saveConnection(input) {
      const key = input.key?.trim() || (custom && input.id === custom.id ? custom.key : '')
      const fail = (userMessage: string) => ({ status: { id: 'custom' as const, connected: false, label: input.label, error: { code: 'connection_error', userMessage } }, error: { code: 'connection_error', userMessage } })
      try {
        const res = await fetch(`${input.baseURL.replace(/\/+$/, '')}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
          body: JSON.stringify({ model: input.model, max_tokens: 1, messages: [{ role: 'user', content: 'Reply with OK.' }] })
        })
        if (!res.ok) return fail('The server did not accept that key. Check the key, then paste it again.')
      } catch {
        return fail('Something went wrong talking to your server. Try again.')
      }
      custom = { id: input.id ?? custom?.id ?? `c_${randomUUID().slice(0, 8)}`, label: input.label, baseURL: input.baseURL, model: input.model, key }
      chosen = 'custom'
      const status = customProvider()
      return { status, connection: { id: custom.id, label: custom.label, kind: 'openai' as const, baseURL: custom.baseURL, model: custom.model, supportsImages: false, hasKey: true, active: true } }
    },
    async removeConnection(id) {
      if (custom?.id !== id) return
      custom = null
      if (chosen === 'custom') chosen = null
    },
    async retireSignInWithChatGPT() {
      return false
    },
    mockClaudeSignInOpened() {
      if (mode.claude === 'signs_in' && state.claude === 'signed_out') setTimeout(() => (state.claude = 'ready'), 1500)
    },
    async stockProviders() { return [{ id: 'pexels', connected: false }, { id: 'pixabay', connected: false }, { id: 'openverse', connected: true }] },
    async setStockKey() { throw { code: 'NOT_READY', userMessage: 'Stock API keys need the AI package. Reinstall Reel Studio and try again.' } },
    mockVendor: {
      async login(v, signal, onDeviceCode) {
        if (mode[v] === 'port_reserved' || mode[v] === 'code_off' || mode[v] === 'port_in_use') {
          const held = mode[v] === 'port_in_use' ? { portBusy: true } : { portBusy: true, portReserved: true }
          if (!onDeviceCode) return (await until(signal, 300)) ? { code: 1, ...held } : { code: null, aborted: true }
          if (mode[v] === 'code_off') return (await until(signal, 300)) ? { code: 1, deviceCodeOff: true } : { code: null, aborted: true }
          if (!(await until(signal, 400))) return { code: null, aborted: true }
          onDeviceCode(MOCK_DEVICE_CODE)
          if (!(await until(signal, 4000))) return { code: null, aborted: true }
          state[v] = 'ready'
          return { code: 0 }
        }
        if (mode[v] === 'browser') {
          await until(signal, Infinity)
          return { code: null, aborted: true }
        }
        if (!(await until(signal, 1200))) return { code: null, aborted: true }
        state[v] = 'ready'
        if (mode[v] === 'free') plan[v] = 'free'
        return { code: 0 }
      }
    },
    async setClaudeKey(key) {
      if (!key) return { id: 'none', connected: true, label: 'No AI' }
      throw { code: 'NOT_READY', userMessage: 'Claude keys are not ready in this build yet. Your reels still work without it.' }
    },

    async firstEdit(projectDir, onEvent, signal, opts): Promise<AgentResult> {
      const args = ['--project', projectDir, ...(opts?.owner ? ['--owner', opts.owner] : [])]
      // phases like the real package's no-AI path, so the job flow's bar and time left work here too
      const hold = Number(process.env.REELSTUDIO_MOCK_FIRST_LOOK || 0)
      // Tests only (REELSTUDIO_MOCK_FIRST_EDIT=editor): the first edit an editor makes, its steps and its own words, so a
      // screenshot set shows the path a person with an editor sees (e2e/climb-shots.spec.ts)
      const editor = process.env.REELSTUDIO_MOCK_FIRST_EDIT === 'editor'
      const status = (message: string, pct: number, phase?: Phase, note?: string): void =>
        onEvent({ type: 'status', message, pct, ...(phase ? { phase } : {}), ...(hold > 0 || editor ? {} : { noAI: true }), ...(note ? { note } : {}) })
      const changed: string[] = []
      // one of several reels from one video (main/propose-reels.ts) has its words heard and its cut set already; one
      // cut from parts of the footage archive (main/archive-reels.ts) has its cut but is listened to here, as the real
      // package does (ai editor.ts ensureAnalyzed and deterministicEdit)
      const start = await readProject(projectDir)
      const proposed = !!start.proposal && (start.cut?.keep?.length ?? 0) > 0
      const heard = existsSync(join(projectDir, start.transcript?.file ?? 'work/transcript.json'))

      if (!heard) {
        status('Listening to your video', 1, 'listen')
        await host.runEngine('transcribe', args, (p) => status(p.message || 'Listening to your video', p.pct, 'listen', p.note), signal)
      }
      if (!proposed) {
        status('Picking your best takes', 41, 'analyze')
        await host.runEngine('analyze', args, (p) => status('Picking your best takes', span(0, 50, p.pct), 'analyze'), signal)
        await host.runEngine('autocut', args, (p) => status('Picking your best takes', span(50, 100, p.pct), 'analyze'), signal)
        onEvent({ type: 'tool', name: 'autocut', summary: 'Cut out the pauses and do-overs' })
      }
      changed.push('cut')

      // Tests only (REELSTUDIO_MOCK_LIMIT=<ISO>): the editor's plan is at its limit until then, thrown the way the
      // real package throws when the app pauses on it (opts.pauseOn).
      const limitUntil = process.env.REELSTUDIO_MOCK_LIMIT
      if (limitUntil && Date.now() < Date.parse(limitUntil)) {
        const limited = { code: 'cli_limited', userMessage: 'The AI hit its usage limit. Try again later.', resetsAt: limitUntil }
        if (opts?.pauseOn?.(limited)) throw limited
      }

      // Tests only (REELSTUDIO_MOCK_FIRST_LOOK=<ms>): act like the real package with an AI: a first look,
      // then a while "thinking", so the Working screen's first look + thinking state can be driven.
      if (hold > 0) {
        const look = await host.runEngine('render', [...args, '--draft'], undefined, signal)
        onEvent({ type: 'render', version: 0, draft: true, firstLook: true, ...(look?.file ? { file: String(look.file) } : {}) })
        onEvent({ type: 'status', message: 'Watching your video and planning the edit', pct: 5, phase: 'edit', thinking: true })
        await new Promise((r) => setTimeout(r, hold))
      }

      if (editor) status('Picking takes and pictures', 50, 'edit')
      status('Adding music', 56)
      const track = await firstMusicTrack()
      const p = await readProject(projectDir)
      if (track) {
        p.music = { ...(p.music ?? {}), enabled: true, track, startAt: 0, level: 'under-voice' }
        changed.push('music')
        onEvent({ type: 'tool', name: 'choose_music', summary: `Picked a song: ${track.split('/').pop()}` })
      }
      // No post caption on a basic version: nothing smart ran, so the user writes it ("Post caption: add your own"). An
      // editor writes one, as ai/src/tools.ts write_post does: the caption, exactly 5 hashtags, search keywords.
      if (editor) {
        p.post = {
          caption: "You don't need a mixer for good bread. Four things and a little time.",
          hashtags: ['#bread', '#breadmaking', '#homebaking', '#baking', '#easyrecipes'],
          keywords: ['bread', 'no mixer', 'home baking']
        }
        changed.push('post')
        onEvent({ type: 'tool', name: 'write_post', summary: 'Wrote your caption and hashtags' })
      }
      const rules = await withStyle(async (s) => s.rules).catch((): StyleRule[] => [])
      const lower = rules.some((r) => isCaptionCase(r.payload) && !r.paused)
      if (lower) p.captions = { ...p.captions, style: { ...p.captions?.style, case: 'lower' } }
      await writeProject(projectDir, p)

      status('Making your cover', 60)
      status('Putting it all together', 0, 'final')
      const r = await host.runEngine('render', args, (pr) => status(pr.message || 'Putting it all together', pr.pct, 'final'), signal)
      const version = Number(r?.version ?? (await readProject(projectDir)).version ?? 1)
      onEvent({ type: 'render', version, draft: false })
      status('Done', 100)

      const did = proposed ? 'the proposed part of the video kept and subtitles added' : 'pauses cut and subtitles added'
      return {
        summary: editor
          ? 'I kept your clean take of each line and cut the false start, the filler and the long pauses. Subtitles and a cover are on.'
          : (track
            ? `Basic version: ${did}, with your song underneath. Connect an editor to pick your best takes and add pictures.`
            : `Basic version: ${did}. Add a song for music, and connect an editor to pick your best takes and add pictures.`) +
          (lower ? ' Subtitles are lowercase, from My style.' : ''),
        version,
        styleRulesAdded: [],
        changed
      }
    },

    noteRunner,
    async setNoteRunner(runner) {
      if (runner === 'app' && !runnerApp()) throw { code: 'not_available', userMessage: 'Connect your Claude Code app or Codex app as your editor first.' }
      runInApp = runner === 'app'
      fellBack = undefined
      return noteRunner()
    },
    async applyNote(projectDir, note, onEvent, signal, opts): Promise<AgentResult> {
      const app = runnerApp()
      if (runInApp && app && !fellBack && process.env.REELSTUDIO_MOCK_HARNESS === 'refused') {
        fellBack = { app, reason: 'claude_cli: MCP refused', at: new Date().toISOString() }
        onEvent({ type: 'status', phase: 'edit', message: `${app} self-test failed (claude_cli: MCP refused). Using the text-protocol provider for this session.` })
      }
      if (noteMs > 0 || (mockEdits && (chosen === 'custom' || (chosen === 'codex-cli' && state.chatgpt === 'ready')))) return slowNote(projectDir, note, onEvent, signal, opts)
      onEvent({ type: 'status', message: 'Reading your note', pct: 10, phase: 'edit' })
      const p = await readProject(projectDir)
      // Tests only: REELSTUDIO_MOCK_CLAUDE=ready, and the mock Claude Code app chosen in Settings. Then act like the real
      // package on a lowercase note (change the captions, make a new version, ask to remember it). Never for a
      // person whose AI package failed to load: this stand-in does not read notes.
      if (chosen === 'claude-cli' && state.claude === 'ready' && /\blower ?case\b/i.test(note) && p.captions?.style?.case !== 'lower') {
        p.captions = { ...p.captions, style: { ...p.captions?.style, case: 'lower' } }
        await writeProject(projectDir, p)
        const r = await host.runEngine('render', ['--project', projectDir], undefined, signal)
        const version = Number(r?.version ?? 0)
        onEvent({ type: 'render', version, draft: false })
        // saved under the queue entry's id like any note, or the app's note queue would run it again
        const saved = await readProject(projectDir)
        saved.notes = [...(saved.notes ?? []), {
          version, text: note, applied: ['captions'], at: new Date().toISOString(), ...(opts?.id ? { id: opts.id } : {}), reply: 'I made the captions lowercase.'
        }]
        await writeProject(projectDir, saved)
        const rules = await withStyle(async (s) => s.rules).catch((): StyleRule[] => [])
        const styleProposal: StyleProposal | undefined = rules.some((x) => isCaptionCase(x.payload))
          ? undefined
          : { id: randomUUID(), text: LOWERCASE_CAPTIONS, payload: { kind: 'caption-case', case: 'lower' }, source: { project: p.id, title: p.title, version } }
        return { summary: 'I made the subtitles lowercase.', version, styleRulesAdded: [], changed: ['captions'], ...(styleProposal ? { styleProposal } : {}) }
      }
      // Tests only, as above: "at most 2 words" asks to check that on every reel, as the real package does once it has
      // measured the finished reel (ai/src/editor.ts checkedProposals). The words are the app's (ai/src/rules.ts ruleText).
      const most = chosen === 'claude-cli' && state.claude === 'ready' ? /\bat most ([1-4]) words?\b/i.exec(note) : null
      if (most) {
        const value = Number(most[1])
        const text = value === 1 ? 'Show subtitles one word at a time.' : `Show at most ${value} words in a subtitle.`
        const summary = 'Your subtitles already show that many words, so I left this reel as it is.'
        p.notes = [...(p.notes ?? []), { version: p.version ?? 0, text: note, applied: [], at: new Date().toISOString(), ...(opts?.id ? { id: opts.id } : {}), reply: summary }]
        await writeProject(projectDir, p)
        onEvent({ type: 'status', message: 'Done', pct: 100 })
        return { summary, version: p.version ?? 0, styleRulesAdded: [], styleSuggestions: [], styleChecks: [{ text, check: { kind: 'captions.maxWords', value } }], changed: [] }
      }
      // a rule to remember is only proposed: the app asks before anything goes into My style
      const proposed = /\b(always|never|every video|from now on|in general)\b/i.test(note) ? [note.trim()] : []
      const summary = proposed.length
        ? 'Connect an AI editor in Settings and I can change this video from your notes too.'
        : 'I saved your note. Connect an AI editor in Settings and I can change the video from notes like this one. You can also tweak it yourself under "Show me how".'
      const attachments = opts?.attachments?.length ? { attachments: opts.attachments } : {}
      // saved under the job's id with its reply, so a crash right after is finished at the next start (store.ts settleInterrupted)
      p.notes = [...(p.notes ?? []), {
        version: p.version ?? 0, text: note, applied: [], at: new Date().toISOString(), ...attachments,
        ...(opts?.id ? { id: opts.id } : {}), reply: summary, ...(proposed.length ? { styleSuggestions: proposed } : {})
      }]
      await writeProject(projectDir, p)
      onEvent({ type: 'status', message: 'Done', pct: 100 })
      return { summary, version: p.version ?? 0, styleRulesAdded: [], styleSuggestions: proposed, changed: [] }
    },

    // this stand-in has no fast path: every note goes through applyNote above
    async mergeVersions(projectDir, request, onEvent, signal, opts) {
      const r = await slowNote(projectDir, `Combine Version ${request.ours} and Version ${request.theirs}`, onEvent, signal, { ...opts, base: request.ours, mergeParent: request.theirs })
      return { ...r, summary: `Combined Version ${request.ours} and Version ${request.theirs}.`, edit: await readProject(projectDir), report: [] }
    },
    // the practice editor keeps no version snapshots to compare, so every part is a choice
    async mergeLayers() {
      return [...MERGE_LAYERS]
    },
    async wholeReelSetting() {
      return false
    },

    // The practice editor (REELSTUDIO_MOCK_NOTE) plans like the real one: a question about who it is for, one about
    // the takeaway, then a fixed plan, each after thinking as long as it takes over a note. Halfway through it says the
    // wait the way the real package does after 20 quiet seconds (ai agent.ts waitWords).
    async planTurn(input, onEvent, signal): Promise<PlanTurnResult> {
      if (!(noteMs > 0)) throw { code: 'NO_AI', userMessage: 'Connect an editor to plan a reel together.' }
      onEvent({ type: 'status', message: 'Planning your reel', pct: 10, thinking: true })
      await new Promise<void>((resolve, reject) => {
        const quiet = setTimeout(() => onEvent({ type: 'status', message: 'Waiting for your editor to answer', thinking: true, waiting: true }), noteMs / 2)
        const t = setTimeout(resolve, noteMs)
        signal?.addEventListener('abort', () => (clearTimeout(quiet), clearTimeout(t), reject({ code: 'CANCELLED', userMessage: 'Stopped.' })), { once: true })
      })
      if (!input.plan && input.asked === 0) return { kind: 'question', text: 'Who is it for?' }
      if (!input.plan && input.asked === 1) return { kind: 'question', text: "What's the one thing they should take away?" }
      return {
        kind: 'plan',
        say: input.plan ? 'I made that change.' : 'I led with the mistake most people make, then the four steps.',
        title: 'Sourdough without a mixer',
        hooks: ['You do not need a mixer to make good sourdough.', 'I kneaded bread by hand for a year before I learned this.', 'Flour, water, salt. That is the whole list.'],
        beats: ['Flour, water, salt. Nothing else goes in.', 'Mix it by hand, then leave it for an hour.', 'Fold it four times, an hour apart.', 'It sleeps in the fridge overnight.', 'Bake it hot in a closed pot. No mixer, ever.'],
        shots: ['You at the kitchen counter, chest up, by the window', 'Your hands folding the dough, close up', 'The loaf coming out of the pot']
      }
    },

    // The practice editor finds a niche as the real one does (ai niche.ts): who it is for, then what they get, then a
    // fixed niche, each after thinking as long as over a note.
    async nicheTurn(input, onEvent, signal): Promise<NicheTurnResult> {
      if (!(noteMs > 0)) throw { code: 'NO_AI', userMessage: 'Connect an editor to find your niche together, or write it yourself.' }
      onEvent({ type: 'status', message: 'Thinking about your niche', pct: 10, thinking: true })
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, Math.min(noteMs, 800))
        signal?.addEventListener('abort', () => (clearTimeout(t), reject({ code: 'CANCELLED', userMessage: 'Stopped.' })), { once: true })
      })
      if (!input.niche && input.asked === 0) return { kind: 'question', text: 'Who do you picture watching? Be as specific as you can.' }
      if (!input.niche && input.asked === 1) return { kind: 'question', text: 'What do they get from you that they don’t get elsewhere?' }
      return {
        kind: 'niche',
        say: input.niche ? 'I made that change.' : 'I aimed it at people baking their very first loaf.',
        who: 'People who want to bake bread at home but have never tried sourdough',
        promise: 'A real loaf from flour, water, salt and their own two hands',
        angles: ['The mistake that ruins most first loaves', 'One step of the bake, start to finish', 'A question from a viewer, answered at the counter', 'Before and after: what changed in my bread this month'],
        avoid: ['hack', 'game-changer', 'easy peasy']
      }
    },

    // The practice editor's Try 2: the hook line unless the creator swapped, a fixed answer per thing, after a beat.
    async proposeTry(req, signal) {
      if (!(noteMs > 0)) throw { code: 'NO_AI', userMessage: 'Connect an editor to have it choose Try 2.' }
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, Math.min(noteMs, 600))
        signal?.addEventListener('abort', () => (clearTimeout(t), reject({ code: 'CANCELLED', userMessage: 'Stopped.' })), { once: true })
      })
      const tags = req.caption.split('\n').filter((l) => l.trim().startsWith('#')).join('\n')
      switch (req.variable ?? 'hook') {
        case 'hook': return { variable: 'hook', value: 'The one change that fixed my sourdough', reason: 'I lead with the payoff, since people decide before they tap more.' }
        case 'caption': return { variable: 'caption', value: `Mix, wait, fold four times, then the fridge.${tags ? `\n\n${tags}` : ''}`, reason: 'I swapped the story for the steps, so the caption pays off the hook.' }
        case 'cover': return { variable: 'cover', value: Math.round(req.duration * 50) / 100, reason: 'I picked the middle, where you look straight at the camera.' }
        case 'brightness': return { variable: 'brightness', value: 0.06, reason: 'I lift it a little so your face reads on a small screen.' }
      }
    },

    // The practice editor's reels: the stand-in engine's words split at its pauses, and those runs in up to three even
    // parts, each a reel with fixed words. One run reads as one piece: no reels. It thinks as long as over a note, and
    // says the wait halfway, as the real package does after 20 quiet seconds. It reads no TAKEN: it is a stand-in.
    async proposeReels(req, signal, onEvent) {
      if (!(noteMs > 0)) throw { code: 'NO_AI', userMessage: 'Connect an editor to find more reels in this video.' }
      await new Promise<void>((resolve, reject) => {
        const quiet = setTimeout(() => onEvent?.({ type: 'status', message: 'Waiting for your editor to answer', thinking: true, waiting: true }), noteMs / 2)
        const t = setTimeout(resolve, noteMs)
        signal?.addEventListener('abort', () => (clearTimeout(quiet), clearTimeout(t), reject({ code: 'CANCELLED', userMessage: 'Stopped.' })), { once: true })
      })
      const words = req.transcript.words
      const runs: (typeof words)[] = []
      words.forEach((w, i) => (i === 0 || w.s - words[i - 1].e > 0.6 ? runs.push([w]) : runs[runs.length - 1].push(w)))
      const parts = runs.length < 2 ? 0 : Math.min(3, runs.length)
      const reels = Array.from({ length: parts }, (_, k) => runs.slice(Math.floor((k * runs.length) / parts), Math.floor(((k + 1) * runs.length) / parts)))
      // the engine's rule for a range's length: each word, plus the gap before it up to gapCap
      const seconds = (ws: typeof words): number =>
        Math.round(ws.reduce((t, w, i) => t + (w.e - w.s) + (i ? Math.min(Math.max(0, w.s - ws[i - 1].e), req.gapCap) : 0), 0) * 1000) / 1000
      return {
        candidates: reels.map((r, k) => {
          const ws = r.flat()
          return {
            id: `r${k + 1}`,
            title: PRACTICE_REELS[k].title,
            hook: { from: ws[0].id, to: r[0][r[0].length - 1].id },
            keep: [{ from: ws[0].id, to: ws[ws.length - 1].id }],
            why: PRACTICE_REELS[k].why,
            seconds: seconds(ws),
            words: ws.length
          }
        }),
        notes: '',
        attempts: 1
      }
    },

    // The practice editor's reels across the footage archive: lines taken in file order until a reel plays for 15 s,
    // so a short file runs on into the next one, up to three reels. It reads no words: it is a stand-in.
    async proposeFromArchive(req, signal) {
      if (!(noteMs > 0)) throw { code: 'NO_AI', userMessage: 'Connect an editor to find reels in your footage.' }
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, noteMs)
        signal?.addEventListener('abort', () => (clearTimeout(t), reject({ code: 'CANCELLED', userMessage: 'Stopped.' })), { once: true })
      })
      type Span = { ref: string; t0: number; t1: number; said: string }
      const reels: Span[][] = []
      let open: Span[] = []
      const length = (spans: Span[]) => spans.reduce((t, x) => t + x.t1 - x.t0, 0)
      for (const f of req.files) {
        for (const l of f.lines) {
          const last = open.at(-1)
          if (last && last.ref === f.ref) Object.assign(last, { t1: l.e, said: `${last.said} ${l.text}` })
          else open.push({ ref: f.ref, t0: l.s, t1: l.e, said: l.text })
          if (length(open) >= 15 && reels.length < 3) (reels.push(open), (open = []))
        }
      }
      return {
        candidates: reels.map((spans, k) => ({
          id: `r${k + 1}`, title: PRACTICE_REELS[k].title, why: PRACTICE_REELS[k].why, hook: spans[0].said,
          spans, seconds: Math.round(length(spans) * 10) / 10
        })),
        notes: '',
        attempts: 1
      }
    },

    async styleRules() {
      return withStyle(async (s) => s.rules).catch(() => [])
    },
    async styleWasDamaged() {
      return withStyle(async (s) => typeof s.damaged === 'string' && existsSync(join(host.reelStudioRoot(), basename(s.damaged)))).catch(() => false)
    },
    async addStyleRule(text, from, check) {
      return (await addRule(text, from, check)).rule
    },
    // The learning loop, as the real StyleStore keeps it: at most three waiting, never a rule until kept, and words
    // turned down or forgotten never come back. This stand-in has no post results to learn from.
    async learnFromResults() {
      return []
    },
    async proposeMemory(draft) {
      const d = draft as Omit<MemorySuggestion, 'id' | 'proposedAt'>
      return withStyle(async (s) => {
        const words = sameRule(d.text)
        if ((s.forgotten ?? []).some((f) => sameRule(f) === words)) return 'forgotten'
        if (s.rules.some((r) => sameRule(r.text) === words) || (s.proposals ?? []).some((x) => sameRule(x.text) === words)) return 'duplicate'
        if ((s.proposals ?? []).length >= 3) return 'full'
        await writeJson(styleFile(), { ...s, proposals: [...(s.proposals ?? []), { ...d, id: randomUUID(), proposedAt: new Date().toISOString() }] })
        return 'added'
      })
    },
    async memoryProposals() {
      return withStyle(async (s) => s.proposals ?? []).catch(() => [])
    },
    async acceptMemory(id, words) {
      return withStyle(async (s) => {
        const x = (s.proposals ?? []).find((m) => m.id === id)
        if (!x) return null
        const proposals = (s.proposals ?? []).filter((m) => m.id !== id)
        const text = cleanRule(words ?? x.text)
        const dup = s.rules.find((r) => sameRule(r.text) === sameRule(text))
        const from = x.from
        const rule: StyleRule = dup ?? {
          id: randomUUID(), text, createdAt: new Date().toISOString(),
          ...(from.kind === 'note' ? { source: { project: from.project, title: from.title, version: from.version } } : { learned: { from: from.kind, evidence: from.evidence } })
        }
        // kept in other words: its own words are never suggested again (as the real StyleStore.accept)
        const forgotten = sameRule(text) === sameRule(x.text) ? s.forgotten : [...(s.forgotten ?? []), x.text]
        await writeJson(styleFile(), { ...s, rules: dup ? s.rules : [...s.rules, rule], proposals, ...(forgotten ? { forgotten } : {}) })
        return rule
      })
    },
    async dismissMemory(id) {
      await withStyle(async (s) => {
        const x = (s.proposals ?? []).find((m) => m.id === id)
        if (!x) return
        await writeJson(styleFile(), { ...s, proposals: (s.proposals ?? []).filter((m) => m.id !== id), forgotten: [...(s.forgotten ?? []), x.text] })
      })
    },
    async restoreStyleRule(rule, index) {
      await withStyle(async (s) => {
        if (s.rules.some((r) => r.id === rule.id)) return
        // its question no longer counts as forgotten, as the real store's restore
        const asked = new Set(answered(rule))
        s.forgotten = (s.forgotten ?? []).filter((x) => !asked.has(x))
        await saveRules(s, [...s.rules.slice(0, index), rule, ...s.rules.slice(index)])
      })
    },
    // The same answers as the real store (StyleStore.answer in ai/src/style.ts): the answer, its effect and the
    // question's record in one write; a paused rule stays paused; No takes back only this question's own Yes.
    async answerStyleQuestion(q, yes) {
      const typed = q?.payload !== undefined
      // as the real store: a question that is not exactly this rule saves nothing, and the rule is stored in the app's
      // own form, never the fields the question came with (a question still on screen from before the app said
      // "subtitles" carries the old words)
      if (!q?.id || (typed && ((q.text !== LOWERCASE_CAPTIONS && q.text !== OLD_LOWERCASE_TEXT) || !isCaptionCase(q.payload)))) {
        throw new Error('the question does not match the rule it would save')
      }
      const text = typed ? LOWERCASE_CAPTIONS : cleanRule(q.text)
      return withStyle(async (s) => {
        const at = new Date().toISOString()
        const done = async (status: StyleAnswerStatus, rules = s.rules): Promise<{ status: StyleAnswerStatus }> => {
          s.questions = { ...s.questions, [q.id]: { yes, status, at } }
          await saveRules(s, rules)
          return { status }
        }
        const asked = s.rules.find((r) => answered(r).includes(q.id))
        if (!yes) {
          if (!asked) return done('declined')
          asked.answers = { ...asked.answers, [q.id]: { yes: false, seq: nextSeq(s), at } }
          return done('declined', settle(s.rules, asked))
        }
        if (s.forgotten?.includes(q.id)) return done('forgotten')
        const say = (r: StyleRule): void => {
          r.answers = { ...r.answers, [q.id]: { yes: true, seq: nextSeq(s), at } }
        }
        const same =
          asked ??
          s.rules.find((r) =>
            typed
              ? isCaptionCase(r.payload)
              : q.check
                ? r.check?.kind === q.check.kind && r.text === text
                : !r.check && !r.payload && sameRule(r.text) === sameRule(text)
          )
        if (same) {
          say(same)
          const edited = typed ? !isCaptionCase(same.payload) : !!q.check && same.text !== text
          if (same.paused) delete same.held
          return done(edited ? 'exists' : same.paused ? 'paused' : asked ? 'saved' : 'exists')
        }
        const source = q.source
          ? { project: String(q.source.project ?? ''), title: String(q.source.title ?? '').slice(0, 120), version: Number(q.source.version) || 0 }
          : undefined
        const rule: StyleRule = {
          id: randomUUID(),
          text,
          createdAt: at,
          held: 'gone',
          ...(typed ? { payload: { kind: 'caption-case' as const, case: 'lower' as const } } : {}),
          ...(source ? { source } : {}),
          ...(q.check ? { check: q.check } : {})
        }
        say(rule)
        const gives = (r: StyleRule): boolean =>
          sameRule(r.text) === sameRule(text) || (typed && sameRule(r.text) === sameRule(OLD_LOWERCASE_TEXT)) || (!!q.check && r.check?.kind === q.check.kind)
        const replaced = s.rules.filter(gives)
        if (q.check && replaced.length) rule.replaced = replaced
        return done('saved', [...s.rules.filter((r) => !gives(r)), rule])
      })
    },
    async styleAnswer(id) {
      return withStyle(async (s) => {
        const a = s.questions?.[id]
        return a && typeof a.yes === 'boolean' && typeof a.status === 'string' ? { yes: a.yes, status: a.status } : null
      }).catch(() => null)
    },
    async updateStyleRule(id, patch) {
      return withStyle(async (s) => {
        const rule = s.rules.find((r) => r.id === id)
        if (!rule) throw { code: 'NOT_FOUND', userMessage: 'That rule is not in My style any more.' }
        if (patch.text !== undefined) {
          rule.text = cleanRule(patch.text)
          rule.updatedAt = new Date().toISOString()
          if (rule.text !== LOWERCASE_CAPTIONS) delete rule.payload
        }
        if (patch.paused === true) rule.paused = true
        if (patch.paused === false) delete rule.paused
        changedDirectly(s, rule)
        await saveRules(s, s.rules)
        return rule
      })
    },
    async removeStyleRule(id) {
      return withStyle(async (s) => {
        const index = s.rules.findIndex((r) => r.id === id)
        if (index < 0) return null
        const rule = s.rules[index]
        const asked = answered(rule)
        if (asked.length) s.forgotten = [...(s.forgotten ?? []), ...asked]
        await saveRules(s, s.rules.filter((r) => r.id !== id))
        return { rule, index }
      })
    }
  }
  return ai
}
