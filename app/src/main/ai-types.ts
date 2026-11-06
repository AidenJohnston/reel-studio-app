// Mirror of the @reelstudio/ai interface (docs/architecture.md section 8). The real package is loaded at
// runtime when it exists; until then ai-mock.ts implements the same shape.
import type { EditorAccounts, EditorModel, JobUpdate, LimitWindow, MemorySuggestion, ModelRole, RuleCheck, StyleProposal, StyleRule, MergeRequest, ProjectJson, ReelCandidateView, Word } from '../shared/api'
import type { PlanTurn } from '../shared/plan'
import type { Niche, NicheTurn, NicheTurnResult } from '../shared/niche'
import type { TryVariable } from '../shared/platforms'
import type { EngineProgress } from './engine'

/** What @reelstudio/ai emits: the job contract minus `heard` (main adds that one itself). */
export type AgentEvent = Exclude<JobUpdate, { type: 'heard' }>

export interface UserFacingError {
  code: string
  userMessage: string
  link?: string
}

export interface AgentResult {
  summary: string
  /** Absent when a note changed nothing (no edit, no saved My style rule) or its edit ended where it started: its reply belongs to no version. */
  version?: number
  styleRulesAdded: string[]
  changed: string[]
  /** Rules the AI PROPOSES for My style, not saved (stream quality2). The app asks before saving. */
  styleSuggestions?: string[]
  /** A typed rule to ask about; Yes = approveStyleProposal(it). */
  styleProposal?: StyleProposal
  /** Rules the app would measure on every render, measured on this version; Yes = addStyleRule(text, from, check). */
  styleChecks?: { text: string; check: RuleCheck }[]
  /** Set when the AI stopped early and a simpler edit was made instead. */
  notice?: UserFacingError
  /** the model that made this version ("Claude Sonnet 5.5 · High"); absent for a basic version */
  model?: string
}

/** One turn of a planned reel's planning chat (ai editor.ts planTurn). `asked`: questions the editor has asked. */
export interface PlanTurnInput {
  turns: PlanTurn[]
  asked: number
  plan: { hooks: string[]; hook: number; beats: string[]; shots: string[] } | null
}
/** A short question back, or the whole plan: 2-3 hooks, 3-6 beats, 1-6 shots, one line each. */
export type PlanTurnResult = ({ kind: 'question'; text: string } | { kind: 'plan'; say: string; title?: string; hooks: string[]; beats: string[]; shots: string[] }) & { raw?: unknown }

/** What the editor reads to choose Try 2 (ai/src/trial.ts). */
export interface TryRequest {
  /** Try 1's caption as posted; its first line is the hook line. */
  caption: string
  duration: number
  /** What is said, on the finished reel's clock, with each word's start and end. */
  words: { w: string; s: number; e: number }[]
  coverSeconds: number | null
  /** The creator swapped to this one. */
  variable?: TryVariable
}

/** What the editor reads to find more reels in one video (ai/src/propose.ts). */
export interface ProposeReelsRequest {
  /** work/transcript.json, with the analysis's retake groups */
  transcript: { words: Word[]; retakes?: unknown }
  gapCap: number
  title: string
  /** words no proposal may use: this reel's cut and the reels already made from it */
  taken: { from: string; to: string }[]
  limit?: number
}
/** The reels the editor found, best first, each checked against the words (ai/src/propose.ts). */
export interface ReelProposal {
  candidates: Omit<ReelCandidateView, 'hookText'>[]
  notes: string
  attempts: number
}

export interface EngineHost {
  runEngine(
    command: string,
    args: string[],
    onProgress?: (p: EngineProgress) => void,
    signal?: AbortSignal
  ): Promise<any>
  renderAnimation(template: string, params: Record<string, unknown>, outPath: string, fps?: number): Promise<string>
  reelStudioRoot(): string
  captureWebsite?(
    url: string,
    outPath: string,
    opts?: { layout?: 'phone' | 'desktop' }
  ): Promise<{ path: string; url: string; site: string; title: string; width: number; height: number }>
  /** A Footage/<folder>/<file> path from search_footage, copied into the Library: returns its Library/... path.
   * Only the app has footage folders (app main/footage-sources.ts). */
  importFootage?(ref: string): Promise<string>
}

export interface ProviderStatus {
  id: 'claude' | 'codex-cli' | 'claude-cli' | 'custom' | 'replay' | 'none'
  connected: boolean
  label: string
  detail?: string
  error?: UserFacingError
  connectionId?: string
}

export interface ConnectionInfo {
  id: string
  label: string
  kind: 'anthropic' | 'openai' | 'cliproxy'
  keySource?: string
  hasManagementKey?: boolean
  baseURL: string
  model: string
  supportsImages: boolean
  hasKey: boolean
  active: boolean
}

