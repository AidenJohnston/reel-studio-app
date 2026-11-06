// Public interface (docs/architecture.md section 8) + provider-neutral model types.
import type { StyleProposal } from './style';
import type { StyleCheckProposal } from './rules';

/** Where a long task is, for honest overall progress + time left (the app weighs phases from history).
 * listen = transcribe, analyze = retakes/face, firstLook = the no-AI preview, edit = the AI's turns and
 * tools, final = the full-quality render. */
export type Phase = 'listen' | 'analyze' | 'firstLook' | 'edit' | 'final';

export type AgentEvent =
  | { type: 'status'; message: string; pct?: number; phase?: Phase; /** waiting on the model's answer */ thinking?: boolean; /** the message is the wait itself (agent.ts waitWords), not the step's work */ waiting?: boolean; /** from the simple edit, made without the AI */ noAI?: boolean }
  | { type: 'tool'; name: string; summary: string }
  | { type: 'render'; version: number; draft: boolean; /** the no-AI first look, shown while the AI edits */ firstLook?: boolean; file?: string }
  /** a note's reply, known before the render that makes it true (fast notes): the app shows it at once */
  | { type: 'reply'; text: string }
  /** one line for the host's log: how a model turn spent its time (agent.ts) */
  | { type: 'trace'; text: string }
  /** a picture of what the AI just changed, drawn before the draft (moments.ts): a still at output second
   * `t`, or the 2 s window [from, to] around it. `file` is the engine's file, overwritten by later runs.
   * `run` counts the task's moments runs from 1: a newer run's pictures show a newer edit and replace an older one's. */
  | { type: 'moment'; kind: 'still'; t: number; file: string; run: number }
  | { type: 'moment'; kind: 'window'; from: number; to: number; file: string; run: number }

export interface AgentResult {
  summary: string;
  /** the version this task made or rendered again; absent when a note changed nothing (no edit, no saved My style rule) or its edit ended where it started */
  version?: number;
  /** rules saved to My style because the user's note asked for it ("always...", "from now on...") */
  styleRulesAdded: string[];
  /** rules the AI only PROPOSES: show "Remember this for next time?" Yes / No; Yes = addStyleRule(text) */
  styleSuggestions: string[];
  changed: string[];
  /** a typed rule to ask about ("Use lowercase captions."): Yes = approveStyleProposal(it) */
  styleProposal?: StyleProposal;
  /** rules the app would check on every render, measured on this version: "Remember this?" says so; Yes =
   * addStyleRule(text, from, check) */
  styleChecks?: StyleCheckProposal[];
  /** the model that made this version, as the notes name it ("Claude Sonnet 5.5 · High"); absent for a basic version */
  model?: string;
}
export interface ScriptResult { hook: string; script: string; onScreenText: string[]; title?: string }

/** One planning turn (editor.ts planTurn). `turns`: the chat so far, oldest first, ending with the creator's newest
 * message; an editor turn says whether it was a question or the plan it proposed. `asked`: questions the editor has
 * asked so far. `plan`: the plan as it stands, with the creator's own edits; null before the first one. */
export interface PlanTurnInput {
  /** `raw`: the provider's own reply as planTurn returned it (Claude's thinking blocks), sent back unchanged. */
  turns: ({ from: 'you'; text: string } | { from: 'editor'; text: string; kind: 'question' | 'plan'; raw?: unknown })[];
  asked: number;
  plan: { hooks: string[]; hook: number; beats: string[]; shots: string[] } | null;
}
/** A question back (at most PLAN_QUESTIONS in a chat), or the whole plan: 2-3 hooks, 3-6 beats, 1-6 shots, one line each. */
export type PlanTurnResult = (
  | { kind: 'question'; text: string }
  | { kind: 'plan'; say: string; title?: string; hooks: string[]; beats: string[]; shots: string[] }
) & {
  /** The provider's reply as it came (Claude's thinking blocks). Keep it with the turn and pass it back next time. */
  raw?: unknown;
};

/** Something finished that the app can show now, carried on an engine progress line (`moments` command). */
export type MomentReady =
  | { kind: 'still'; t: number; file: string }
  | { kind: 'window'; from: number; to: number; file: string };
export interface EngineProgress { stage: string; pct: number; message: string; ready?: MomentReady }
export interface EngineHost {
  runEngine(command: string, args: string[], onProgress?: (p: EngineProgress) => void, signal?: AbortSignal): Promise<any>;
  renderAnimation(template: string, params: Record<string, unknown>, outPath: string, fps?: number): Promise<string>;
  reelStudioRoot(): string;
  /** Screenshot of a web page into outPath (PNG). Only the Electron app has one (offscreen window). */
  captureWebsite?(url: string, outPath: string, opts?: { layout?: 'phone' | 'desktop' }): Promise<CaptureResult>;
  /** A Footage/<folder>/<file> path from search_footage, copied into the Library: returns its Library/... path.
   * Only the app has footage folders (app main/footage-sources.ts). */
  importFootage?(ref: string): Promise<string>;
}
export interface CaptureResult { path: string; url: string; site: string; title: string; width: number; height: number }

/** custom = a connection to the person's own Anthropic- or OpenAI-compatible server (providers/connection.ts) */
export type ProviderId = 'claude' | 'codex-cli' | 'claude-cli' | 'custom' | 'replay' | 'none';
export interface ProviderStatus {
  id: ProviderId; connected: boolean; label: string; detail?: string; error?: UserFacingError;
  /** id === 'custom': which saved connection */
  connectionId?: string;
}

