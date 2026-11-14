// @reelstudio/ai: providers, prompts, tools and the editor agent loop (docs/architecture.md sections 6 and 8).
import { StockSearch, StockProvider } from './stock';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  AgentEvent, AgentResult, AIError, EngineHost, ModelProvider, Part, PlanTurnInput, PlanTurnResult, ProviderId, ProviderStatus, ScriptResult, SecretStore, UserFacingError,
} from './types';
import { Prompts, defaultPromptsDir } from './prompts';
import { StyleStore, StyleProposal, StyleRule, type ProposalDraft } from './style';
import { learn } from './learning';
import type { RuleCheck } from './rules';
import { loadProject, versionDir, writeFileAtomic } from './project';
import { differingLayers, type MergeLayer } from './version-merge';
import { planFastNote } from './fastnote';
import { AnthropicProvider, DEFAULT_CLAUDE_MODEL, SMALL_CLAUDE_MODEL } from './providers/anthropic';
import { ClaudeCliProvider, CodexCliProvider, extractJson } from './providers/cli';
import { ReplayProvider } from './providers/replay';
import { CONNECTION_KINDS, ConnectionKind, listConnectionModels, noRedirectFetch, normalizeBaseURL, suggestedModel } from './providers/connection';
import { OpenAICompatibleProvider } from './providers/openaiCompatible';
import { hubAccounts, hubImages, hubModels, hubProvider, loopbackOrigin, splitModel, familyOf, type HubAccount, type HubModel } from './providers/hub';
import { nameFromId, untilWords } from './providers/limits';
import { readCodexAccount } from './providers/codexAccount';
import { ClaudeCodeHarness } from './mcp/claudeCode';
import { CodexHarness } from './mcp/codex';
import { SessionHarness } from './mcp/session';
import type { Harness } from './harness';
import type { Helper } from './helpers';
import { detectLocalClaude, DetectOptions, LocalClaude } from './providers/localClaude';
import { detectCodex, CodexDetectOptions, LocalCodex } from './providers/localCodex';
import * as editor from './editor';
import { nicheTurn, NicheTurnInput, NicheTurnResult } from './niche';
import { proposeTry, type TryProposal, type TryRequest } from './trial';
import { proposeReels, type ProposeReelsRequest, type ReelProposal } from './propose';
import { proposeFromArchive, type ArchiveProposal, type ArchiveRequest } from './propose-archive';
import { assertOwner, claimProject } from './owner';

export * from './types';
export { StockSearch } from './stock';
export type { StockProvider, StockKind, StockResult } from './stock';
export * from './project';
export * from './version-merge';
export { refuseIfOpen, assertOwner, OWNER_LOCK } from './owner';
export { TOOLS, TOOL_NAMES, toolSchemas, executeTool, newToolState } from './tools';
export { CUT_STYLES } from './cut-style';
export type { CutPreset } from './cut-style';
export type { ToolContext, ToolDef } from './tools';
export { runAgent } from './agent';
export { loopHarness } from './harness';
export type { Harness, HarnessRun } from './harness';
export type { NoteSteer } from './steer';
export { ClaudeCodeHarness } from './mcp/claudeCode';
export { CodexHarness } from './mcp/codex';
export { SessionHarness } from './mcp/session';
export { Prompts } from './prompts';
export { StyleStore } from './style';
export type { RuleCheck, StyleCheckProposal } from './rules';
export type { MemoryKind, MemoryProposal, ProposalDraft, ProposalStatus, TrialLink } from './style';
export { learn, MIN_LEARNING_REACH } from './learning';
export { AnthropicProvider, DEFAULT_CLAUDE_MODEL } from './providers/anthropic';
export { ClaudeCliProvider, CodexCliProvider } from './providers/cli';
export { ReplayProvider, RecordingProvider } from './providers/replay';
export { OpenAICompatibleProvider } from './providers/openaiCompatible';
export type { ConnectionKind } from './providers/connection';
export { hubModels, hubAccounts, splitModel, joinModel, familyOf, EFFORTS } from './providers/hub';
export type { HubModel, HubAccount, Effort, ModelFamily } from './providers/hub';
export { resetWords } from './providers/limits';
export { detectLocalClaude, findClaude, claudeCandidates, claudeFromLoginShell, CLAUDE_CODE_MESSAGES } from './providers/localClaude';
export type { LocalClaude, ClaudeCodeState } from './providers/localClaude';
export { classifyCodexLoginStatus, detectCodex, findCodex, codexCandidates, codexFromLoginShell, CODEX_MESSAGES } from './providers/localCodex';
export type { CodexLoginStatus, LocalCodex, CodexState } from './providers/localCodex';
export { cliEnv } from './safety';
export { pickTakes, formatForPicking, deterministicEdit } from './editor';
export type { ApplyNoteOptions } from './editor';
export type { Niche, NicheTurn, NicheTurnInput, NicheTurnResult } from './niche';
export { checkTryProposal, TRY_VARIABLES } from './trial';
export type { TryProposal, TryRequest, TryVariable } from './trial';
export { checkReelProposal, proposeReels } from './propose';
export type { ProposeReelsRequest, ReelCandidate, ReelProposal } from './propose';
export { checkArchiveProposal, formatArchive, proposeFromArchive, FILES_PER_REEL } from './propose-archive';
export type { ArchiveCandidate, ArchiveFile, ArchiveLine, ArchiveProposal, ArchiveRequest, ArchiveSpan } from './propose-archive';
export { ATTACHMENT_REF, MAX_ATTACHMENTS_PER_NOTE, readAttachment, listAttachments, validateAttachments, placedAssets } from './attachments';
export type { AttachmentInfo } from './attachments';

/**
 * Every stage of the work that calls a model, each with its own model choice (Settings › Editor). `editor` makes
 * Version 1 and the notes' changes; `checker` reviews an edit and proofreads Version 1's subtitles; `writer` writes
 * scripts; `planner` is the planning chat; `finder` finds more reels in a video; `trial` picks Try 2's one change;
 * `namer` rewords a version's title.
 */
export const MODEL_ROLES = ['editor', 'checker', 'writer', 'planner', 'finder', 'trial', 'namer'] as const;
export type ModelRole = (typeof MODEL_ROLES)[number];
/** A model per role, optionally with a reasoning level (`claude-opus-5-5(high)`); missing or 'auto' leaves it to the
 * editor's own default. */
export type RoleModels = Partial<Record<ModelRole, string>>;
/** Claude Code's model names, as `claude --help` lists them for `--model` (2.1.311). */
export const CLAUDE_CODE_MODELS = ['fable', 'opus', 'sonnet', 'haiku'];
/** `claude --help` 2.1.311: --effort takes these. */
const CLAUDE_CODE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export const ROLE_NAMES: Record<ModelRole, string> = {
  editor: 'Edits', checker: 'Checks each edit', writer: 'Writes scripts', planner: 'Plans reels', finder: 'Finds more reels', trial: 'Picks Try 2', namer: 'Names versions',
};

/**
 * The model `role` asks the active editor for, as stored (it may carry a reasoning level). Claude Code, the Codex app
 * and your own server take a model name; a Claude key picks its own, so a choice does not apply to it. A name the
 * editor cannot run (left from another editor) is Auto, as the stage's chip shows it: never an error mid-edit.
 */
export function modelForRole(provider: ProviderId, role: ModelRole, choices: RoleModels): string | undefined {
  const m = choices[role];
  if (!m || m === 'auto') return undefined;
  const { model } = splitModel(m);
  if (provider === 'claude-cli') return CLAUDE_CODE_MODELS.includes(model) || /^claude-[\w.-]+$/.test(model) ? m : undefined;
  if (provider === 'codex-cli') return familyOf(model) === 'gpt' ? m : undefined;
  return provider === 'custom' ? m : undefined;
}

export interface AISettings {
  active?: ProviderId;
  claudeModel?: string;
  cliModel?: string;
  /** the model for "ChatGPT (your Codex app)"; unset = the Codex app's own default for the person's plan */
  codexModel?: string;
  replayFixture?: string;
  /** each connection's key is its own encrypted file, never in here */
  connections?: CustomConnection[];
  activeConnection?: string;
  /** Settings › Editor › How notes run: the person's own Claude Code or Codex app runs each note with Reel Studio's
   * tools over MCP, when it is also the editor in use (noteHarness). Unset: Reel Studio's own loop. "Double-check each
   * edit" is the app's setting (#73), passed with each note. */
  harness?: 'claude-code' | 'codex';
  /** set when the old in-app "Sign in with ChatGPT" was signed out on upgrade; cleared once the Codex app is chosen */
  chatgptMoved?: boolean;
}

/** Settings › Editor › How notes run. `app`: the editor in use's own app, offered only while it is the active editor and
 * installed and signed in; null hides the choice. `fellBack`: this session's self-test failed, so its notes ran on Reel
 * Studio's editor instead (SessionHarness). */
export interface NoteRunnerInfo {
  runner: 'reelstudio' | 'app';
  app: 'claude-code' | 'codex' | null;
  fellBack?: { app: 'claude-code' | 'codex'; reason: string; at: string };
}

export interface CustomConnection {
  /** 'cliproxy': CLIProxyAPI on this computer, found by the app. `baseURL` is its origin, and each model goes to the
   * endpoint for its family (providers/hub.ts). */
  id: string; label: string; kind: ConnectionKind | 'cliproxy'; baseURL: string; model: string;
  /** set by the picture sent with the check on save; the person can change it */
  supportsImages: boolean;
  /** where the key came from, said in the editor's row: a config file's path, or "typed" */
  keySource?: string;
}
export interface ConnectionInfo extends CustomConnection { hasKey: boolean; active: boolean; hasManagementKey?: boolean }
/** A model the editor in use offers, for the stage picker. */
export type EditorModel = HubModel;
/** The accounts behind the editor in use, their plans and what each has left. */
export interface EditorAccounts {
  accounts: { name: string; provider: string; plan?: string; windows: import('./types').LimitWindow[]; restingUntil?: string; problem?: string }[];
  /** CLIProxyAPI without its management key: accounts need it */
  needsManagementKey?: boolean;
  /** the accounts could not be read; in plain words */
  problem?: string;
}
export interface TestResult { provider: ProviderId | 'fake'; model?: string; reply: string; ms: number; limits?: import('./types').LimitWindow[]; /** a stage that fell back to Auto, and why */ note?: string }
export interface ConnectionInput {
  id?: string;
  label: string; kind: ConnectionKind; baseURL: string; model: string;
  /** empty keeps the stored key when editing */
  key?: string;
}
export interface ConnectionModels { models: string[]; suggested: string | null; needsKey: boolean }
export type ConnectionField = 'label' | 'address' | 'key' | 'model';
export interface SaveConnectionResult {
  status: ProviderStatus;
  connection?: ConnectionInfo;
  error?: UserFacingError & { field?: ConnectionField };
}

