// Mirror of the @reelstudio/ai interface (docs/architecture.md section 8). The real package is loaded at
// runtime when it exists; until then ai-mock.ts implements the same shape.
import type { JobUpdate, StyleProposal, StyleRule } from '../shared/api'

/** What @reelstudio/ai emits: the job contract minus `heard` (main adds that one itself). */
export type AgentEvent = Exclude<JobUpdate, { type: 'heard' }>

export interface UserFacingError {
  code: string
  userMessage: string
  link?: string
}

export interface AgentResult {
  summary: string
  version: number
  styleRulesAdded: string[]
  changed: string[]
  /** Rules the AI PROPOSES for My style, not saved (stream quality2). The app asks before saving. */
  styleSuggestions?: string[]
  /** A typed rule to ask about; Yes = approveStyleProposal(it). */
  styleProposal?: StyleProposal
  /** Set when the AI stopped early and a simpler edit was made instead. */
  notice?: UserFacingError
}

export interface ScriptResult {
  hook: string
  script: string
  onScreenText: string[]
}

export interface EngineHost {
  runEngine(
    command: string,
    args: string[],
    onProgress?: (p: { stage: string; pct: number; message: string }) => void,
    signal?: AbortSignal
  ): Promise<any>
  renderAnimation(template: string, params: Record<string, unknown>, outPath: string): Promise<string>
  reelStudioRoot(): string
  captureWebsite?(
    url: string,
    outPath: string,
    opts?: { layout?: 'phone' | 'desktop' }
  ): Promise<{ path: string; url: string; site: string; title: string; width: number; height: number }>
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
  kind: 'anthropic' | 'openai'
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
  encryptString(s: string): Buffer
  decryptString(b: Buffer): string
  getSelectedStorageBackend?(): string
}

export interface AI {
  providers(): Promise<ProviderStatus[]>
  active(): Promise<ProviderStatus>
  setActive(id: ProviderStatus['id'], connectionId?: string): Promise<void>
  setClaudeKey(key: string | null): Promise<ProviderStatus>
  firstEdit(projectDir: string, onEvent: (e: AgentEvent) => void, signal?: AbortSignal): Promise<AgentResult>
  /** `opts.attachments`: `work/assets/attach-*` refs main already checked (the AI checks them again). */
  applyNote(
    projectDir: string,
    note: string,
    onEvent: (e: AgentEvent) => void,
    signal?: AbortSignal,
    opts?: { attachments?: string[] }
  ): Promise<AgentResult>
  writeScript(idea: string, onEvent: (e: AgentEvent) => void, signal?: AbortSignal): Promise<ScriptResult>
  styleRules(): Promise<StyleRule[]>
  removeStyleRule(id: string): Promise<void>
  /** Saves one My style rule (after the user said Yes). Optional: older packages lack it. */
  addStyleRule?(text: string): Promise<{ id: string; text: string; createdAt: string }>
  /** My style started over because its file was damaged; the damaged copy is kept next to it. Optional: older packages lack it. */
  styleWasDamaged?(): Promise<boolean>
  /** Saves a typed rule the user said Yes to. `exists`: already in My style; `forgotten`: they removed it since. */
  approveStyleProposal?(p: StyleProposal): Promise<{ status: 'saved' | 'exists' | 'forgotten' }>
  declineStyleProposal?(p: StyleProposal): Promise<void>
  /** My style: change a rule's words, or pause or resume it. Optional: older packages lack it. */
  updateStyleRule?(id: string, patch: { text?: string; paused?: boolean }): Promise<StyleRule>
  /** A fresh look at the person's own Claude Code app (`bin` stays in main). Optional: older packages lack it. */
  claudeCodeStatus?(): Promise<ClaudeCodeStatus>
  /** The person's own servers (provider 'custom'). Optional: older packages and the mock lack them. */
  connections?(): Promise<ConnectionInfo[]>
  saveConnection?(input: ConnectionInput): Promise<SaveConnectionResult>
  removeConnection?(id: string): Promise<void>
  setConnectionImages?(id: string, supportsImages: boolean): Promise<void>
  connectionModels?(q: { kind: ConnectionInfo['kind']; baseURL: string; key?: string; id?: string }): Promise<{ models: string[]; suggested: string | null; needsKey: boolean }>
  /** A fresh look at the person's own Codex app (`bin` stays in main). */
  codexStatus?(): Promise<ClaudeCodeStatus & { chatgptMoved?: boolean }>
  /** Once at start-up: signs out a saved "Sign in with ChatGPT" session (retired) and clears it as the choice. */
  retireSignInWithChatGPT?(): Promise<boolean>
  /** Mock only: the sign-in window "opened" (tests flip the mock's state instead of opening a terminal). */
  mockClaudeSignInOpened?(): void
  /** Mock only: how REELSTUDIO_MOCK_CLAUDE / REELSTUDIO_MOCK_CODEX play an install and a browser sign-in. */
  mockVendor?: MockVendor
}

/** Mock only (ai-mock.ts): plays install and sign-in for the Connect cards without a real CLI. */
export interface MockVendor {
  install(v: 'claude' | 'chatgpt', signal: AbortSignal): Promise<void>
  login(v: 'claude' | 'chatgpt', signal: AbortSignal): Promise<{ code: number | null; portBusy?: boolean; aborted?: boolean }>
}

export interface ClaudeCodeStatus {
  state: 'missing' | 'broken' | 'signed_out' | 'ready'
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
  /** the environment the person's own CLIs get (main's test switch can swap in a throwaway home) */
  cliEnv?: () => NodeJS.ProcessEnv
}

export type CreateAI = (opts: CreateAIOptions) => AI