/** Mirrors Electron's safeStorage. The app passes `safeStorage`; tests pass a fake. */
export interface SecretStore {
  isEncryptionAvailable(): boolean;
  /** Electron Linux reports `basic_text` when it falls back to a hardcoded password. */
  getSelectedStorageBackend?(): string;
  encryptString(plain: string): Buffer;
  decryptString(encrypted: Buffer): string;
  /** Linux only in Electron */
  getSelectedStorageBackend?(): string;
}

export interface UserFacingError { code: string; userMessage: string; link?: string; retryable?: boolean }

/** Error with a grandma-friendly message. `link` is shown as a button when present. */
export class AIError extends Error implements UserFacingError {
  constructor(
    public readonly code: string,
    public readonly userMessage: string,
    opts: { detail?: string; link?: string; retryable?: boolean; status?: number; requestId?: string; resetsAt?: string; limits?: LimitWindow[] } = {},
  ) {
    super(opts.detail ?? userMessage);
    this.name = 'AIError';
    this.link = opts.link;
    this.retryable = opts.retryable ?? false;
    this.status = opts.status;
    this.requestId = opts.requestId;
    this.resetsAt = opts.resetsAt;
    this.limits = opts.limits;
  }
  link?: string;
  retryable: boolean;
  status?: number;
  requestId?: string;
  /** A plan at its limit: when it resets (ISO), when the service said. */
  resetsAt?: string;
  /** the plan's windows when it said them (Claude Code does, as it refuses) */
  limits?: LimitWindow[];
  toJSON(): UserFacingError & { status?: number; requestId?: string; resetsAt?: string; limits?: LimitWindow[] } {
    return { code: this.code, userMessage: this.userMessage, link: this.link, retryable: this.retryable, status: this.status, requestId: this.requestId, ...(this.resetsAt ? { resetsAt: this.resetsAt } : {}), ...(this.limits ? { limits: this.limits } : {}) };
  }
}

/** One usage window of a plan or account: what is left of it and when it starts over. */
export interface LimitWindow {
  /** "5-hour", "Weekly", "Monthly", or a model's own weekly window ("Weekly · Opus") */
  label: string;
  /** percent left, 0-100 */
  left: number;
  resetsAt?: string;
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
  /** What the provider learns while it waits, from a provider that reports it (ModelProvider.reportsWaits). */
  onWait?: (w: WaitSignal) => void;
}
/** `retrying`: the service refused or did not answer and the CLI tries again after `delayMs`; `thinking`: the model is
 * reasoning before it answers (its thinking block started); `answering`: the answer itself has started to arrive. */
export type WaitSignal =
  | { kind: 'retrying'; attempt: number; max: number; delayMs: number; status: number | null }
  | { kind: 'thinking' }
  | { kind: 'answering' };
export interface TokenUsage { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }

/** A value the provider's answer did not carry. Kept apart from 0 so a missing count never reads as "none used". */
export const NOT_REPORTED = 'not reported' as const;
export type Reported<T> = T | typeof NOT_REPORTED;

/** What one model call ran on and used, as the provider's own answer reported it (providers/cli.ts for the CLIs,
 * anthropic.ts and openaiCompatible.ts for an API key, the person's own server and the hub). Measurement only: the
 * token budget still reads `usage`. */
export interface CallProvenance {
  provider: ProviderId;
  /** the model the app passed to the CLI; null = none passed, so the CLI used its own default */
  requestedModel: string | null;
  /** model ids from the provider's answer for this call, never copied from the request */
  reportedModels: Reported<string[]>;
  /** "not reported" over an HTTP API, where no CLI runs */
  cliVersion: Reported<string>;
  /** the effort the app passed (Claude Code's --effort, Codex's model_reasoning_effort, a hub model's level); null =
   * none passed, so the provider's default. No provider reports the effort it used. */
  effort: string | null;
  /** input = input tokens neither read from nor written to the prompt cache, as Anthropic counts it */
  usage: { input: Reported<number>; output: Reported<number>; cacheRead: Reported<number>; cacheWrite: Reported<number> };
}

export interface CompletionResponse {
  text: string; toolCalls: ToolCall[]; raw?: unknown; usage?: TokenUsage;
  provenance?: CallProvenance;
  /** the reply meant to call tools but could not be read (the loop re-asks with a format correction) */
  malformed?: boolean;
  /** the calls were read from a non-protocol format (XML-style) */
  repaired?: 'xml';
  /** where the turn's time went, from a provider that reports its waits: ms from sending to the first thinking and the
   * first answer, to the whole reply, and how many times the service was retried */
  timing?: { thinkingMs: number | null; answerMs: number | null; totalMs: number; retries: number };
  /** the plan's usage windows, from a provider that reports them with each answer (Claude Code) */
  limits?: LimitWindow[];
}

export interface ModelProvider {
  readonly id: ProviderId | 'fake';
  readonly model?: string;
  readonly supportsImages: boolean;
  /** Calls req.onWait: so silence before the answer starts means waiting, not working. */
  readonly reportsWaits?: boolean;
  complete(req: CompletionRequest): Promise<CompletionResponse>;
  /** Release anything kept between turns (a live CLI session). Called when an agent run ends; the run
   * ends only once the returned promise settles (its processes have exited). */
  dispose?(): void | Promise<void>;
}