const CONNECTION_ID = /^c_[a-f0-9]{8}$/;
function sameOrigin(a: string, b: string): boolean {
  try { return new URL(a).origin === new URL(b).origin; } catch { return false; }
}
const CHECK_TIMEOUT_MS = 30_000;
const PIXEL_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const WEAK_STORE_MESSAGE = 'This computer has no password store Reel Studio can use (such as GNOME Keyring or KWallet), so other apps could read the key. It was not saved. Turn on your password store, then try again.';
const FIELD_OF: Record<string, ConnectionField> = {
  connection_bad_address: 'address', connection_unreachable: 'address', connection_wrong_address: 'address', connection_timeout: 'address',
  connection_bad_key: 'key', no_secure_storage: 'key', connection_model: 'model',
};

export interface CreateAIOptions {
  host: EngineHost;
  settingsDir: string;
  dev?: boolean;
  /** test hook: how the person's own Claude Code app (`claude`) is found and run for detection */
  localClaude?: DetectOptions;
  /** test hook: how the person's own Codex app (`codex`) is found and run for detection */
  localCodex?: CodexDetectOptions;
  /** The Codex app the app fetched for its guided "Sign in with ChatGPT" (app main/easy-ai.ts), or null. Detection
   * uses it only when the person has no Codex app of their own. */
  managedCodex?: () => string | null;
  /** The environment the person's own CLIs get (detection and edits). The app's test switch points it at a throwaway
   * config folder. ANTHROPIC_* and OPENAI_* are always removed. Default: process.env. */
  cliEnv?: () => NodeJS.ProcessEnv;
  /** Electron `safeStorage` (or compatible). Without it (or when it cannot encrypt) secrets are NOT
   * saved, unless allowPlaintextSecrets is set. */
  secretStore?: SecretStore;
  /** Dev CLI only (`--insecure-plaintext`): keep secrets in plain files when no keychain exists. */
  allowPlaintextSecrets?: boolean;
  /** cumulative token brake per edit (default DEFAULT_TOKEN_BUDGET) */
  tokenBudget?: number;
  /** test hook: DNS lookup for the private-host check */
  lookup?: import('./safety').LookupFn;
  promptsDir?: string;
  /** test hooks */
  fetch?: typeof fetch;
  anthropicBaseURL?: string;
  /** Force a specific model provider (tests). */
  /** Tests: the model every role uses, or one per role. */
  providerOverride?: ModelProvider | ((role: ModelRole) => ModelProvider);
  /** The person's model per role (the app's Settings › Editor › Models), read at the start of each job. */
  roleModels?: () => RoleModels | Promise<RoleModels>;
  /** Force the harness a note runs in (tests, the dev CLI). */
  harnessOverride?: Harness;
  checkerHarnessOverride?: Harness;
  finalRender?: boolean;
  maxSteps?: number;
  /** draw stills of what each reply of the AI changed, then the 2 s around them, then the draft, while it works
   * (moments.ts); each arrives as a `moment` event. The app turns it on. */
  moments?: boolean;
}

// claude-cli = the person's own Claude Code app, offered to everyone. It is never called "Claude Code" on its own:
// Reel Studio is not Claude Code, it uses the Claude Code app the person signed in to themselves.
export const CLAUDE_CODE_LABEL = 'Claude (your Claude Code app)';
// codex-cli = the person's own Codex app (OpenAI's `codex` CLI), signed in with their ChatGPT plan.
export const CODEX_LABEL = 'ChatGPT (your Codex app)';
const LABELS: Record<ProviderId, string> = {
  claude: 'Claude', 'codex-cli': CODEX_LABEL, 'claude-cli': CLAUDE_CODE_LABEL, custom: 'Your own server', replay: 'Replay (dev)', none: 'No AI',
};
// ChatGPT goes through the person's own Codex app. (The old in-app "Sign in with ChatGPT" is gone; see
// retireSignInWithChatGPT for what is left of it on disk after an upgrade.)
const PEOPLE_PROVIDERS: ProviderId[] = ['claude', 'claude-cli', 'codex-cli', 'custom', 'none'];

const LOCAL_CLAUDE_TTL_MS = 60_000;
/** Claude Code's `subscriptionType` as a plan name, with "Claude" dropped: "max" → "Max". */
const CLAUDE_PLAN_NAMES: Record<string, string> = { max: 'Max', max5x: 'Max 5x', max20x: 'Max 20x', pro: 'Pro', team: 'Team', enterprise: 'Enterprise', free: 'Free' };
const claudePlanName = (p: string | undefined): string | undefined => (p ? CLAUDE_PLAN_NAMES[p.toLowerCase().replace(/^claude|subscription$/g, '')] : undefined);
/** Claude Code's model names as the picker shows them, each with the levels its --effort takes. */
const CLAUDE_CODE_PICKS: HubModel[] = CLAUDE_CODE_MODELS.map((m) => ({ id: m, name: `Claude ${m[0].toUpperCase()}${m.slice(1)}`, family: 'claude', efforts: m === 'haiku' ? [] : [...CLAUDE_CODE_EFFORTS], images: true }));
/** Files the retired "Sign in with ChatGPT" (0.1.2 and earlier) kept in the settings folder. */
const RETIRED_CHATGPT_SESSION = ['chatgpt-credentials.bin', 'chatgpt-credentials.json'];
const RETIRED_CHATGPT_REGISTRATION = ['chatgpt-account.json', 'chatgpt-host.json'];

