// Types shared by the main process, the preload bridge and the renderer.
// Keep this file free of Node and DOM imports.
import type { ChatAction } from './notes'
export type { ChatAction } from './notes'

export type AppCommand = { type: 'new-video' | 'settings' | 'export' | 'library' } | { type: 'open-reel'; slug: string }

export type ScreenStatus = 'new' | 'working' | 'ready' | 'interrupted' | 'failed'

export interface ProjectSummary {
  slug: string
  dir: string
  title: string
  createdAt: string
  updatedAt: string
  version: number
  thumbnail: string | null
  status: ScreenStatus
}

export interface VersionInfo {
  n: number
  video: string
  videoPath: string
  draft: boolean
  cover: string | null
  createdAt: string
}

export interface Word {
  id: string
  w: string
  s: number
  e: number
  source?: string
}

export interface ChecklistItem {
  key: string
  label: string
  done: boolean
  detail?: string
}

export interface ChatMessage {
  id: string
  from: 'you' | 'editor'
  text: string
  at: string
  version?: number
  /** Buttons under an editor message (e.g. "Open caption settings", "Connect ChatGPT"). */
  actions?: ChatAction[]
  /** A My style rule the AI suggested; saved only if the user answers Yes (remember-yes). */
  suggestion?: string
}

export interface ProjectDetail extends ProjectSummary {
  /** The raw take (reel-media URL), or null before it is copied in. */
  sourceVideo: string | null
  project: ProjectJson
  versions: VersionInfo[]
  words: Word[]
  keptIds: string[]
  checklist: ChecklistItem[]
  chat: ChatMessage[]
  lastError: { code: string; userMessage: string } | null
  job: { id: string; kind: JobKind; message: string; pct: number; overall: number; secondsLeft: number | null; overdue: boolean; thinking: boolean } | null
  /** A small picture for each b-roll item with an image file (broll id -> reel-media URL). Animations and
   * text-only items have none (the Pictures list names them in words instead of a file name). */
  brollThumbs: Record<string, string>
  /** True when an AI editor made this video's edit. False = the simple no-AI edit (be honest about it). */
  aiEdited: boolean
}

// Loose mirror of project.json (docs/architecture.md section 3). The engine owns validation.
export interface ProjectJson {
  schemaVersion: number
  id: string
  title: string
  slug: string
  createdAt: string
  updatedAt: string
  version: number
  format?: { width: number; height: number; fps: number }
  sources?: { id: string; path: string; duration?: number }[]
  transcript?: { file: string; language?: string }
  cut?: { keep: { from: string; to: string }[]; gapCap?: number; minSaving?: number }
  captions?: {
    enabled: boolean
    style?: Record<string, unknown>
    corrections?: { from: string; to: string }[]
  }
  music?: {
    enabled: boolean
    track: string | null
    startAt?: number
    level?: string
    automation?: unknown[]
    fadeOut?: number
  }
  broll?: {
    id: string
    anchor: { from: string; to: string }
    treatment: string
    /** Library path, project path or animation id; null for text-only treatments. */
    asset: string | null
    params?: Record<string, unknown>
  }[]
  zooms?: unknown[]
  cover?: { atSourceTime: number; source: string; text: string | null }
  post?: { caption: string; hashtags: string[]; keywords: string[] }
  notes?: { version: number; text: string; applied: string[]; at: string }[]
  [k: string]: unknown
}

export type JobKind = 'first-edit' | 'note' | 'rerender' | 'export' | 'script'

/** The steps of a job, tagged by the ai package on its status events (main/progress.ts times them). */
export type Phase = 'listen' | 'analyze' | 'firstLook' | 'edit' | 'final'

/**
 * What a running job reports to main (jobs.ts `Emit`): the ai package's AgentEvent plus what main adds
 * itself. ONE contract; `shared/live.ts` is the only reader on the renderer side.
 */