export interface ConnectionInput {
  id?: string
  label: string
  kind: 'anthropic' | 'openai'
  baseURL: string
  model: string
  /** empty keeps the stored key when editing */
  key?: string
}

export interface SaveConnectionResult {
  status: ProviderStatus
  connection?: ConnectionInfo
  error?: UserFacingError & { field?: 'label' | 'address' | 'key' | 'model' }
}

/** Mirrors Electron's safeStorage. */
export interface SecretStore {
  isEncryptionAvailable(): boolean
  getSelectedStorageBackend?(): string
  encryptString(s: string): Buffer
  decryptString(b: Buffer): string
  getSelectedStorageBackend?(): string
}

export interface AI {
  providers(): Promise<ProviderStatus[]>
  active(): Promise<ProviderStatus>
  setActive(id: ProviderStatus['id'], connectionId?: string): Promise<void>
  stockProviders(): Promise<{ id: 'pexels' | 'pixabay' | 'openverse'; connected: boolean }[]>
  setStockKey(provider: 'pexels' | 'pixabay', key: string | null): Promise<void>
  setClaudeKey(key: string | null): Promise<ProviderStatus>
  /** `opts.basic`: the simple edit without a model, whatever editor is connected. */
  /** `opts.pauseOn`: an AI failure the app pauses on (a plan at its limit, no internet), thrown instead of a basic version. */
  firstEdit(
    projectDir: string,
    onEvent: (e: AgentEvent) => void,
    signal?: AbortSignal,
    opts?: { owner?: string; basic?: boolean; pauseOn?: (e: { code: string; resetsAt?: string }) => boolean }
  ): Promise<AgentResult>
  /** `opts.attachments`: `work/assets/attach-*` refs main already checked (the AI checks them again).
   * `opts.id`: the job id the note is saved under. `opts.saveStyleRules: false`: return rules, the app asks.
   * `opts.owner`: the job's owner token, which the note joins instead of taking the project. */
  applyNote(
    projectDir: string,
    note: string,
    onEvent: (e: AgentEvent) => void,
    signal?: AbortSignal,
    opts?: { attachments?: string[]; id?: string; saveStyleRules?: boolean; owner?: string; jobId?: string; checkEdit?: boolean; base?: number }
  ): Promise<AgentResult>
  mergeVersions?(projectDir: string, request: MergeRequest, onEvent: (e: AgentEvent) => void, signal?: AbortSignal, opts?: { id?: string; owner?: string }): Promise<AgentResult & { edit: ProjectJson; report: string[] }>
  /** The words are a whole-reel setting applyNote does without the model ("smaller captions"). */
  wholeReelSetting(projectDir: string, note: string): Promise<boolean>
  planTurn(input: PlanTurnInput, onEvent: (e: AgentEvent) => void, signal?: AbortSignal): Promise<PlanTurnResult>
  /** One turn of My style's niche chat (ai niche.ts nicheTurn): a short question back, or the whole niche. The turns
   * start with the app's own question. Optional: older packages lack it. */
  nicheTurn?(input: { turns: NicheTurn[]; asked: number; niche: Niche | null }, onEvent: (e: AgentEvent) => void, signal?: AbortSignal): Promise<NicheTurnResult>
  /** Try 2 for a trial post: the one thing the editor changes, and its reason in its own voice. Optional: older packages lack it. */
  proposeTry?(req: TryRequest, signal?: AbortSignal): Promise<{ variable: unknown; value: unknown; reason: unknown }>
  /** More reels from one video. `onEvent` hears the waits for the editor's answer. Optional: older packages lack it. */
  proposeReels?(req: ProposeReelsRequest, signal?: AbortSignal, onEvent?: (e: AgentEvent) => void): Promise<ReelProposal>
  styleRules(): Promise<StyleRule[]>
  /** The removed rule and where it was, for Undo; null when it was already gone. */
  /** The removed rule and where it was, for Undo; null when it was already gone. `forget` (default true): learning
   * (learn()) never proposes its words again; false when the app takes back a rule the AI saved on its own. */
  removeStyleRule(id: string, options?: { forget?: boolean }): Promise<{ rule: StyleRule; index: number } | null>
  /** Saves one My style rule (after the user said Yes, typed in My style, or learned from an export). Optional: older packages lack it. */
  addStyleRule?(text: string, from?: Pick<StyleRule, 'source' | 'imported' | 'byYou'>, check?: RuleCheck): Promise<StyleRule>
  /** Undo of removeStyleRule. */
  restoreStyleRule?(rule: StyleRule, index: number): Promise<void>
  /** My style started over because its file was damaged; the damaged copy is kept next to it. Optional: older packages lack it. */
  styleWasDamaged?(): Promise<boolean>
  /** Saves a typed rule the user said Yes to. `exists`: already in My style; `forgotten`: they removed it since. */
  approveStyleProposal?(p: StyleProposal): Promise<{ status: 'saved' | 'exists' | 'forgotten' }>
  declineStyleProposal?(p: StyleProposal): Promise<void>
  /** Memories drafted from post results (read-only); each goes to proposeMemory. Optional: older packages lack these. */
  learnFromResults?(): Promise<unknown[]>
  /** Keeps a drafted memory waiting in My style: 'added', or why not ('duplicate', 'forgotten', 'full'). */
  proposeMemory?(draft: unknown): Promise<string>
  memoryProposals?(): Promise<MemorySuggestion[]>
  acceptMemory?(id: string, words?: string): Promise<StyleRule | null>
  dismissMemory?(id: string): Promise<void>
  /** My style: change a rule's words, or pause or resume it. Optional: older packages lack it. */
  updateStyleRule?(id: string, patch: { text?: string; paused?: boolean }): Promise<StyleRule>
  /** Stops setActive('claude-cli')'s check call, which then throws code 'cancelled'. Optional: older packages lack it. */
  cancelCheck?(): void
  /** A fresh look at the person's own Claude Code app (`bin` stays in main). Optional: older packages lack it. */
  claudeCodeStatus?(): Promise<ClaudeCodeStatus>
  /** A fresh look at the person's own Codex app (`bin` stays in main). */
  codexStatus?(): Promise<ClaudeCodeStatus & { chatgptMoved?: boolean }>
  /** Once at start-up: signs out a saved "Sign in with ChatGPT" session (retired) and clears it as the choice. */
  retireSignInWithChatGPT?(): Promise<boolean>
  /** The person's own servers (provider 'custom'). Optional: older packages and the mock lack them. */
  connections?(): Promise<ConnectionInfo[]>
  saveConnection?(input: ConnectionInput): Promise<SaveConnectionResult>
  removeConnection?(id: string): Promise<void>
  setConnectionImages?(id: string, supportsImages: boolean): Promise<void>
  connectionModels?(q: { kind: ConnectionInfo['kind']; baseURL: string; key?: string; id?: string }): Promise<{ models: string[]; suggested: string | null; needsKey: boolean }>
  /** One small-model call that rewords a version's title and summary; null when the connection has no small model. Optional: older packages lack it. */
  rewordVersion?(text: { title: string; summary: string }, signal?: AbortSignal): Promise<{ title: string; summary: string } | null>
  /** CLIProxyAPI as the editor (ai index.ts saveHub), its management key, and what the editor in use offers and runs
   * as. Optional: older packages and the mock lack them. */
  saveHub?(input: { origin: string; key: string; keySource: string }): Promise<SaveConnectionResult>
  setHubManagementKey?(key: string | null): Promise<EditorAccounts>
  editorModels?(): Promise<EditorModel[]>
  autoModels?(): Promise<Partial<Record<ModelRole, string | null>>>
  editorAccounts?(): Promise<EditorAccounts>
  /** One tiny prompt through `role`'s model. */
  testConnection?(signal?: AbortSignal, role?: ModelRole): Promise<{ reply: string; model?: string; ms: number; limits?: LimitWindow[]; note?: string }>
  /** Mock only: the sign-in window "opened" (tests flip the mock's state instead of opening a terminal). */
  mockClaudeSignInOpened?(): void
  /** Mock only: how REELSTUDIO_MOCK_CLAUDE / REELSTUDIO_MOCK_CODEX play an install and a browser sign-in. */
  mockVendor?: MockVendor
}

