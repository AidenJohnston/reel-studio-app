// Public interface (docs/architecture.md section 8) + provider-neutral model types.

/** Where a long task is, for honest overall progress + time left (the app weighs phases from history).
 * listen = transcribe, analyze = retakes/face, firstLook = the no-AI preview, edit = the AI's turns and
 * tools, final = the full-quality render. */
export type Phase = 'listen' | 'analyze' | 'firstLook' | 'edit' | 'final';

export type AgentEvent =
  | { type: 'status'; message: string; pct?: number; phase?: Phase; /** waiting on the model's answer */ thinking?: boolean }
  | { type: 'tool'; name: string; summary: string }
  | { type: 'render'; version: number; draft: boolean; /** the no-AI first look, shown while the AI edits */ firstLook?: boolean; file?: string }
  /** a note's reply, known before the render that makes it true (fast notes): the app shows it at once */
  | { type: 'reply'; text: string }

export interface AgentResult {
  summary: string; version: number;
  /** rules saved to My style because the user's note asked for it ("always...", "from now on...") */
  styleRulesAdded: string[];
  /** rules the AI only PROPOSES: show "Remember this for next time?" Yes / No; Yes = addStyleRule(text) */
  styleSuggestions: string[];
  changed: string[];
}
export interface ScriptResult { hook: string; script: string; onScreenText: string[] }

export interface EngineProgress { stage: string; pct: number; message: string }
export interface EngineHost {
  runEngine(command: string, args: string[], onProgress?: (p: EngineProgress) => void, signal?: AbortSignal): Promise<any>;
  renderAnimation(template: string, params: Record<string, unknown>, outPath: string): Promise<string>;
  reelStudioRoot(): string;
  /** Screenshot of a web page into outPath (PNG). Only the Electron app has one (offscreen window). */
  captureWebsite?(url: string, outPath: string, opts?: { layout?: 'phone' | 'desktop' }): Promise<CaptureResult>;
}
export interface CaptureResult { path: string; url: string; site: string; title: string; width: number; height: number }

export type ProviderId = 'chatgpt' | 'claude' | 'codex-cli' | 'claude-cli' | 'replay' | 'none';
export interface ProviderStatus { id: ProviderId; connected: boolean; label: string; detail?: string; error?: UserFacingError }

/** Mirrors Electron's safeStorage. The app passes `safeStorage`; tests pass a fake. */
export interface SecretStore {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

export interface UserFacingError { code: string; userMessage: string; link?: string; retryable?: boolean }

/** Error with a grandma-friendly message. `link` is shown as a button when present. */
export class AIError extends Error implements UserFacingError {
  constructor(
    public readonly code: string,
    public readonly userMessage: string,
    opts: { detail?: string; link?: string; retryable?: boolean; status?: number; requestId?: string } = {},
  ) {
    super(opts.detail ?? userMessage);
    this.name = 'AIError';
    this.link = opts.link;
    this.retryable = opts.retryable ?? false;
    this.status = opts.status;
    this.requestId = opts.requestId;
  }
  link?: string;
  retryable: boolean;
  status?: number;
  requestId?: string;
  toJSON(): UserFacingError & { status?: number; requestId?: string } {
    return { code: this.code, userMessage: this.userMessage, link: this.link, retryable: this.retryable, status: this.status, requestId: this.requestId };
  }
}

// ---------------------------------------------------------------- model layer

export interface ImagePart { type: 'image'; mime: string; base64: string; path?: string }
export interface TextPart { type: 'text'; text: string }
export type Part = TextPart | ImagePart;

export interface ToolCall { id: string; name: string; args: Record<string, unknown>; raw?: unknown }
export interface ToolResultMsg { callId: string; name: string; content: string; images?: ImagePart[]; isError?: boolean }

export type ChatMessage =
  | { role: 'user'; content: Part[] }
  | { role: 'assistant'; text: string; toolCalls: ToolCall[]; raw?: unknown }
  | { role: 'tool'; results: ToolResultMsg[] };

export interface ToolSchema { name: string; description: string; parameters: Record<string, unknown> }

export interface CompletionRequest {
  system: string;
  messages: ChatMessage[];
  tools: ToolSchema[];
  /** When set, the model must answer with JSON only (no tools). */
  jsonOnly?: boolean;
  signal?: AbortSignal;
}
export interface TokenUsage { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }
export interface CompletionResponse {
  text: string; toolCalls: ToolCall[]; raw?: unknown; usage?: TokenUsage;
  /** the reply meant to call tools but could not be read (the loop re-asks with a format correction) */
  malformed?: boolean;
  /** the calls were read from a non-protocol format (XML-style) */
  repaired?: 'xml';
}

export interface ModelProvider {
  readonly id: ProviderId | 'fake';
  readonly model?: string;
  readonly supportsImages: boolean;
  complete(req: CompletionRequest): Promise<CompletionResponse>;
  /** Release anything kept between turns (a live CLI session). Called when an agent run ends. */
  dispose?(): void;
}