export type JobUpdate =
  /** pct = this step's own percent (restarts per step). thinking = waiting on the AI's answer. */
  | { type: 'status'; message: string; pct?: number; phase?: Phase; thinking?: boolean }
  | { type: 'tool'; name: string; summary: string }
  /** A render finished. firstLook = the quick no-AI preview made while the AI still edits (not a version).
   * file = the engine's output path (absolute); main turns it into `video` for the renderer. */
  | { type: 'render'; version: number; draft: boolean; firstLook?: boolean; file?: string }
  /** The reply to a note, known before the render that makes it true (fast notes). Shown at once;
   * the same text lands in the chat when the job is done. */
  | { type: 'reply'; text: string }
  /** The words heard, once listening is done (main reads them from the transcript). */
  | { type: 'heard'; words: string[] }

type Ids = { jobId: string; slug: string | null }

/** Every event the renderer receives (`reel.jobs.onEvent`). */
export type JobEvent = Ids &
  (
    /** overall = honest 0-99 for the whole job, never backwards; secondsLeft = from this computer's measured
     * history (main/progress.ts), null = too early to say. Status repeats about once a second while a job
     * runs (thinking kept), so a bar fed by `overall` never freezes. */
    /** overdue = past every estimate on the last step: show "Still working, almost there", no number. */
    | { type: 'status'; message: string; pct: number; phase?: Phase; overall: number; secondsLeft: number | null; overdue: boolean; thinking: boolean }
    | { type: 'tool'; name: string; summary: string }
    /** video = a playable reel-media URL of a stable copy (never the file the engine overwrites next). */
    | { type: 'render'; version: number; draft: boolean; firstLook: boolean; video: string | null }
    | { type: 'reply'; text: string }
    | { type: 'heard'; words: string[] }
    | { type: 'done'; summary: string; version?: number }
    | { type: 'error'; code: string; userMessage: string }
    | { type: 'cancelled' }
  )

export interface LibraryFile {
  name: string
  path: string
  url: string
  size: number
  modifiedAt: string
}

export interface LibraryBin {
  key: 'raw' | 'broll' | 'music' | 'images' | 'exports'
  label: string
  dir: string
  files: LibraryFile[]
}

export interface DropResult {
  file: string
  name: string
  bin: LibraryBin['key'] | null
  dest: string | null
  reason?: string
}

export interface ProviderInfo {
  id: 'chatgpt' | 'claude' | 'codex-cli' | 'claude-cli' | 'replay' | 'none'
  connected: boolean
  label: string
  detail?: string
  error?: UserError
}

export interface AppInfo {
  version: string
  platform: string
  root: string
  /** The root in friendly words: "Documents › Reel Studio". */
  rootDisplay: string
  firstRunDone: boolean
  engine: { mode: 'real' | 'fake'; dir: string; python: string }
  ai: 'package' | 'mock'
  test: boolean
  /** REELSTUDIO_DEV=1: show the dev-only AI providers. */
  dev: boolean
  /** Built with REELSTUDIO_LOCAL_CLAUDE_CODE_BUILD=1: may offer Claude Code on this computer. */
  localClaudeCode: boolean
}

export interface ModelStatus {
  name: string
  installed: boolean
  downloading: boolean
  pct: number
  bytes: number
  total: number
  error: string | null
}

export interface StyleRule {
  id: string
  text: string
  createdAt: string
}

export interface ExportResult {
  folder: string
  video: string
  cover: string | null
  captionFile: string
  caption: string
}

/** "Send to my phone": one network the phone could reach this computer on. */
export interface PhoneAddress {
  address: string
  label: string
  likely: boolean
}

/** A running "Send to my phone" link (one video, one-time token, stops by itself). */
export interface PhoneShare {
  url: string
  address: string
  /** Every network the link could use, best first, for "Use a different network". */
  addresses: PhoneAddress[]
  expiresAt: number
  /** Bytes, for the email size warning. */
  size: number
  /** Show the "phone can't connect?" help after this long without a visit. */
  waitMs: number
}

