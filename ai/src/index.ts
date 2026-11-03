// @reelstudio/ai: providers, prompts, tools and the editor agent loop (docs/architecture.md sections 6 and 8).
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  AgentEvent, AgentResult, AIError, EngineHost, ModelProvider, Part, ProviderId, ProviderStatus, ScriptResult, SecretStore, UserFacingError,
} from './types';
import { Prompts, defaultPromptsDir } from './prompts';
import { StyleStore } from './style';
import { writeFileAtomic } from './project';
import { AnthropicProvider, DEFAULT_CLAUDE_MODEL } from './providers/anthropic';
import { ClaudeCliProvider, CodexCliProvider } from './providers/cli';
import { ReplayProvider } from './providers/replay';
import { CONNECTION_KINDS, ConnectionKind, listConnectionModels, noRedirectFetch, normalizeBaseURL, suggestedModel } from './providers/connection';
import { OpenAICompatibleProvider } from './providers/openaiCompatible';
import { detectLocalClaude, DetectOptions, LocalClaude } from './providers/localClaude';
import { detectCodex, CodexDetectOptions, LocalCodex } from './providers/localCodex';
import * as editor from './editor';

export * from './types';
export * from './project';
export { TOOLS, TOOL_NAMES, toolSchemas, executeTool, newToolState } from './tools';
export type { ToolContext, ToolDef } from './tools';
export { runAgent } from './agent';
export { Prompts } from './prompts';
export { StyleStore } from './style';
export { AnthropicProvider, DEFAULT_CLAUDE_MODEL } from './providers/anthropic';
export { ClaudeCliProvider, CodexCliProvider } from './providers/cli';
export { ReplayProvider, RecordingProvider } from './providers/replay';
export { OpenAICompatibleProvider } from './providers/openaiCompatible';
export type { ConnectionKind } from './providers/connection';
export { detectLocalClaude, findClaude, claudeCandidates, claudeFromLoginShell, CLAUDE_CODE_MESSAGES } from './providers/localClaude';
export type { LocalClaude, ClaudeCodeState } from './providers/localClaude';
export { detectCodex, findCodex, codexCandidates, codexFromLoginShell, CODEX_MESSAGES } from './providers/localCodex';
export type { LocalCodex, CodexState } from './providers/localCodex';
export { cliEnv } from './safety';
export { pickTakes, formatForPicking, deterministicEdit } from './editor';
export type { ApplyNoteOptions } from './editor';
export { ATTACHMENT_REF, MAX_ATTACHMENTS_PER_NOTE, readAttachment, listAttachments, validateAttachments, placedAssets } from './attachments';
export type { AttachmentInfo } from './attachments';

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
  /** set when the old in-app "Sign in with ChatGPT" was signed out on upgrade; cleared once the Codex app is chosen */
  chatgptMoved?: boolean;
}

export interface CustomConnection {
  id: string; label: string; kind: ConnectionKind; baseURL: string; model: string;
  /** set by the picture sent with the check on save; the person can change it */
  supportsImages: boolean;
}
export interface ConnectionInfo extends CustomConnection { hasKey: boolean; active: boolean }
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
const WEAK_STORE_MESSAGE = 'This computer has no password store Reel Studio can use (such as GNOME Keyring or KWallet), so other apps could read the key. I did not save it. Turn on your password store, then try again.';
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
  providerOverride?: ModelProvider;
  finalRender?: boolean;
  maxSteps?: number;
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
/** Files the retired "Sign in with ChatGPT" (0.1.2 and earlier) kept in the settings folder. */
const RETIRED_CHATGPT_SESSION = ['chatgpt-credentials.bin', 'chatgpt-credentials.json'];
const RETIRED_CHATGPT_REGISTRATION = ['chatgpt-account.json', 'chatgpt-host.json'];

