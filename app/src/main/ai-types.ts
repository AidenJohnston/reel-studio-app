// Mirror of the @reelstudio/ai interface (docs/architecture.md section 8). The real package is loaded at
// runtime when it exists; until then ai-mock.ts implements the same shape.
import type { JobUpdate } from '../shared/api'

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
  id: 'chatgpt' | 'claude' | 'codex-cli' | 'claude-cli' | 'replay' | 'none'
  connected: boolean
  label: string
  detail?: string
  error?: UserFacingError
}

/** Mirrors Electron's safeStorage. */
export interface SecretStore {
  isEncryptionAvailable(): boolean
  encryptString(s: string): Buffer
  decryptString(b: Buffer): string
}

export interface AI {
  providers(): Promise<ProviderStatus[]>
  active(): Promise<ProviderStatus>
  setActive(id: ProviderStatus['id']): Promise<void>
  signInChatGPT(openExternal: (url: string) => Promise<void>): Promise<ProviderStatus>
  signOutChatGPT(): Promise<void>
  setClaudeKey(key: string | null): Promise<ProviderStatus>
  firstEdit(projectDir: string, onEvent: (e: AgentEvent) => void, signal?: AbortSignal): Promise<AgentResult>
  /** `opts.attachments`: `work/assets/attach-*` refs main already checked (the AI checks them again).
   * `opts.id`: the job id the note is saved under. `opts.saveStyleRules: false`: return rules, the app asks. */
  applyNote(
    projectDir: string,
    note: string,
    onEvent: (e: AgentEvent) => void,
    signal?: AbortSignal,
    opts?: { attachments?: string[]; id?: string; saveStyleRules?: boolean }
  ): Promise<AgentResult>
  writeScript(idea: string, onEvent: (e: AgentEvent) => void, signal?: AbortSignal): Promise<ScriptResult>
  styleRules(): Promise<{ id: string; text: string; createdAt: string }[]>
  removeStyleRule(id: string): Promise<void>
  /** Saves one My style rule (after the user said Yes). Optional: older packages lack it. */
  addStyleRule?(text: string): Promise<{ id: string; text: string; createdAt: string }>
  /** Optional extras from @reelstudio/ai. */
  cancelSignInChatGPT?(): void | Promise<void>
  /** A fresh look at the person's own Claude Code app (`bin` stays in main). Optional: older packages lack it. */
  claudeCodeStatus?(): Promise<ClaudeCodeStatus>
  /** Mock only: the sign-in window "opened" (tests flip the mock's state instead of opening a terminal). */
  mockClaudeSignInOpened?(): void
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
}

export type CreateAI = (opts: CreateAIOptions) => AI