export function createAI(opts: CreateAIOptions) {
  let checking: AbortController | null = null;
  let localCache: { at: number; v: LocalClaude } | null = null;
  async function localClaude(fresh = false): Promise<LocalClaude> {
    if (!fresh && localCache && Date.now() - localCache.at < LOCAL_CLAUDE_TTL_MS) return localCache.v;
    const v = await detectLocalClaude({ env: env(), ...(opts.localClaude ?? {}) });
    localCache = { at: Date.now(), v };
    return v;
  }
  const env = (): NodeJS.ProcessEnv => opts.cliEnv?.() ?? process.env;
  let codexCache: { at: number; v: LocalCodex } | null = null;
  let codexPlan: { bin: string; at: number; plan?: string } | null = null;
  /** Claude Code's windows as its last answer or refusal reported them (it says them only then) */
  let claudeWindows: { at: number; v: import('./types').LimitWindow[] } | null = null;
  async function localCodex(fresh = false): Promise<LocalCodex> {
    if (!fresh && codexCache && Date.now() - codexCache.at < LOCAL_CLAUDE_TTL_MS) return codexCache.v;
    const managed = opts.managedCodex?.() ?? null;
    const v = await detectCodex({ env: env(), ...(managed ? { fallbackBin: managed } : {}), ...(opts.localCodex ?? {}) });
    codexCache = { at: Date.now(), v };
    return v;
  }
  const settingsFile = path.join(opts.settingsDir, 'ai-settings.json');
  const prompts = new Prompts(opts.promptsDir ?? defaultPromptsDir());
  const style = new StyleStore(() => opts.host.reelStudioRoot());
  // One edit at a time per project (the app may double-click; the CLI may race). `owner`: the token of
  // the app job that has the project (owner.ts), which must still be the lock's; without one (the dev CLI)
  // the edit claims the project for itself and runs with its own token. `fn` gets the token the edit runs with.
  const locks = new Map<string, Promise<unknown>>();
  function exclusive<T>(dir: string, owner: string | undefined, fn: (owner: string) => Promise<T>): Promise<T> {
    const key = path.resolve(dir).toLowerCase();
    const prev = locks.get(key) ?? Promise.resolve();
    // in-process queue, plus a lock FILE every edit holds for its whole run, so two edits in different
    // processes (the app and the dev CLI, or two dev CLIs) never run on one project at once
    const run = prev.catch(() => undefined).then(async () => {
      if (owner) {
        assertOwner(dir, owner);
        return withEditLock(dir, () => fn(owner));
      }
      const claim = await claimProject(dir);
      // part of an engine that would not stop may still write: the project stays claimed
      let stuck = false;
      try {
        return await withEditLock(dir, () => fn(claim.token));
      } catch (e: any) {
        stuck = e?.code === 'ENGINE_STUCK';
        throw e;
      } finally {
        if (!stuck) await claim.release().catch(() => undefined);
      }
    });
    // The lock's copy of the run must never reject on its own: the caller gets `run` and handles
    // its error; an unobserved rejected `finally` copy is an unhandled rejection in Node.
    const tail: Promise<unknown> = run.finally(() => { if (locks.get(key) === tail) locks.delete(key); })
      .catch(() => undefined);
    locks.set(key, tail);
    return run;
  }
  const stockSearch = new StockSearch({ settingsDir: opts.settingsDir, key: stockKey, fetchImpl: opts.fetch });
  const deps = (host: EngineHost, owner?: string, stuck?: () => unknown): editor.EditorDeps => ({ host, owner, stuck, prompts, style, stockSearch, fetchImpl: opts.fetch, finalRender: opts.finalRender, maxSteps: opts.maxSteps, tokenBudget: opts.tokenBudget, lookup: opts.lookup, moments: opts.moments });
  function edit<T>(owner: string | undefined, run: (d: editor.EditorDeps) => Promise<T>): Promise<T> {
    const engine = editHost(opts.host, owner);
    return engine.settle(run(deps(engine.host, owner, engine.stuck)));
  }

  async function settings(): Promise<AISettings> {
    try { return JSON.parse(await fsp.readFile(settingsFile, 'utf8')); } catch { return {}; }
  }
  async function saveSettings(patch: Partial<AISettings>): Promise<void> {
    await writeFileAtomic(settingsFile, JSON.stringify({ ...(await settings()), ...patch }, null, 2));
  }

  // ---- secrets: <name>.bin encrypted with the secret store; <name>.txt only for the dev CLI's --insecure-plaintext
  const secretFiles = (name: string) => ({ enc: path.join(opts.settingsDir, `${name}.bin`), plain: path.join(opts.settingsDir, `${name}.txt`) });
  async function readSecret(name: string): Promise<string | null> {
    const f = secretFiles(name);
    try {
      if (fs.existsSync(f.enc) && opts.secretStore) return opts.secretStore.decryptString(await fsp.readFile(f.enc));
      if (opts.allowPlaintextSecrets && fs.existsSync(f.plain)) return (await fsp.readFile(f.plain, 'utf8')).trim() || null;
    } catch { /* unreadable */ }
    return null;
  }
  const hasSecret = (name: string) => { const f = secretFiles(name); return fs.existsSync(f.enc) || (!!opts.allowPlaintextSecrets && fs.existsSync(f.plain)); };
  /** Replaces the secret. The old one stays until the new one is written, so a failed replacement keeps it. */
  async function writeSecret(name: string, value: string | null, noStorageMessage: string): Promise<void> {
    const f = secretFiles(name);
    if (!value) { await fsp.rm(f.enc, { force: true }); await fsp.rm(f.plain, { force: true }); return; }
    // Linux without a keyring: Electron's 'basic_text' encrypts with a password built into Chromium, which protects nothing
    const weak = opts.secretStore?.getSelectedStorageBackend?.() === 'basic_text';
    if (opts.secretStore?.isEncryptionAvailable() && !weak) {
      await writeFileAtomic(f.enc, opts.secretStore.encryptString(value), 0o600);
      await fsp.rm(f.plain, { force: true });
    } else if (opts.allowPlaintextSecrets) {
      await writeFileAtomic(f.plain, value, 0o600);
      await fsp.rm(f.enc, { force: true });
    } else throw new AIError('no_secure_storage', weak ? WEAK_STORE_MESSAGE : noStorageMessage);
  }

  /** `text` with every key this app keeps replaced: the Claude key, and each connection's key and management key. */
  async function scrubSecrets(text: string): Promise<string> {
    const s = await settings();
    const names = ['claude-key', ...(s.connections ?? []).flatMap((c) => [connectionSecret(c.id), `${connectionSecret(c.id)}-management`])];
    let out = text;
    for (const n of names) {
      const v = await readSecret(n);
      if (v && v.length >= 4) out = out.split(v).join('[key]');
    }
    return out;
  }

  // ---- Claude key (secret)
  const claudeKey = () => readSecret('claude-key');
  const storeClaudeKey = (key: string | null) => writeSecret('claude-key', key, 'This computer has no safe place to keep your Claude key, so it was not saved. Add it from the Reel Studio app.');

  // ---- your own AI server ('custom')
  const connectionSecret = (id: string) => {
    if (!CONNECTION_ID.test(id)) throw new AIError('connection_gone', 'That connection is no longer saved.');
    return `connection-${id}`;
  };
  const managementSecret = (id: string) => `${connectionSecret(id)}-management`;
  /** A saved CLIProxyAPI connection that is not a loopback address (a hand-edited settings file, or one saved before
   * the check): never used, and neither of its keys is ever sent. */
  const notLocal = (c: CustomConnection): boolean => c.kind === 'cliproxy' && !loopbackOrigin(c.baseURL);
  const NOT_LOCAL = 'The saved CLIProxyAPI is not on this computer, so Reel Studio won’t send it a key. Connect the one on this computer again, or add a server elsewhere under Advanced.';
  /** Hub keys are at least this long, so every one can be found and taken out of what the app shows and logs. */
  const MIN_HUB_KEY = 8;
  const connectionInfo = (c: CustomConnection, s: AISettings): ConnectionInfo => ({
    id: c.id, label: c.label, kind: c.kind, baseURL: c.baseURL, model: c.model, supportsImages: c.supportsImages,
    hasKey: hasSecret(connectionSecret(c.id)), active: s.active === 'custom' && activeConnection(s)?.id === c.id,
    ...(c.keySource ? { keySource: c.keySource } : {}),
    ...(c.kind === 'cliproxy' ? { hasManagementKey: hasSecret(managementSecret(c.id)) } : {}),
  });
  // Connection changes run one at a time: a save that is still checking must not undo a later edit (and leave a
  // key bound to the wrong address).
  let connectionQueue: Promise<unknown> = Promise.resolve();
  function oneAtATime<T>(fn: () => Promise<T>): Promise<T> {
    const run = connectionQueue.then(fn, fn);
    connectionQueue = run.catch(() => undefined);
    return run;
  }
  function activeConnection(s: AISettings): CustomConnection | undefined {
    const list = s.connections ?? [];
    return list.find((c) => c.id === s.activeConnection) ?? list[0];
  }
  /** `models`: the hub's list, which says whether the chosen model takes pictures (none when unknown). */
  function connectionProvider(c: CustomConnection, key: string | null, check = false, models: HubModel[] | null = null): ModelProvider {
    if (c.kind === 'cliproxy') {
      const p = hubProvider({ origin: c.baseURL, key: key ?? '', choice: c.model, supportsImages: hubImages(models, c.model), fetch: opts.fetch, check });
      return check ? p : withAlternative(p, c);
    }
    if (c.kind === 'anthropic') {
      return new AnthropicProvider({
        id: 'custom', apiKey: key!, model: c.model, baseURL: c.baseURL, fetch: noRedirectFetch(opts.fetch), supportsImages: c.supportsImages,
        ...(check ? { maxRetries: 0, timeoutMs: CHECK_TIMEOUT_MS, maxTokens: 64 } : {}),
      });
    }
    return new OpenAICompatibleProvider({ baseURL: c.baseURL, apiKey: key, model: c.model, fetch: opts.fetch, supportsImages: c.supportsImages, ...(check ? { timeoutMs: CHECK_TIMEOUT_MS } : {}) });
  }
  // The hub's model list, kept a minute: the stage picker, and the other model a limit error offers.
  let hubCache: { key: string; at: number; v: HubModel[] } | null = null;
  async function hubList(c: CustomConnection, key: string | null): Promise<HubModel[]> {
    const k = `${c.baseURL}|${c.id}`;
    if (hubCache && hubCache.key === k && Date.now() - hubCache.at < 60_000) return hubCache.v;
    const v = await hubModels(c.baseURL, key, { fetch: opts.fetch });
    hubCache = { key: k, at: Date.now(), v };
    return v;
  }
  /**
   * A limit on the hub suggests another model: the first of another family (Claude ↔ ChatGPT) in the hub's list as it
   * is now. With the management key saved, a family whose every account has a window at nothing left is not offered.
   */
  function withAlternative(p: ModelProvider, c: CustomConnection): ModelProvider {
    const complete = p.complete.bind(p);
    return Object.assign(Object.create(Object.getPrototypeOf(p)), p, {
      complete: async (req: Parameters<ModelProvider['complete']>[0]) => {
        try { return await complete(req); } catch (e) {
          if (!(e instanceof AIError) || e.code !== 'connection_limited') throw e;
          const model = splitModel(p.model ?? c.model).model;
          const other = await alternativeModel(c, familyOf(model));
          const said = `${await hubLimitWords(c, model, e)}${other ? ` ${alternativeWords(other)}` : ''}`;
          throw new AIError(e.code, said, { detail: e.message, retryable: e.retryable, status: e.status, resetsAt: e.resetsAt });
        }
      },
    }) as ModelProvider;
  }
  /**
   * A limit on the hub in the bars' own terms: which accounts are at which limit until when, by name, and the model's
   * display name. When an account of that family still has room the words say so instead of "all at their limit".
   * Without the management key the accounts are unknown, and the words say what the hub said.
   */
  async function hubLimitWords(c: CustomConnection, model: string, e: AIError): Promise<string> {
    const key = await readSecret(connectionSecret(c.id));
    const models = await hubModels(c.baseURL, key, { fetch: opts.fetch }).catch(() => null);
    const name = models?.find((m) => m.id === model)?.name ?? nameFromId(model);
    const fam = familyOf(model);
    const mk = await readSecret(managementSecret(c.id));
    const accounts = mk ? await hubAccounts(c.baseURL, mk, { fetch: opts.fetch }).catch(() => null) : null;
    const mine = (accounts ?? []).filter((a) => a.provider === (fam === 'claude' ? 'claude' : 'codex') && a.windows.length);
    if (!mine.length) {
      return `CLIProxyAPI says ${name}’s accounts are all resting${e.resetsAt ? ` until ${untilWords(e.resetsAt)}` : ''}. Add its management key in Settings, under Editor, to see which accounts.`;
    }
    const out = mine.filter((a) => a.windows.some((w) => w.left === 0));
    const room = mine.filter((a) => !a.windows.some((w) => w.left === 0));
    const atLimit = out.map((a) => {
      const w = a.windows.filter((x) => x.left === 0).sort((x, y) => (y.resetsAt ?? '').localeCompare(x.resetsAt ?? ''))[0];
      return `${a.name} is at its ${w.label.toLowerCase()} limit${w.resetsAt ? ` until ${untilWords(w.resetsAt)}` : ''}`;
    });
    if (room.length) return `${atLimit.length ? `${atLimit.join('; ')}; ` : ''}${name} can still use ${room.map((a) => a.name).join(', ')}. Try again in a minute.`;
    return `Every ${fam === 'claude' ? 'Claude' : 'ChatGPT'} account is at a limit: ${atLimit.join('; ')}.`;
  }
  async function alternativeModel(c: CustomConnection, family: string): Promise<(HubModel & { roomSeen: boolean }) | undefined> {
    const key = await readSecret(connectionSecret(c.id));
    const now = await hubModels(c.baseURL, key, { fetch: opts.fetch }).catch(() => null);
    if (!now) return undefined;
    const spent = new Set<string>();
    const mk = await readSecret(managementSecret(c.id));
    let accountsRead: HubAccount[] = [];
    if (mk) {
      const accounts = await hubAccounts(c.baseURL, mk, { fetch: opts.fetch }).catch(() => [] as HubAccount[]);
      accountsRead = accounts;
      for (const [fam, provider] of [['claude', 'claude'], ['gpt', 'codex']] as const) {
        const mine = accounts.filter((a) => a.provider === provider && a.windows.length);
        if (mine.length && mine.every((a) => a.windows.some((w) => w.left === 0))) spent.add(fam);
      }
    }
    const m = now.find((x) => x.family !== family && (x.family === 'claude' || x.family === 'gpt') && !spent.has(x.family));
    if (!m) return undefined;
    // room is claimed only when the accounts were read and that family has some
    const prov = m.family === 'claude' ? 'claude' : 'codex';
    const roomSeen = !!mk && accountsRead.some((a) => a.provider === prov && a.windows.length && !a.windows.some((w) => w.left === 0));
    return { ...m, roomSeen };
  }
  const alternativeWords = (m: HubModel & { roomSeen?: boolean }): string => {
    const fam = m.family === 'claude' ? 'Claude' : 'ChatGPT';
    return m.roomSeen
      ? `Your ${fam} accounts have room: you could try ${m.name}. Choose it in Settings, under Editor.`
      : `If your ${fam} accounts have room, you could try ${m.name}. Choose it in Settings, under Editor.`;
  };

  /** Throws the plain-words AIError when the server does not answer; returns whether it took a picture. A cut-off
   * reply (connection_truncated) counts as an answer. So does busy or out of quota (connection_busy), which proves
   * the address, key and model are real; the picture is then not tried and counts as refused. */
  async function checkConnection(c: CustomConnection, key: string | null): Promise<boolean> {
    const ask = (content: Part[]) => connectionProvider(c, key, true)
      .complete({ system: 'Reply with exactly the word OK.', messages: [{ role: 'user', content }], tools: [], jsonOnly: true })
      .then(() => 'answered' as const, (e) => {
        if (e instanceof AIError && e.code === 'connection_truncated') return 'answered' as const;
        if (e instanceof AIError && (e.code === 'connection_busy' || e.code === 'connection_limited')) return 'busy' as const;
        throw e;
      });
    if ((await ask([{ type: 'text', text: 'Say OK.' }])) === 'busy') return false;
    return (await ask([{ type: 'text', text: 'Say OK.' }, { type: 'image', mime: 'image/png', base64: PIXEL_PNG }]).catch(() => 'refused')) === 'answered';
  }

  const stockKeyFile = (provider: 'pexels' | 'pixabay') => path.join(opts.settingsDir, `${provider}-key.bin`);
  // No key file, no secret store call. On a Mac even isEncryptionAvailable() reads the app's keychain item, and an
  // ad-hoc-signed build (the nightly) is asked to allow that again after every update, with the app blocked until
  // the person answers; opening Settings must not set that off when there is nothing to read.
  const hasStockKey = (provider: 'pexels' | 'pixabay') => fs.existsSync(stockKeyFile(provider)) && protectedSecretStore(opts.secretStore);
  async function stockKey(provider: 'pexels' | 'pixabay'): Promise<string | null> {
    const store = opts.secretStore;
    if (!fs.existsSync(stockKeyFile(provider)) || !protectedSecretStore(store)) return null;
    try { return store.decryptString(await fsp.readFile(stockKeyFile(provider))); }
    catch { return null; }
  }

  function protectedSecretStore(store: SecretStore | undefined): store is SecretStore {
    return !!store && store.isEncryptionAvailable() && store.getSelectedStorageBackend?.() !== 'basic_text';
  }

  async function statusOf(id: ProviderId): Promise<ProviderStatus> {
    const s = await settings();
    switch (id) {
      case 'claude': return { id, connected: !!(await claudeKey()), label: LABELS.claude, detail: s.claudeModel ?? DEFAULT_CLAUDE_MODEL };
      case 'claude-cli': {
        // detail is the plan kind, else the CLI version: never the account (no e-mail, no organization)
        const lc = await localClaude();
        const plan = claudePlanName(lc.plan);
        return {
          id, connected: lc.state === 'ready', label: LABELS['claude-cli'], ...(plan ? { detail: plan } : lc.version ? { detail: lc.version } : {}),
          ...(lc.state === 'ready' ? {} : { error: { code: `claude_code_${lc.state}`, userMessage: lc.reason ?? 'Your Claude Code app is not ready.' } }),
        };
      }
      case 'custom': {
        const c = activeConnection(s);
        if (!c) return { id, connected: false, label: LABELS.custom };
        const base = { id, label: c.label, detail: c.model, connectionId: c.id };
        if (notLocal(c)) return { ...base, connected: false, error: { code: 'hub_not_local', userMessage: NOT_LOCAL } };
        const key = await readSecret(connectionSecret(c.id));
        if (!key && hasSecret(connectionSecret(c.id))) {
          return { ...base, connected: false, error: { code: 'connection_key_unreadable', userMessage: `Reel Studio could not read the saved key for ${c.label}. Edit the connection and paste the key again.` } };
        }
        // an Anthropic-compatible server always needs a key (connectionProvider); an OpenAI-compatible one may not
        return { ...base, connected: c.kind === 'openai' || !!key };
      }
      case 'codex-cli': {
        // detail is the CLI version at most: never the account
        const lc = await localCodex();
        return {
          id, connected: lc.state === 'ready', label: LABELS['codex-cli'], ...(lc.version ? { detail: lc.version } : {}),
          ...(lc.state === 'ready' ? {} : { error: { code: `codex_${lc.state}`, userMessage: lc.reason ?? 'Your Codex app is not ready.' } }),
        };
      }
      case 'replay': {
        const f = s.replayFixture ?? process.env.REELSTUDIO_REPLAY;
        return { id, connected: !!(f && fs.existsSync(f)), label: LABELS.replay, detail: f };
      }
      default: return { id: 'none', connected: true, label: LABELS.none };
    }
  }

  async function providers(): Promise<ProviderStatus[]> {
    // claude-cli is always listed, in its real state (the Connect screen shows how to get it ready)
    const custom: ProviderId[] = (await settings()).connections?.length ? ['custom'] : [];
    const ids: ProviderId[] = ['claude', 'claude-cli', 'codex-cli', ...custom, ...(opts.dev ? (['replay'] as ProviderId[]) : []), 'none'];
    await Promise.all([localClaude(true), localCodex(true)]);
    return Promise.all(ids.map(statusOf));
  }

  async function active(): Promise<ProviderStatus> {
    const s = await settings();
    if (s.active && s.active !== 'none' && (opts.dev || PEOPLE_PROVIDERS.includes(s.active))) {
      const st = await statusOf(s.active);
      if (st.connected) return st;
    }
    if (s.active === 'none') return statusOf('none');
    // Nothing chosen: an Anthropic API key, if one is saved. Never falls back to claude-cli or codex-cli: they spend
    // the person's own plan, so only their click turns them on.
    const claude = await statusOf('claude');
    return claude.connected ? claude : statusOf('none');
  }

  const roleChoices = async (): Promise<RoleModels> => (await opts.roleModels?.()) ?? {};

  /** The active editor, asking for `role`'s model. */
  /** `fell`: where to say that a stage fell back to Auto because its chosen model was gone (the job's own list). */
  async function modelProvider(role: ModelRole = 'editor', fell?: string[]): Promise<ModelProvider | null> {
    if (opts.providerOverride) return typeof opts.providerOverride === 'function' ? opts.providerOverride(role) : opts.providerOverride;
    const st = await active();
    const s = await settings();
    const chosen = modelForRole(st.id, role, await roleChoices());
    switch (st.id) {
      case 'claude': return new AnthropicProvider({ apiKey: (await claudeKey())!, model: s.claudeModel, baseURL: opts.anthropicBaseURL, fetch: opts.fetch });
      case 'claude-cli': {
        const { bin, version } = await localClaude();
        // one live `claude` process per run (providers/cli.ts): ~2.5 s less per model turn
        const make = (m: string | undefined) => new ClaudeCliProvider({ ...claudeCodeChoice(m), session: true, env: env(), ...(bin ? { bin } : {}), ...(version ? { cliVersion: version } : {}) });
        return chosen ? withStageFallback(make(chosen), () => make(s.cliModel), role, chosen, fell) : make(s.cliModel);
      }
      case 'custom':
        // read the address and its key together, never halfway through a save that changes both
        return oneAtATime(async () => {
          const c = activeConnection(await settings());
          if (!c) throw new AIError('no_ai', 'That connection is no longer saved. Pick your editor again in Settings.');
          if (notLocal(c)) throw new AIError('hub_not_local', NOT_LOCAL);
          const key = await readSecret(connectionSecret(c.id));
          if (c.kind !== 'cliproxy') {
            const p = connectionProvider(chosen ? { ...c, model: chosen } : c, key);
            return chosen ? withStageFallback(p, () => connectionProvider(c, key), role, chosen, fell) : p;
          }
          // the hub's list says whether the model takes pictures; a choice it no longer lists is Auto, as its chip says.
          // When the list can't be read the choice is sent, and a "no such model" answer falls back to Auto once.
          const models = await hubList(c, key).catch(() => null);
          const offered = !!chosen && (!models || models.some((m) => m.id === splitModel(chosen).model));
          const p = connectionProvider(offered ? { ...c, model: chosen! } : c, key, false, models);
          return offered && !models ? withStageFallback(p, () => connectionProvider(c, key, false, null), role, chosen!, fell) : p;
        });
      case 'codex-cli': {
        const { bin, version } = await localCodex();
        const make = (m: string | undefined) => new CodexCliProvider({ ...codexChoice(m), env: env(), ...(bin ? { bin } : {}), ...(version ? { cliVersion: version } : {}) });
        return chosen ? withStageFallback(make(chosen), () => make(s.codexModel), role, chosen, fell) : make(s.codexModel);
      }
      case 'replay': return new ReplayProvider((s.replayFixture ?? process.env.REELSTUDIO_REPLAY)!);
      default: return null;
    }
  }
  /**
   * A chosen model that turns out to be gone ("no such model") is never the end of an edit: the call is made once more
   * with the stage's Auto, and `fell` gets one line saying which stage fell back and why.
   */
  function withStageFallback(first: ModelProvider, auto: () => ModelProvider, role: ModelRole, chosen: string, fell?: string[]): ModelProvider {
    let using = first;
    let fellBack = false;
    const gone = (e: unknown): boolean => e instanceof AIError && (e.code === 'connection_model'
      || (/^cli_/.test(e.code) && /model/i.test(e.message) && /(not[ _-]?found|does not exist|invalid|unknown|not available|isn.t available|not supported)/i.test(e.message)));
    return {
      id: first.id,
      get model() { return using.model; },
      get supportsImages() { return using.supportsImages; },
      get reportsWaits() { return using.reportsWaits; },
      async complete(req) {
        try { return await using.complete(req); } catch (e) {
          if (fellBack || !gone(e)) throw e;
          fellBack = true;
          await using.dispose?.();
          using = auto();
          fell?.push(`${ROLE_NAMES[role]} used ${using.model ? nameFromId(splitModel(using.model).model) : 'your editor’s default'}, because ${nameFromId(splitModel(chosen).model)} isn’t offered any more.`);
          return using.complete(req);
        }
      },
      dispose: () => using.dispose?.(),
    };
  }
  /** The model a version was made with, named as the notes say it: the hub's own name, Claude Code's alias, or a
   * name made from the id, with the reasoning level when one was chosen. */
  async function madeWith(p: ModelProvider | null): Promise<{ model?: string }> {
    if (!p) return {};
    const st = await active();
    const effortName: Record<string, string> = { minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max', ultra: 'Ultra' };
    // the stored choice carries the reasoning level; Claude Code's provider holds its level apart from the model
    const choice = modelForRole(st.id, 'editor', await roleChoices());
    const { model, effort } = splitModel(choice ?? p.model ?? (p instanceof ClaudeCliProvider ? 'sonnet' : ''));
    let name: string;
    if (!model) name = st.id === 'codex-cli' ? 'the Codex app’s default model' : st.label;
    else if (st.id === 'claude-cli' && CLAUDE_CODE_MODELS.includes(model)) name = `Claude ${model[0].toUpperCase()}${model.slice(1)}`;
    else name = hubCache?.v.find((m) => m.id === model)?.name ?? nameFromId(model);
    return { model: effort && effortName[effort] ? `${name} · ${effortName[effort]}` : name };
  }
  /** The editor's reply, with a line for each stage that fell back to Auto during the job. */
  function withFallbacks<T extends AgentResult>(r: T, fell: string[]): T {
    return fell.length ? { ...r, summary: `${r.summary} ${fell.join(' ')}`.trim() } : r;
  }
  /** A stored choice for Claude Code: its model and --effort (a level it does not take is left out). */
  function claudeCodeChoice(choice: string | undefined): { model?: string; effort?: string } {
    if (!choice) return {};
    const { model, effort } = splitModel(choice);
    return { model, ...(effort && (CLAUDE_CODE_EFFORTS as readonly string[]).includes(effort) ? { effort } : {}) };
  }
  /** A stored choice for the Codex app: -m and its reasoning level (a config override, providers/cli.ts). */
  function codexChoice(choice: string | undefined): { model?: string; effort?: string } {
    if (!choice) return {};
    const { model, effort } = splitModel(choice);
    return { model, ...(effort ? { effort } : {}) };
  }

  async function saveConnection(input: ConnectionInput): Promise<SaveConnectionResult> {
    const fail = (e: unknown): SaveConnectionResult => {
      const err = e instanceof AIError ? e : new AIError('connection_error', 'Something went wrong talking to your server. Try again.', { detail: String((e as any)?.message ?? e) });
      return { status: { id: 'custom', connected: false, label: input.label?.trim() || LABELS.custom, error: err.toJSON() }, error: { ...err.toJSON(), ...(FIELD_OF[err.code] ? { field: FIELD_OF[err.code] } : {}) } };
    };
    const field = (f: ConnectionField, code: string, message: string): SaveConnectionResult => ({ ...fail(new AIError(code, message)), error: { code, userMessage: message, field: f } });
    if (!(input.kind in CONNECTION_KINDS)) return field('address', 'connection_bad_kind', 'Choose the kind of server first.');
    const label = String(input.label ?? '').trim();
    if (!label) return field('label', 'connection_no_label', 'Enter a name for this connection.');
    if (label.length > 60) return field('label', 'connection_no_label', 'Use a shorter name (60 characters at most).');
    const model = String(input.model ?? '').trim();
    if (!model) return field('model', 'connection_no_model', 'Enter a model name.');
    let baseURL: string;
    try { baseURL = normalizeBaseURL(String(input.baseURL ?? '')); } catch (e) { return fail(e); }

    const s = await settings();
    const before = input.id ? s.connections?.find((c) => c.id === input.id) : undefined;
    if (input.id && !before) return fail(new AIError('connection_gone', 'That connection is no longer saved.'));
    const id = before?.id ?? `c_${randomBytes(4).toString('hex')}`;
    const secret = connectionSecret(id);
    const typed = typeof input.key === 'string' ? input.key.trim() : '';
    if (!typed && before && hasSecret(secret) && !sameOrigin(before.baseURL, baseURL)) {
      return field('key', 'connection_key_new_address', 'The server address changed, so paste the key again. A saved key is only sent to the server it was saved for.');
    }
    const key = typed || (before ? await readSecret(secret) : null);
    if (input.kind === 'anthropic' && !key) {
      return field('key', 'connection_no_key', 'Paste the key for this server. Anthropic-compatible servers always need one.');
    }
    const conn: CustomConnection = { id, label, kind: input.kind, baseURL, model, supportsImages: false };
    try { conn.supportsImages = await checkConnection(conn, key); } catch (e) { return fail(e); }
    if (typed) {
      try { await writeSecret(secret, key, 'This computer has no safe place to keep that key, so it was not saved.'); } catch (e) { return fail(e); }
    }
    const list = (s.connections ?? []).filter((c) => c.id !== id);
    const at = before ? (s.connections ?? []).findIndex((c) => c.id === id) : list.length;
    list.splice(at, 0, conn);
    await saveSettings({ connections: list, active: 'custom', activeConnection: id });
    return { status: await statusOf('custom'), connection: connectionInfo(conn, await settings()) };
  }
  async function removeConnection(id: string): Promise<void> {
    const secret = connectionSecret(id);
    const s = await settings();
    const list = (s.connections ?? []).filter((c) => c.id !== id);
    const wasActive = s.active === 'custom' && activeConnection(s)?.id === id;
    await writeSecret(secret, null, '');
    // a CLIProxyAPI connection also keeps its management key
    await writeSecret(managementSecret(id), null, '');
    await saveSettings({
      connections: list.length ? list : undefined,
      ...(s.activeConnection === id ? { activeConnection: undefined } : {}),
      ...(wasActive ? { active: undefined } : {}),
    });
  }
  async function connectionModels(q: { kind: ConnectionKind; baseURL: string; key?: string; id?: string }): Promise<ConnectionModels> {
    if (!(q.kind in CONNECTION_KINDS)) return { models: [], suggested: null, needsKey: false };
    // a saved key only goes to the origin it was saved for; a different path on that server may use it
    const saved = q.id ? (await settings()).connections?.find((c) => c.id === q.id) : undefined;
    const key = q.key?.trim() || (saved && !notLocal(saved) && sameOrigin(saved.baseURL, q.baseURL) ? await readSecret(connectionSecret(saved.id)) : null);
    const { models, keyRefused } = await listConnectionModels(q.kind, q.baseURL, key, { fetch: opts.fetch }).catch(() => ({ models: [], keyRefused: false }));
    return { models, suggested: suggestedModel(models), needsKey: q.kind === 'anthropic' || keyRefused };
  }
  /** The active connection's own small model, or null when it has none. Never another provider or
   * account: a ChatGPT sign-in has no small model here, so it gets none. */
  async function smallModel(): Promise<ModelProvider | null> {
    const st = await active();
    // a model the person chose for naming versions; Auto keeps the connection's own small model
    if (modelForRole(st.id, 'namer', await roleChoices())) return modelProvider('namer');
    switch (st.id) {
      case 'claude': return new AnthropicProvider({ apiKey: (await claudeKey())!, model: SMALL_CLAUDE_MODEL, maxTokens: 2000, baseURL: opts.anthropicBaseURL, fetch: opts.fetch });
      case 'claude-cli': {
        const { bin, version } = await localClaude();
        return new ClaudeCliProvider({ model: 'haiku', env: env(), ...(bin ? { bin } : {}), ...(version ? { cliVersion: version } : {}) });
      }
      default: return null;
    }
  }

  /** The app the editor in use runs in, when it can run notes over MCP: the active editor is that app, and the app is
   * installed and signed in (the same detection the editor uses, localClaude.ts and localCodex.ts). */
  async function harnessApp(): Promise<{ app: 'claude-code' | 'codex'; bin?: string } | null> {
    const id = (await active()).id;
    if (id === 'claude-cli') { const c = await localClaude(); return c.state === 'ready' ? { app: 'claude-code', ...(c.bin ? { bin: c.bin } : {}) } : null; }
    if (id === 'codex-cli') { const c = await localCodex(); return c.state === 'ready' ? { app: 'codex', ...(c.bin ? { bin: c.bin } : {}) } : null; }
    return null;
  }

  async function noteRunner(): Promise<NoteRunnerInfo> {
    const found = await harnessApp();
    const s = await settings();
    return { runner: found && s.harness === found.app ? 'app' : 'reelstudio', app: found?.app ?? null, ...(lastFallback ? { fellBack: lastFallback } : {}) };
  }

  /** What runs a note's AI turns: the person's Claude Code or Codex app over MCP (Settings › How notes run), else our
   * own loop (undefined). One SessionHarness per app, binary and model for the app session: its self-test runs once. */
  const sessionHarnesses = new Map<string, Harness>();
  /** the last self-test that failed this session, for Settings (NoteRunnerInfo.fellBack) */
  let lastFallback: NoteRunnerInfo['fellBack'];
  async function noteHarness(provider: ModelProvider | null): Promise<Harness | undefined> {
    if (opts.harnessOverride) return opts.harnessOverride;
    if (opts.providerOverride || !provider) return undefined;
    const s = await settings();
    if (!s.harness) return undefined;
    const found = await harnessApp();
    if (!found || found.app !== s.harness) return undefined;
    const app = found.app;
    // the editor's model as Settings › Models chose it (Auto: the app's own saved model), as modelProvider runs it
    const choice = modelForRole(app === 'codex' ? 'codex-cli' : 'claude-cli', 'editor', await roleChoices()) ?? (app === 'codex' ? s.codexModel : s.cliModel);
    const picked = app === 'codex' ? codexChoice(choice) : claudeCodeChoice(choice);
    const key = JSON.stringify([app, found.bin, choice]);
    let harness = sessionHarnesses.get(key);
    if (!harness) {
      const o = { env: env(), ...(found.bin ? { bin: found.bin } : {}) };
      // the Codex runner takes a model only; its reasoning level stays the app's own
      const native = app === 'codex' ? new CodexHarness({ ...o, ...(picked.model ? { model: picked.model } : {}) }) : new ClaudeCodeHarness({ ...o, ...picked });
      harness = new SessionHarness(native, () => app === 'codex'
        ? new CodexCliProvider({ ...o, ...picked })
        : new ClaudeCliProvider({ ...o, ...picked, session: true }),
      (reason) => { lastFallback = { app, reason, at: new Date().toISOString() }; });
      sessionHarnesses.set(key, harness);
    }
    return harness;
  }

  /** Who looks things up for a note (helpers.ts): the person's other app when the editor is one of them and the
   * other is signed in, so a second AI brings its own eye; otherwise a fresh copy of the editor's own model. */
  async function helperFor(editorProvider: ModelProvider): Promise<Helper> {
    if (editorProvider.id === 'claude-cli') {
      const other = await localCodex();
      if (other.state === 'ready' && other.bin) return { label: 'ChatGPT', make: async () => new CodexCliProvider({ env: env(), bin: other.bin }) };
    }
    if (editorProvider.id === 'codex-cli') {
      const other = await localClaude();
      if (other.state === 'ready' && other.bin) return { label: 'Claude', make: async () => new ClaudeCliProvider({ env: env(), bin: other.bin }) };
    }
    return { label: 'Your editor', make: () => modelProvider('editor') };
  }

  /** The other app checks a note made in one (Settings > Double-check each edit), when it can answer: installed and
   * signed in. Otherwise undefined, and the checker model reviews it as in our own loop (applyNote). */
  async function checkerHarness(editorHarness: Harness | undefined): Promise<Harness | undefined> {
    if (opts.checkerHarnessOverride) return opts.checkerHarnessOverride;
    if (editorHarness?.id === 'claude-code') {
      const other = await localCodex();
      return other.state === 'ready' && other.bin ? new CodexHarness({ env: env(), bin: other.bin }) : undefined;
    }
    if (editorHarness?.id === 'codex') {
      const other = await localClaude();
      return other.state === 'ready' && other.bin ? new ClaudeCodeHarness({ env: env(), bin: other.bin }) : undefined;
    }
    return undefined;
  }

  return {
    providers,
    active,
    async setActive(id: ProviderId, connectionId?: string): Promise<void> {
      if (id === 'custom') {
        const s = await settings();
        const c = connectionId ? s.connections?.find((x) => x.id === connectionId) : activeConnection(s);
        if (!c) throw new AIError('not_available', 'That connection is no longer saved.');
        if (notLocal(c)) throw new AIError('hub_not_local', NOT_LOCAL);
        await saveSettings({ active: 'custom', activeConnection: c.id });
        return;
      }
      if (id === 'claude-cli') {
        // cancelCheck stops all of it: looking for the app, the check call, and the save after them
        checking?.abort();
        const check = (checking = new AbortController());
        const stopped = (): void => { if (check.signal.aborted) throw new AIError('cancelled', 'Stopped.'); };
        try {
          const lc = await localClaude(true);
          stopped();
          if (lc.state !== 'ready') throw new AIError('not_available', lc.reason ?? 'Your Claude Code app is not ready.');
          // signed in is not the same as able to answer (a plan at its limit, a broken install): one tiny real call
          const s = await settings();
          const model = modelForRole('claude-cli', 'editor', await roleChoices()) ?? s.cliModel;
          try {
            const r = await new ClaudeCliProvider({ ...claudeCodeChoice(model), timeoutMs: CHECK_TIMEOUT_MS, env: env(), ...(lc.bin ? { bin: lc.bin } : {}) })
              .complete({ system: '', messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with the word OK.' }] }], tools: [], jsonOnly: true, signal: check.signal });
            if (r.limits) claudeWindows = { at: Date.now(), v: r.limits };
          } catch (e) {
            if (e instanceof AIError && e.limits) claudeWindows = { at: Date.now(), v: e.limits };
            throw e;
          }
          stopped();
          await saveSettings({ active: id, chatgptMoved: undefined });
        } finally {
          if (checking === check) checking = null;
        }
        return;
      } else if (id === 'codex-cli') {
        const lc = await localCodex(true);
        if (lc.state !== 'ready') throw new AIError('not_available', lc.reason ?? 'Your Codex app is not ready.');
        await saveSettings({ active: id, chatgptMoved: undefined });
        return;
      } else if (!opts.dev && !PEOPLE_PROVIDERS.includes(id)) {
        throw new AIError('not_available', 'That option is not available.');
      }
      await saveSettings({ active: id });
    },
    /** Stops the check call setActive('claude-cli') is making; setActive then throws AIError 'cancelled' and saves nothing. */
    cancelCheck(): void { checking?.abort(); },
    /** Settings › Editor › How notes run. */
    noteRunner,
    /** `app` runs notes in the editor in use's own app; refused unless that app is offered (noteRunner().app). Choosing
     * again forgets this session's self-test, so the next note tries the app again. */
    async setNoteRunner(runner: 'reelstudio' | 'app'): Promise<NoteRunnerInfo> {
      if (runner !== 'reelstudio' && runner !== 'app') throw new AIError('bad_request', 'Choose how notes run.');
      const found = await harnessApp();
      if (runner === 'app' && !found) throw new AIError('not_available', 'Connect your Claude Code app or Codex app as your editor first.');
      await saveSettings({ harness: runner === 'app' ? found!.app : undefined });
      sessionHarnesses.clear();
      lastFallback = undefined;
      return noteRunner();
    },
    /** A fresh look at the person's own Claude Code app: state, version, plan kind and the binary path (for the
     * app's sign-in window). Never an e-mail, organization or token. */
    async claudeCodeStatus(): Promise<LocalClaude> { return localClaude(true); },
    /** A fresh look at the person's own Codex app: state, version, kind of sign-in and the binary path (for the app's
     * sign-in). Never an e-mail, a key or a token. `chatgptMoved`: the old in-app sign-in was retired on upgrade. */
    async codexStatus(): Promise<LocalCodex & { chatgptMoved?: boolean; plan?: string }> {
      const v = await localCodex(true);
      // the plan, asked of the Codex app itself (app-server), kept a minute: the row reads "Codex app · Pro"
      let plan: string | undefined;
      if (v.state === 'ready' && v.bin) {
        if (!codexPlan || codexPlan.bin !== v.bin || Date.now() - codexPlan.at > LOCAL_CLAUDE_TTL_MS) codexPlan = { bin: v.bin, at: Date.now(), plan: (await readCodexAccount(v.bin, env()))?.plan };
        plan = codexPlan.plan;
      }
      return { ...v, ...(plan ? { plan } : {}), ...((await settings()).chatgptMoved ? { chatgptMoved: true } : {}) };
    },
    /** Once, at start-up: "Sign in with ChatGPT" is retired (0.1.3) and its code is gone. What an older version left
     * on disk is deleted (the saved session, its client registration and host id) and a choice of it cleared. Local
     * only, no request to OpenAI any more: 0.1.3 revoked the sessions it found; one it never saw (an upgrade straight
     * from 0.1.2) is deleted here and expires on OpenAI's side. Returns true when there was something to retire. */
    async retireSignInWithChatGPT(): Promise<boolean> {
      const s = await settings();
      const file = (f: string) => path.join(opts.settingsDir, f);
      const session = RETIRED_CHATGPT_SESSION.some((f) => fs.existsSync(file(f)));
      for (const f of [...RETIRED_CHATGPT_SESSION, ...RETIRED_CHATGPT_REGISTRATION]) await fsp.rm(file(f), { force: true });
      const chosen = (s.active as string | undefined) === 'chatgpt';
      if (!session && !chosen) return false;
      await saveSettings({ ...(chosen ? { active: undefined } : {}), chatgptMoved: true });
      return true;
    },
    async stockProviders(): Promise<{ id: StockProvider; connected: boolean }[]> {
      // whether a key is saved, without decrypting it
      return [{ id: 'pexels', connected: hasStockKey('pexels') }, { id: 'pixabay', connected: hasStockKey('pixabay') }, { id: 'openverse', connected: true }];
    },
    async setStockKey(provider: 'pexels' | 'pixabay', key: string | null): Promise<void> {
      if (!['pexels', 'pixabay'].includes(provider) || (key !== null && typeof key !== 'string')) throw new AIError('bad_stock_key', 'Choose Pexels or Pixabay and enter an API key.');
      const file = path.join(opts.settingsDir, `${provider}-key.bin`);
      const trimmed = key?.trim();
      if (!trimmed) { await fsp.rm(file, { force: true }); return; }
      if (!protectedSecretStore(opts.secretStore)) throw new AIError('no_secure_storage', 'This computer does not have a protected password store, so the stock API key was not saved.');
      try { await writeFileAtomic(file, opts.secretStore.encryptString(trimmed), 0o600); }
      catch { throw new AIError('stock_key_save_failed', 'The stock API key could not be saved securely. Try again.'); }
    },
    async setClaudeKey(key: string | null): Promise<ProviderStatus> {
      const trimmed = key?.trim() || null;
      if (!trimmed) {
        await storeClaudeKey(null);
        const s = await settings();
        if (s.active === 'claude') await saveSettings({ active: undefined });
        return statusOf('claude');
      }
      const s = await settings();
      try {
        await new AnthropicProvider({ apiKey: trimmed, model: s.claudeModel, baseURL: opts.anthropicBaseURL, fetch: opts.fetch }).ping();
      } catch (e: any) {
        const err = e instanceof AIError ? e : new AIError('claude_error', 'Reel Studio could not check that key. Try again.');
        // Rate-limited / overloaded still proves the key is real: keep it.
        if (!['claude_rate_limited', 'claude_unavailable'].includes(err.code)) return { id: 'claude', connected: false, label: LABELS.claude, error: err.toJSON() };
      }
      try { await storeClaudeKey(trimmed); } catch (e: any) {
        if (e instanceof AIError) return { id: 'claude', connected: false, label: LABELS.claude, error: e.toJSON() };
        throw e;
      }
      await saveSettings({ active: 'claude' });
      return statusOf('claude');
    },
    async connections(): Promise<ConnectionInfo[]> {
      const s = await settings();
      return (s.connections ?? []).map((c) => connectionInfo(c, s));
    },
    /** Saved and used only after one small request through it works; otherwise `error` names the field to fix. */
    saveConnection(input: ConnectionInput): Promise<SaveConnectionResult> {
      return oneAtATime(() => saveConnection(input));
    },
    removeConnection(id: string): Promise<void> {
      return oneAtATime(() => removeConnection(id));
    },
    setConnectionImages(id: string, supportsImages: boolean): Promise<void> {
      return oneAtATime(async () => {
        const s = await settings();
        if (!s.connections?.some((c) => c.id === id)) throw new AIError('connection_gone', 'That connection is no longer saved.');
        await saveSettings({ connections: s.connections.map((c) => (c.id === id ? { ...c, supportsImages } : c)) });
      });
    },
    /** `key` empty with `id` set uses that connection's stored key, which never leaves this process. */
    connectionModels(q: { kind: ConnectionKind; baseURL: string; key?: string; id?: string }): Promise<ConnectionModels> {
      return oneAtATime(() => connectionModels(q));
    },
    async setModel(which: 'claude' | 'cli', model: string | null): Promise<void> {
      await saveSettings({ [`${which}Model`]: model ?? undefined } as Partial<AISettings>);
    },
    async setReplayFixture(file: string | null): Promise<void> { await saveSettings({ replayFixture: file ?? undefined }); },
    /** One tiny request through the active editor with `role`'s model (the editor's Test): its reply, the model that
     * answered and how long it took. Throws AIError with a userMessage. */
    async testConnection(signal?: AbortSignal, role: ModelRole = 'editor'): Promise<TestResult> {
      const fell: string[] = [];
      const p = await modelProvider(role, fell);
      if (!p) throw new AIError('no_ai', 'No editor is connected yet. Choose one in Settings, under Editor.');
      const t0 = Date.now();
      try {
        const r = await p.complete({ system: 'Reply with exactly the word OK.', messages: [{ role: 'user', content: [{ type: 'text', text: 'Say OK.' }] }], tools: [], jsonOnly: true, signal });
        if (r.limits) claudeWindows = { at: Date.now(), v: r.limits };
        // a server that echoes what it was sent would put a key on screen: every saved secret comes out, and only a
        // short excerpt is kept
        const reply = (await scrubSecrets(r.text)).trim().slice(0, 200);
        return { provider: p.id, model: p.model, reply, ms: Date.now() - t0, ...(r.limits ? { limits: r.limits } : {}), ...(fell.length ? { note: fell.join(' ') } : {}) };
      } catch (e) {
        if (e instanceof AIError && e.limits) claudeWindows = { at: Date.now(), v: e.limits };
        throw e;
      } finally {
        await (p as { dispose?: () => Promise<void> }).dispose?.();
      }
    },
    /**
     * What Auto runs right now for each stage, by name: the model the app sends (the hub connection's own model,
     * Claude Code's `sonnet`, a key's model), or the app's default when the app itself picks (the Codex app). Null
     * means no model runs: the version-name stage on an editor without a small one, where the app writes the titles.
     */
    async autoModels(): Promise<Partial<Record<ModelRole, string | null>>> {
      const st = await active();
      if (!st.connected || st.id === 'none') return {};
      const s = await settings();
      let base: string;
      let small: string | undefined;
      if (st.id === 'claude-cli') {
        const m = splitModel(s.cliModel ?? 'sonnet').model;
        base = CLAUDE_CODE_MODELS.includes(m) ? `Claude ${m[0].toUpperCase()}${m.slice(1)}` : nameFromId(m);
        small = 'Claude Haiku';
      } else if (st.id === 'codex-cli') {
        base = s.codexModel ? nameFromId(splitModel(s.codexModel).model) : 'the Codex app’s default';
      } else if (st.id === 'claude') {
        base = nameFromId(s.claudeModel ?? DEFAULT_CLAUDE_MODEL);
        small = nameFromId(SMALL_CLAUDE_MODEL);
      } else if (st.id === 'custom') {
        const c = activeConnection(s);
        if (!c) return {};
        const id = splitModel(c.model).model;
        const named = c.kind === 'cliproxy' ? (await hubList(c, await readSecret(connectionSecret(c.id))).catch(() => [] as HubModel[])).find((m) => m.id === id)?.name : undefined;
        base = named ?? nameFromId(id);
      } else return {};
      const out: Partial<Record<ModelRole, string | null>> = Object.fromEntries(MODEL_ROLES.map((r) => [r, base]));
      out.namer = small ?? null;
      return out;
    },
    /** The models the editor in use offers, for each stage's picker: the hub's list, Claude Code's names, the Codex
     * app's list, or your own server's. Empty for an editor that picks its own (a Claude key). */
    async editorModels(): Promise<EditorModel[]> {
      const st = await active();
      if (st.id === 'claude-cli') return CLAUDE_CODE_PICKS;
      if (st.id === 'codex-cli') {
        const bin = (await localCodex()).bin;
        return bin ? ((await readCodexAccount(bin, env()))?.models ?? []) : [];
      }
      if (st.id !== 'custom') return [];
      const c = activeConnection(await settings());
      if (!c) return [];
      const key = await readSecret(connectionSecret(c.id));
      if (c.kind === 'cliproxy') return hubList(c, key);
      const { models } = await listConnectionModels(c.kind, c.baseURL, key, { fetch: opts.fetch }).catch(() => ({ models: [] as string[] }));
      return models.map((id) => ({ id, name: nameFromId(id), family: familyOf(id), efforts: [], images: c.supportsImages }));
    },
    /** Who the editor in use runs as: CLIProxyAPI's accounts (with its management key), the Codex app's plan and
     * limits, or Claude Code's plan with the windows its last answer reported. Never an e-mail for the person's own
     * apps; a hub account is named by the e-mail the hub has for it. */
    async editorAccounts(): Promise<EditorAccounts> {
      const st = await active();
      if (st.id === 'claude-cli') {
        const lc = await localClaude();
        const plan = claudePlanName(lc.plan);
        return { accounts: [{ name: 'Claude Code app', provider: 'claude', ...(plan ? { plan } : {}), windows: claudeWindows?.v ?? [] }] };
      }
      if (st.id === 'codex-cli') {
        const bin = (await localCodex()).bin;
        const a = bin ? await readCodexAccount(bin, env()) : null;
        if (!a) return { accounts: [], problem: 'Your Codex app didn’t say its plan or limits. Update it, then look again.' };
        return { accounts: [{ name: 'Codex app', provider: 'codex', ...(a.plan ? { plan: a.plan } : {}), windows: a.windows }] };
      }
      if (st.id !== 'custom') return { accounts: [] };
      const c = activeConnection(await settings());
      if (!c || c.kind !== 'cliproxy') return { accounts: [] };
      const mk = await readSecret(managementSecret(c.id));
      if (!mk) return { accounts: [], needsManagementKey: true };
      try {
        const list: HubAccount[] = await hubAccounts(c.baseURL, mk, { fetch: opts.fetch });
        return { accounts: list.map(({ id: _id, ...a }) => a) };
      } catch (e) {
        if (e instanceof AIError && e.code === 'hub_management_key') return { accounts: [], needsManagementKey: true, problem: e.userMessage };
        return { accounts: [], problem: e instanceof AIError ? e.userMessage : 'CLIProxyAPI could not list its accounts.' };
      }
    },
    /**
     * Connects CLIProxyAPI at `origin` with `key` (read by the app from the hub's own config, or typed) and makes it the
     * editor. Saved only after its model list answers with that key; the key goes to the encrypted connection store.
     * `keySource` is said in the row. A hub saved before at the same origin is updated, not duplicated.
     */
    saveHub(input: { origin: string; key: string; keySource: string }): Promise<SaveConnectionResult> {
      return oneAtATime(async () => {
        const fail = (e: unknown): SaveConnectionResult => {
          const err = e instanceof AIError ? e : new AIError('hub_error', 'Something went wrong talking to CLIProxyAPI. Try again.', { detail: String((e as any)?.message ?? e) });
          return { status: { id: 'custom', connected: false, label: 'CLIProxyAPI', error: err.toJSON() }, error: { ...err.toJSON(), field: 'key' } };
        };
        let origin: string;
        try { origin = new URL(normalizeBaseURL(input.origin)).origin; } catch (e) { return fail(e); }
        // a found CLIProxyAPI is this computer, at a literal loopback address; a server elsewhere is added under
        // Advanced, where the person types its address and key
        if (!loopbackOrigin(origin)) return fail(new AIError('hub_not_local', 'That CLIProxyAPI is not on this computer, so its key was not sent. To use a server elsewhere, add it under Advanced.'));
        const key = String(input.key ?? '').trim();
        if (!key) return fail(new AIError('hub_key', 'Paste a key from api-keys in your CLIProxyAPI config.'));
        if (key.length < MIN_HUB_KEY) return fail(new AIError('hub_key_short', `That key is shorter than ${MIN_HUB_KEY} characters. Give CLIProxyAPI a longer one in api-keys: Reel Studio needs at least ${MIN_HUB_KEY} to keep a key out of everything it shows and logs.`));
        let models: HubModel[];
        try { models = await hubModels(origin, key, { fetch: opts.fetch }); } catch (e) { return fail(e); }
        const s = await settings();
        const before = (s.connections ?? []).find((c) => c.kind === 'cliproxy' && sameOrigin(c.baseURL, origin));
        const id = before?.id ?? `c_${randomBytes(4).toString('hex')}`;
        const ids = models.map((m) => m.id);
        const model = (before && ids.includes(splitModel(before.model).model) ? before.model : null) ?? suggestedModel(ids) ?? models.find((m) => m.family === 'claude')?.id ?? ids[0];
        if (!model) return fail(new AIError('hub_no_models', 'CLIProxyAPI answered, but it offers no models yet. Sign in an account in CLIProxyAPI, then look again.'));
        try { await writeSecret(connectionSecret(id), key, 'This computer has no safe place to keep that key, so it was not saved.'); } catch (e) { return fail(e); }
        const conn: CustomConnection = { id, label: 'CLIProxyAPI', kind: 'cliproxy', baseURL: origin, model, supportsImages: true, keySource: String(input.keySource ?? '').slice(0, 300) || 'typed' };
        const list = (s.connections ?? []).filter((c) => c.id !== id);
        list.unshift(conn);
        await saveSettings({ connections: list, active: 'custom', activeConnection: id });
        hubCache = { key: `${origin}|${id}`, at: Date.now(), v: models };
        return { status: await statusOf('custom'), connection: connectionInfo(conn, await settings()) };
      });
    },
    /** CLIProxyAPI's management key, for its accounts and limits. Saved only after the hub accepts it; null removes it. */
    setHubManagementKey(key: string | null): Promise<EditorAccounts> {
      return oneAtATime(async () => {
        const c = activeConnection(await settings());
        if (!c || c.kind !== 'cliproxy') throw new AIError('connection_gone', 'Connect CLIProxyAPI first.');
        if (notLocal(c)) throw new AIError('hub_not_local', NOT_LOCAL);
        const k = key?.trim() || null;
        if (k && k.length < MIN_HUB_KEY) throw new AIError('hub_key_short', `That management key is shorter than ${MIN_HUB_KEY} characters. Set a longer secret-key in CLIProxyAPI’s config: Reel Studio needs at least ${MIN_HUB_KEY} to keep a key out of everything it shows and logs.`);
        if (!k) { await writeSecret(managementSecret(c.id), null, ''); return { accounts: [], needsManagementKey: true }; }
        const list = await hubAccounts(c.baseURL, k, { fetch: opts.fetch });
        await writeSecret(managementSecret(c.id), k, 'This computer has no safe place to keep that key, so it was not saved.');
        return { accounts: list.map(({ id: _id, ...a }) => a) };
      });
    },
    /** `opts.pauseOn`: an AI failure the app pauses on (editor.ts EditorDeps.pauseOn) instead of a basic version. */
    async firstEdit(projectDir: string, onEvent: (e: AgentEvent) => void, signal?: AbortSignal, opts: { owner?: string; basic?: boolean; pauseOn?: (e: AIError) => boolean } = {}): Promise<AgentResult & { notice?: any }> {
      return exclusive(projectDir, opts.owner, (owner) => edit(owner, async (d) => {
        if (opts.basic) return editor.firstEdit(d, null, projectDir, onEvent, signal);
        // each role asks for its own model (Settings › Editor › Models)
        const fell: string[] = [];
        const roles = { checker: await modelProvider('checker', fell), writer: await modelProvider('writer', fell) };
        const provider = await modelProvider('editor', fell);
        const r = await editor.firstEdit({ ...d, ...roles, pauseOn: opts.pauseOn }, provider, projectDir, onEvent, signal);
        const said = withFallbacks(r, fell);
        // a notice means the editor stopped and the simple edit made the version: no model made it
        return said.notice ? said : { ...said, ...(await madeWith(provider)) };
      }));
    },
    async applyNote(projectDir: string, note: string, onEvent: (e: AgentEvent) => void, signal?: AbortSignal, opts: editor.ApplyNoteOptions & { owner?: string } = {}): Promise<AgentResult> {
      return exclusive(projectDir, opts.owner, (owner) => edit(owner, async (d) => {
        const fell: string[] = [];
        const provider = await modelProvider('editor', fell);
        const harness = await noteHarness(provider);
        // "Double-check each edit": in our own loop the checker role's model reviews (#73); a note in an MCP harness
        // is reviewed by the other harness (mcp-harness-2)
        const other = opts.checkEdit && harness ? await checkerHarness(harness) : undefined;
        const checker = !opts.checkEdit ? {} : other ? { checkerHarness: other } : { checker: await modelProvider('checker', fell) };
        const helper = opts.helpers && provider ? await helperFor(provider) : undefined;
        const r = withFallbacks(await editor.applyNote({ ...d, ...checker, harness, ...(helper ? { helper } : {}) }, provider, projectDir, note, onEvent, signal, opts), fell);
        return r.version !== undefined && r.changed.length ? { ...r, ...(await madeWith(provider)) } : r;
      }));
    },
    /** True when applyNote would take the no-model fast path for these words ("smaller captions"):
     * a setting for the whole reel. The app asks before adding a moment, which would hide it. */
    async wholeReelSetting(projectDir: string, note: string): Promise<boolean> {
      return !!planFastNote(note, await loadProject(projectDir));
    },
    async mergeVersions(projectDir: string, request: import('./version-merge').MergeRequest, onEvent: (e: AgentEvent) => void, signal?: AbortSignal, opts: { owner?: string; id?: string } = {}): Promise<editor.MergeEditResult> {
      return exclusive(projectDir, opts.owner, (owner) => edit(owner, (d) => editor.saveMerge(d, projectDir, request, onEvent, signal, opts)));
    },
    /** What two saved versions differ in, for choosing which version each part comes from when combining them. */
    async mergeLayers(projectDir: string, ours: number, theirs: number): Promise<MergeLayer[]> {
      const snapshot = (n: number) => loadProject(projectDir, path.join(versionDir(projectDir, n), 'project.json'));
      return differingLayers(await snapshot(ours), await snapshot(theirs));
    },
    async writeScript(idea: string, onEvent: (e: AgentEvent) => void, signal?: AbortSignal): Promise<ScriptResult> {
      return editor.writeScript(deps(opts.host), await modelProvider('writer'), idea, onEvent, signal);
    },
    /** Rewords a committed version's title and summary with one small-model call. null: the connection
     * has no small model, or the reply was not the JSON asked for. The app checks the words against the
     * version's receipts before it shows them. */
    async rewordVersion(text: { title: string; summary: string }, signal?: AbortSignal): Promise<{ title: string; summary: string } | null> {
      const p = await smallModel();
      if (!p) return null;
      const r = await p.complete({ system: prompts.render('versionTitle'), messages: [{ role: 'user', content: [{ type: 'text', text: JSON.stringify(text) }] }], tools: [], jsonOnly: true, signal });
      const j = extractJson(r.text);
      return typeof j?.title === 'string' && typeof j?.summary === 'string' ? { title: j.title, summary: j.summary } : null;
    },
    /** One turn of a planned reel's planning chat: a short question back, or the whole plan (editor.ts planTurn). */
    async planTurn(input: PlanTurnInput, onEvent: (e: AgentEvent) => void, signal?: AbortSignal): Promise<PlanTurnResult> {
      return editor.planTurn(deps(opts.host), await modelProvider('planner'), input, onEvent, signal);
    },
    /** One turn of My style's niche chat: a short question back, or the whole niche to save (niche.ts nicheTurn). */
    async nicheTurn(input: NicheTurnInput, onEvent: (e: AgentEvent) => void, signal?: AbortSignal): Promise<NicheTurnResult> {
      return nicheTurn({ prompts, style }, await modelProvider('planner'), input, onEvent, signal);
    },
    /** Try 2 for a trial post: the one thing the editor changes from the reel as it is, and why. */
    async proposeTry(req: TryRequest, signal?: AbortSignal): Promise<TryProposal> {
      return proposeTry(prompts, await modelProvider('trial'), req, signal);
    },
    /** More reels from one video: the distinct reels the editor finds in its transcript, best first (propose.ts). */
    async proposeReels(req: ProposeReelsRequest, signal?: AbortSignal, onEvent?: (e: AgentEvent) => void): Promise<ReelProposal> {
      return proposeReels(prompts, await modelProvider('finder'), req, signal, onEvent);
    },
    /** Reels across the whole footage archive: line ranges from the indexed files, best first (propose-archive.ts). */
    async proposeFromArchive(req: ArchiveRequest, signal?: AbortSignal, onEvent?: (e: AgentEvent) => void): Promise<ArchiveProposal> {
      return proposeFromArchive(prompts, await modelProvider('finder'), req, signal, onEvent);
    },
    async styleRules() { return style.list(); },
    async removeStyleRule(id: string, options?: { forget?: boolean }) { return style.remove(id, options); },
    /** The user said Yes to a proposed rule (AgentResult.styleSuggestions), typed one in My style, or kept one
     * learned from an export. `from`: the note or the export it came from. `check`: a styleChecks entry's machine form,
     * which the app then measures on every render. Returns the saved rule. */
    async addStyleRule(text: string, from?: Pick<StyleRule, 'source' | 'imported' | 'byYou'>, check?: RuleCheck) { return (await style.add(text, from, check)).rule; },
    /** Undo of removeStyleRule: the rule back at `index`. */
    async restoreStyleRule(rule: StyleRule, index: number) { return style.restore(rule, index); },
    /** My style started over because its file was damaged; the damaged copy is kept next to it. */
    async styleWasDamaged() { return style.wasDamaged(); },
    /** The user said Yes to AgentResult.styleProposal. */
    async approveStyleProposal(p: StyleProposal) { return style.approve(p); },
    /** The user said No to AgentResult.styleProposal. */
    async declineStyleProposal(p: StyleProposal) { return style.decline(p); },
    /** Memories drafted from post results (learning.ts learn(), which also takes back waiting ones the results no
     * longer support); the app passes each to proposeMemory. */
    async learnFromResults(): Promise<ProposalDraft[]> { return learn(path.join(opts.host.reelStudioRoot(), 'Projects'), style); },
    /** Keeps a drafted memory waiting for the person (at most three). Never a rule until they keep it. */
    async proposeMemory(d: ProposalDraft) { return style.propose(d); },
    async memoryProposals() { return style.proposals(); },
    /** The person kept a waiting memory, with its words or `words` they typed. Null when it was already gone. */
    async acceptMemory(id: string, words?: string) { return style.accept(id, words); },
    /** No thanks: the memory, and its words, are never proposed again. */
    async dismissMemory(id: string) { return style.dismiss(id); },
    /** My style: the user edited a rule's words, or paused or resumed it. */
    async updateStyleRule(id: string, patch: { text?: string; paused?: boolean }) { return style.update(id, patch); },
  };
}

export type ReelStudioAI = ReturnType<typeof createAI>;

/** The engine as one edit sees it. An app job's `owner` token goes on every command
 * (engine/reelengine/owner.py). Once part of an engine would not stop (ENGINE_STUCK) no further
 * command runs, and `settle` fails the edit with that error however it ended: a first look or a tool
 * result would otherwise swallow it, and the app job would let go of the project while that part may
 * still be writing to it. */
function editHost(host: EngineHost, owner: string | undefined) {
  let stuck: unknown = null;
  return {
    host: {
      async runEngine(command, args, onProgress, signal) {
        if (stuck) throw stuck;
        try {
          return await host.runEngine(command, owner ? [...args, '--owner', owner] : args, onProgress, signal);
        } catch (e: any) {
          if (e?.code === 'ENGINE_STUCK') stuck ??= e;
          throw e;
        }
      },
      renderAnimation: (template, params, outPath, fps) => host.renderAnimation(template, params, outPath, fps),
      reelStudioRoot: () => host.reelStudioRoot(),
      ...(host.captureWebsite ? { captureWebsite: host.captureWebsite.bind(host) } : {}),
      // a search_footage hit is copied into the Library by the app; without this a note could find footage but never place it
      ...(host.importFootage ? { importFootage: host.importFootage.bind(host) } : {}),
    } satisfies EngineHost,
    stuck: () => stuck,
    async settle<T>(edit: Promise<T>): Promise<T> {
      const r = await edit.catch((e) => { throw stuck ?? e; });
      if (stuck) throw stuck;
      return r;
    },
  };
}

const LOCK_STALE_MS = 3 * 60 * 60 * 1000;

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e: any) { return e?.code === 'EPERM'; }
}

/** <project>/work/.ai-edit.lock holds {pid, at}. Another LIVE process holding it = AIError busy; a
 * dead or 3-hour-old holder is taken over. */
export async function withEditLock<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const lock = path.join(dir, 'work', '.ai-edit.lock');
  await fsp.mkdir(path.dirname(lock), { recursive: true });
  for (let attempt = 0; ; attempt++) {
    try {
      const fh = await fsp.open(lock, 'wx');
      await fh.writeFile(JSON.stringify({ pid: process.pid, at: Date.now() }));
      await fh.close();
      break;
    } catch (e: any) {
      if (e?.code !== 'EEXIST' || attempt > 0) {
        if (e?.code === 'EEXIST') throw new AIError('busy', 'This video is being edited somewhere else right now. Try again when that finishes.');
        throw e;
      }
      let held: { pid?: number; at?: number } = {};
      try { held = JSON.parse(await fsp.readFile(lock, 'utf8')); } catch { /* unreadable = stale */ }
      const live = held.pid && held.pid !== process.pid && alive(held.pid) && Date.now() - (held.at ?? 0) < LOCK_STALE_MS;
      if (live) throw new AIError('busy', 'This video is being edited somewhere else right now. Try again when that finishes.');
      await fsp.rm(lock, { force: true });
    }
  }
  try { return await fn(); } finally { await fsp.rm(lock, { force: true }).catch(() => undefined); }
}
export { PythonEngineHost, defaultRoot } from './engineHost';