export function createAI(opts: CreateAIOptions) {
  let localCache: { at: number; v: LocalClaude } | null = null;
  async function localClaude(fresh = false): Promise<LocalClaude> {
    if (!fresh && localCache && Date.now() - localCache.at < LOCAL_CLAUDE_TTL_MS) return localCache.v;
    const v = await detectLocalClaude({ env: env(), ...(opts.localClaude ?? {}) });
    localCache = { at: Date.now(), v };
    return v;
  }
  const env = (): NodeJS.ProcessEnv => opts.cliEnv?.() ?? process.env;
  let codexCache: { at: number; v: LocalCodex } | null = null;
  async function localCodex(fresh = false): Promise<LocalCodex> {
    if (!fresh && codexCache && Date.now() - codexCache.at < LOCAL_CLAUDE_TTL_MS) return codexCache.v;
    const v = await detectCodex({ env: env(), ...(opts.localCodex ?? {}) });
    codexCache = { at: Date.now(), v };
    return v;
  }
  const settingsFile = path.join(opts.settingsDir, 'ai-settings.json');
  const prompts = new Prompts(opts.promptsDir ?? defaultPromptsDir());
  const style = new StyleStore(() => opts.host.reelStudioRoot());
  // One edit at a time per project (the app may double-click; the CLI may race).
  const locks = new Map<string, Promise<unknown>>();
  function exclusive<T>(dir: string, fn: () => Promise<T>): Promise<T> {
    const key = path.resolve(dir).toLowerCase();
    const prev = locks.get(key) ?? Promise.resolve();
    // in-process queue, plus a lock FILE so the dev CLI and the app cannot edit one project at once
    const run = prev.catch(() => undefined).then(() => withEditLock(dir, fn));
    // The lock's copy of the run must never reject on its own: the caller gets `run` and handles
    // its error; an unobserved rejected `finally` copy is an unhandled rejection in Node.
    const tail: Promise<unknown> = run.finally(() => { if (locks.get(key) === tail) locks.delete(key); })
      .catch(() => undefined);
    locks.set(key, tail);
    return run;
  }
  const deps = (): editor.EditorDeps => ({ host: opts.host, prompts, style, fetchImpl: opts.fetch, finalRender: opts.finalRender, maxSteps: opts.maxSteps, tokenBudget: opts.tokenBudget, lookup: opts.lookup });

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

  // ---- Claude key (secret)
  const claudeKey = () => readSecret('claude-key');
  const storeClaudeKey = (key: string | null) => writeSecret('claude-key', key, 'This computer has no safe place to keep your Claude key, so I did not save it. Add it from the Reel Studio app.');

  // ---- your own AI server ('custom')
  const connectionSecret = (id: string) => {
    if (!CONNECTION_ID.test(id)) throw new AIError('connection_gone', 'That connection is no longer saved.');
    return `connection-${id}`;
  };
  const connectionInfo = (c: CustomConnection, s: AISettings): ConnectionInfo => ({
    id: c.id, label: c.label, kind: c.kind, baseURL: c.baseURL, model: c.model, supportsImages: c.supportsImages,
    hasKey: hasSecret(connectionSecret(c.id)), active: s.active === 'custom' && activeConnection(s)?.id === c.id,
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
  function connectionProvider(c: CustomConnection, key: string | null, check = false): ModelProvider {
    if (c.kind === 'anthropic') {
      return new AnthropicProvider({
        id: 'custom', apiKey: key!, model: c.model, baseURL: c.baseURL, fetch: noRedirectFetch(opts.fetch), supportsImages: c.supportsImages,
        ...(check ? { maxRetries: 0, timeoutMs: CHECK_TIMEOUT_MS, maxTokens: 64 } : {}),
      });
    }
    return new OpenAICompatibleProvider({ baseURL: c.baseURL, apiKey: key, model: c.model, fetch: opts.fetch, supportsImages: c.supportsImages, ...(check ? { timeoutMs: CHECK_TIMEOUT_MS } : {}) });
  }
  /** Throws the plain-words AIError when the server does not answer; returns whether it took a picture. A cut-off
   * reply (connection_truncated) counts as an answer. So does busy or out of quota (connection_busy), which proves
   * the address, key and model are real; the picture is then not tried and counts as refused. */
  async function checkConnection(c: CustomConnection, key: string | null): Promise<boolean> {
    const ask = (content: Part[]) => connectionProvider(c, key, true)
      .complete({ system: 'Reply with exactly the word OK.', messages: [{ role: 'user', content }], tools: [], jsonOnly: true })
      .then(() => 'answered' as const, (e) => {
        if (e instanceof AIError && e.code === 'connection_truncated') return 'answered' as const;
        if (e instanceof AIError && e.code === 'connection_busy') return 'busy' as const;
        throw e;
      });
    if ((await ask([{ type: 'text', text: 'Say OK.' }])) === 'busy') return false;
    return (await ask([{ type: 'text', text: 'Say OK.' }, { type: 'image', mime: 'image/png', base64: PIXEL_PNG }]).catch(() => 'refused')) === 'answered';
  }

  async function statusOf(id: ProviderId): Promise<ProviderStatus> {
    const s = await settings();
    switch (id) {
      case 'claude': return { id, connected: !!(await claudeKey()), label: LABELS.claude, detail: s.claudeModel ?? DEFAULT_CLAUDE_MODEL };
      case 'claude-cli': {
        // detail is the CLI version at most: never the account (no e-mail, no organization)
        const lc = await localClaude();
        return {
          id, connected: lc.state === 'ready', label: LABELS['claude-cli'], ...(lc.version ? { detail: lc.version } : {}),
          ...(lc.state === 'ready' ? {} : { error: { code: `claude_code_${lc.state}`, userMessage: lc.reason ?? 'Your Claude Code app is not ready.' } }),
        };
      }
      case 'custom': {
        const c = activeConnection(s);
        if (!c) return { id, connected: false, label: LABELS.custom };
        const base = { id, label: c.label, detail: c.model, connectionId: c.id };
        const key = await readSecret(connectionSecret(c.id));
        if (!key && hasSecret(connectionSecret(c.id))) {
          return { ...base, connected: false, error: { code: 'connection_key_unreadable', userMessage: `I could not read the saved key for ${c.label}. Edit the connection and paste the key again.` } };
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
    // the person's own CLIs are always listed, in their real state (the Connect screen shows how to get them ready)
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

  async function modelProvider(): Promise<ModelProvider | null> {
    if (opts.providerOverride) return opts.providerOverride;
    const st = await active();
    const s = await settings();
    switch (st.id) {
      case 'claude': return new AnthropicProvider({ apiKey: (await claudeKey())!, model: s.claudeModel, baseURL: opts.anthropicBaseURL, fetch: opts.fetch });
      case 'claude-cli': {
        const bin = (await localClaude()).bin;
        // one live `claude` process per run (providers/cli.ts): ~2.5 s less per model turn
        return new ClaudeCliProvider({ model: s.cliModel, session: true, env: env(), ...(bin ? { bin } : {}) });
      }
      case 'codex-cli': {
        const bin = (await localCodex()).bin;
        return new CodexCliProvider({ model: s.codexModel, env: env(), ...(bin ? { bin } : {}) });
      }
      case 'custom':
        // read the address and its key together, never halfway through a save that changes both
        return oneAtATime(async () => {
          const c = activeConnection(await settings());
          if (!c) throw new AIError('no_ai', 'That connection is no longer saved. Pick your AI editor again in Settings.');
          return connectionProvider(c, await readSecret(connectionSecret(c.id)));
        });
      case 'replay': return new ReplayProvider((s.replayFixture ?? process.env.REELSTUDIO_REPLAY)!);
      default: return null;
    }
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
      try { await writeSecret(secret, key, 'This computer has no safe place to keep that key, so I did not save it.'); } catch (e) { return fail(e); }
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
    const key = q.key?.trim() || (saved && sameOrigin(saved.baseURL, q.baseURL) ? await readSecret(connectionSecret(saved.id)) : null);
    const { models, keyRefused } = await listConnectionModels(q.kind, q.baseURL, key, { fetch: opts.fetch }).catch(() => ({ models: [], keyRefused: false }));
    return { models, suggested: suggestedModel(models), needsKey: q.kind === 'anthropic' || keyRefused };
  }

  return {
    providers,
    active,
    async setActive(id: ProviderId, connectionId?: string): Promise<void> {
      if (id === 'custom') {
        const s = await settings();
        const c = connectionId ? s.connections?.find((x) => x.id === connectionId) : activeConnection(s);
        if (!c) throw new AIError('not_available', 'That connection is no longer saved.');
        await saveSettings({ active: 'custom', activeConnection: c.id });
        return;
      }
      if (id === 'claude-cli') {
        const lc = await localClaude(true);
        if (lc.state !== 'ready') throw new AIError('not_available', lc.reason ?? 'Your Claude Code app is not ready.');
      } else if (id === 'codex-cli') {
        const lc = await localCodex(true);
        if (lc.state !== 'ready') throw new AIError('not_available', lc.reason ?? 'Your Codex app is not ready.');
        await saveSettings({ active: id, chatgptMoved: undefined });
        return;
      } else if (!opts.dev && !PEOPLE_PROVIDERS.includes(id)) {
        throw new AIError('not_available', 'That option is not available.');
      }
      await saveSettings({ active: id, ...(id === 'claude-cli' ? { chatgptMoved: undefined } : {}) });
    },
    /** A fresh look at the person's own Claude Code app: state, version, plan kind and the binary path (for the
     * app's sign-in window). Never an e-mail, organization or token. */
    async claudeCodeStatus(): Promise<LocalClaude> { return localClaude(true); },
    /** A fresh look at the person's own Codex app: state, version, kind of sign-in and the binary path (for the app's
     * sign-in). Never an e-mail, a key or a token. `chatgptMoved`: the old in-app sign-in was retired on upgrade. */
    async codexStatus(): Promise<LocalCodex & { chatgptMoved?: boolean }> {
      const v = await localCodex(true);
      return { ...v, ...((await settings()).chatgptMoved ? { chatgptMoved: true } : {}) };
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
        const err = e instanceof AIError ? e : new AIError('claude_error', 'I could not check that key. Try again.');
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
    /** One tiny request through the active provider (Settings "Test connection"). Throws AIError with a userMessage. */
    async testConnection(signal?: AbortSignal): Promise<{ provider: ProviderId | 'fake'; model?: string; reply: string }> {
      const p = await modelProvider();
      if (!p) throw new AIError('no_ai', 'No AI is connected yet. Connect Claude or ChatGPT in Settings.');
      const r = await p.complete({ system: 'Reply with exactly the word OK.', messages: [{ role: 'user', content: [{ type: 'text', text: 'Say OK.' }] }], tools: [], jsonOnly: true, signal });
      return { provider: p.id, model: p.model, reply: r.text.trim() };
    },
    async firstEdit(projectDir: string, onEvent: (e: AgentEvent) => void, signal?: AbortSignal): Promise<AgentResult & { notice?: any }> {
      return exclusive(projectDir, async () => editor.firstEdit(deps(), await modelProvider(), projectDir, onEvent, signal));
    },
    async applyNote(projectDir: string, note: string, onEvent: (e: AgentEvent) => void, signal?: AbortSignal, opts?: editor.ApplyNoteOptions): Promise<AgentResult> {
      return exclusive(projectDir, async () => editor.applyNote(deps(), await modelProvider(), projectDir, note, onEvent, signal, opts));
    },
    async writeScript(idea: string, onEvent: (e: AgentEvent) => void, signal?: AbortSignal): Promise<ScriptResult> {
      return editor.writeScript(deps(), await modelProvider(), idea, onEvent, signal);
    },
    async styleRules() { return style.list(); },
    async removeStyleRule(id: string) { return style.remove(id); },
    /** The user said Yes to a proposed rule (AgentResult.styleSuggestions). Returns the saved rule. */
    async addStyleRule(text: string) { return (await style.add(text)).rule; },
    /** My style started over because its file was damaged; the damaged copy is kept next to it. */
    async styleWasDamaged() { return style.wasDamaged(); },
    /** My style: the user edited a rule's words, or paused or resumed it. */
    async updateStyleRule(id: string, patch: { text?: string; paused?: boolean }) { return style.update(id, patch); },
  };
}

export type ReelStudioAI = ReturnType<typeof createAI>;

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