/** Mock only (ai-mock.ts): plays a sign-in for the editor rows without a real CLI. */
export interface MockVendor {
  /** with onDeviceCode: ChatGPT's sign-in with a code */
  login(
    v: 'claude' | 'chatgpt',
    signal: AbortSignal,
    onDeviceCode?: (c: { url: string; code: string }) => void
  ): Promise<{ code: number | null; portBusy?: boolean; portReserved?: boolean; deviceCodeOff?: boolean; aborted?: boolean }>
}

export interface ClaudeCodeStatus {
  state: 'missing' | 'broken' | 'signed_out' | 'ready'
  /** with 'signed_out': could not tell (Codex: a slow or unclear `codex login status`) */
  unknown?: boolean
  bin?: string
  version?: string
  plan?: string
  reason?: string
}

export interface CreateAIOptions {
  host: EngineHost
  settingsDir: string
  dev?: boolean
  secretStore?: SecretStore
  /** Settings › Editor › Models: a model per role, 'auto' for the editor's own (ai index.ts modelForRole). */
  roleModels?: () => Promise<Partial<Record<'editor' | 'checker' | 'writer', string>>>
  /** the environment the person's own CLIs get (main's test switch can swap in a throwaway home) */
  cliEnv?: () => NodeJS.ProcessEnv
  /** draw what each reply of the AI changed before its draft (`moment` events) */
  moments?: boolean
}

export type CreateAI = (opts: CreateAIOptions) => AI