export type PhoneEvent = { kind: 'page' } | { kind: 'video' } | { kind: 'stopped'; reason: 'timeout' | 'closed' }

export interface ScriptResult {
  hook: string
  script: string
  onScreenText: string[]
}

export interface UserError {
  code: string
  userMessage: string
  /** A page that helps (e.g. the ChatGPT usage page). */
  link?: string
}

export interface ReelApi {
  app: {
    info(): Promise<AppInfo>
    finishFirstRun(): Promise<void>
    openFolder(path: string): Promise<void>
    copyText(text: string): Promise<void>
    pathForFile(file: File): string
    chooseFolder(): Promise<string | null>
    setRoot(path: string): Promise<AppInfo>
    /** Menu items, keyboard shortcuts handled by the menu, and notification clicks. */
    onCommand(cb: (c: AppCommand) => void): () => void
    /** Drag a finished file out of the app (desktop, folder, browser upload box). Call from dragstart. */
    startDrag(file: string): void
  }
  model: {
    status(): Promise<ModelStatus>
    download(): Promise<ModelStatus>
    cancel(): Promise<void>
    onProgress(cb: (s: ModelStatus) => void): () => void
  }
  ai: {
    providers(): Promise<ProviderInfo[]>
    active(): Promise<ProviderInfo>
    setActive(id: ProviderInfo['id']): Promise<void>
    signInChatGPT(): Promise<ProviderInfo>
    cancelSignIn(): Promise<void>
    signOutChatGPT(): Promise<void>
    setClaudeKey(key: string | null): Promise<ProviderInfo>
  }
  projects: {
    list(): Promise<ProjectSummary[]>
    get(slug: string): Promise<ProjectDetail>
    create(files: string[]): Promise<{ slug: string; jobId: string; skipped: DropResult[] }>
    resume(slug: string): Promise<{ jobId: string }>
    /** jobId null = no AI connected: the note and a plain reply were added to the chat, nothing runs. */
    note(slug: string, text: string): Promise<{ jobId: string | null }>
    update(slug: string, patch: Partial<ProjectJson>): Promise<ProjectDetail>
    /** `change`: what changed, in plain words ("bigger yellow subtitles"), for the chat and the version button.
     * `label`: what to call the work while it runs ("Updating your subtitles"). Render only, never the AI. */
    rerender(slug: string, change?: string, label?: string): Promise<{ jobId: string }>
    exportVersion(slug: string, version: number): Promise<ExportResult>
    remove(slug: string): Promise<void>
  }
  jobs: {
    cancel(jobId: string): Promise<void>
    onEvent(cb: (e: JobEvent) => void): () => void
  }
  phone: {
    /** Start (or restart, e.g. on another network) the link for one exported video. */
    start(video: string, caption: string, address?: string): Promise<PhoneShare>
    stop(): Promise<void>
    onEvent(cb: (e: PhoneEvent) => void): () => void
    /** Open a new email to yourself and show the video in Finder/Explorer to attach it. */
    emailSelf(video: string): Promise<void>
    /** macOS: the Share menu (AirDrop, Messages). Elsewhere: show the file. */
    shareSheet(video: string): Promise<void>
  }
  library: {
    list(): Promise<LibraryBin[]>
    add(paths: string[]): Promise<DropResult[]>
    /** Open the system file picker for songs or pictures and add the picked files. [] = cancelled. */
    choose(kind: 'music' | 'images'): Promise<DropResult[]>
  }
  style: {
    rules(): Promise<StyleRule[]>
    remove(id: string): Promise<void>
    /** Answer "Remember this for next time?" on a chat message: Yes saves the rule, No only says so. */
    answer(slug: string, messageId: string, yes: boolean): Promise<void>
  }
  script: {
    write(idea: string): Promise<ScriptResult>
  }
  dev: {
    /** Test builds only. `template` defaults to the bundled self-test template. */
    renderTestAnimation(outPath: string, fullSize?: boolean, template?: string, params?: Record<string, unknown>): Promise<string>
  }
}
