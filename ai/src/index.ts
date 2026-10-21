// @reelstudio/ai: providers, prompts, tools and the editor agent loop (docs/architecture.md sections 6 and 8).
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  AgentEvent, AgentResult, AIError, EngineHost, ModelProvider, ProviderId, ProviderStatus, ScriptResult, SecretStore, UserFacingError,
} from './types';
import { Prompts, defaultPromptsDir } from './prompts';
import { StyleStore } from './style';
import { writeFileAtomic } from './project';
import { AnthropicProvider, DEFAULT_CLAUDE_MODEL } from './providers/anthropic';
import { SiwcAuth } from './providers/siwc';
import { OpenAIResponsesProvider, listChatGPTModels } from './providers/openai';
import { ClaudeCliProvider, CodexCliProvider } from './providers/cli';
import { ReplayProvider } from './providers/replay';
import { CONNECTION_KINDS, ConnectionKind, listConnectionModels, noRedirectFetch, normalizeBaseURL, suggestedModel } from './providers/connection';
import { OpenAICompatibleProvider } from './providers/openaiCompatible';
import { detectLocalClaude, DetectOptions, LocalClaude } from './providers/localClaude';
import * as editor from './editor';

export * from './types';
export * from './project';
export { TOOLS, TOOL_NAMES, toolSchemas, executeTool, newToolState } from './tools';
export type { ToolContext, ToolDef } from './tools';
export { runAgent } from './agent';
export { Prompts } from './prompts';
export { StyleStore } from './style';
export { AnthropicProvider, DEFAULT_CLAUDE_MODEL } from './providers/anthropic';
export { SiwcAuth, USAGE_URL } from './providers/siwc';
export { OpenAIResponsesProvider, listChatGPTModels, mapResponsesError } from './providers/openai';
export { ClaudeCliProvider, CodexCliProvider } from './providers/cli';
export { ReplayProvider, RecordingProvider } from './providers/replay';
export { OpenAICompatibleProvider } from './providers/openaiCompatible';
export type { ConnectionKind } from './providers/connection';
export { detectLocalClaude, findClaude, claudeCandidates, claudeFromLoginShell, CLAUDE_CODE_MESSAGES } from './providers/localClaude';
export type { LocalClaude, ClaudeCodeState } from './providers/localClaude';
export { pickTakes, formatForPicking, deterministicEdit } from './editor';
export type { ApplyNoteOptions } from './editor';
export { ATTACHMENT_REF, MAX_ATTACHMENTS_PER_NOTE, readAttachment, listAttachments, validateAttachments, placedAssets } from './attachments';
export type { AttachmentInfo } from './attachments';

export interface AISettings {
  active?: ProviderId;
  claudeModel?: string;
  chatgptModel?: string;
  cliModel?: string;
  replayFixture?: string;
  /** each connection's key is its own encrypted file, never in here */
  connections?: CustomConnection[];
  activeConnection?: string;
}

export interface CustomConnection { id: string; label: string; kind: ConnectionKind; baseURL: string; model: string }
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
  siwcIssuer?: string;
  openaiBaseURL?: string;
  anthropicBaseURL?: string;
  /** Force a specific model provider (tests). */
  providerOverride?: ModelProvider;
  finalRender?: boolean;
  maxSteps?: number;
}

// claude-cli = the person's own Claude Code app, offered to everyone. It is never called "Claude Code" on its own:
// Reel Studio is not Claude Code, it uses the Claude Code app the person signed in to themselves.
export const CLAUDE_CODE_LABEL = 'Claude (your Claude Code app)';
const LABELS: Record<ProviderId, string> = {
  chatgpt: 'ChatGPT', claude: 'Claude', 'codex-cli': 'Codex CLI (dev)', 'claude-cli': CLAUDE_CODE_LABEL, custom: 'Your own server', replay: 'Replay (dev)', none: 'No AI',
};
const PEOPLE_PROVIDERS: ProviderId[] = ['chatgpt', 'claude', 'claude-cli', 'custom', 'none'];

const LOCAL_CLAUDE_TTL_MS = 60_000;

export function createAI(opts: CreateAIOptions) {
  let localCache: { at: number; v: LocalClaude } | null = null;
  async function localClaude(fresh = false): Promise<LocalClaude> {
    if (!fresh && localCache && Date.now() - localCache.at < LOCAL_CLAUDE_TTL_MS) return localCache.v;
    const v = await detectLocalClaude(opts.localClaude ?? {});
    localCache = { at: Date.now(), v };
    return v;
  }
  const settingsFile = path.join(opts.settingsDir, 'ai-settings.json');
  const prompts = new Prompts(opts.promptsDir ?? defaultPromptsDir());
  const style = new StyleStore(() => opts.host.reelStudioRoot());
  const siwc = new SiwcAuth({ settingsDir: opts.settingsDir, secretStore: opts.secretStore, fetch: opts.fetch, issuer: opts.siwcIssuer, allowPlaintextSecrets: opts.allowPlaintextSecrets });
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
    if (opts.secretStore?.isEncryptionAvailable()) {
      await writeFileAtomic(f.enc, opts.secretStore.encryptString(value), 0o600);
      await fsp.rm(f.plain, { force: true });
    } else if (opts.allowPlaintextSecrets) {
      await writeFileAtomic(f.plain, value, 0o600);
      await fsp.rm(f.enc, { force: true });
    } else throw new AIError('no_secure_storage', noStorageMessage);
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
    id: c.id, label: c.label, kind: c.kind, baseURL: c.baseURL, model: c.model,
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
        id: 'custom', apiKey: key!, model: c.model, baseURL: c.baseURL, fetch: noRedirectFetch(opts.fetch),
        ...(check ? { maxRetries: 0, timeoutMs: CHECK_TIMEOUT_MS, maxTokens: 64 } : {}),
      });
    }
    return new OpenAICompatibleProvider({ baseURL: c.baseURL, apiKey: key, model: c.model, fetch: opts.fetch, ...(check ? { timeoutMs: CHECK_TIMEOUT_MS } : {}) });
  }
  async function checkConnection(c: CustomConnection, key: string | null): Promise<void> {
    try {
      await connectionProvider(c, key, true).complete({ system: 'Reply with exactly the word OK.', messages: [{ role: 'user', content: [{ type: 'text', text: 'Say OK.' }] }], tools: [], jsonOnly: true });
    } catch (e: any) {
      // it answered and ran out of room on a one-word reply: the address, key and model all work
      if (e instanceof AIError && e.code === 'connection_truncated') return;
      throw e;
    }
  }

  async function statusOf(id: ProviderId): Promise<ProviderStatus> {
    const s = await settings();
    switch (id) {
      case 'chatgpt': {
        const sess = await siwc.session();
        if (sess.connected && !sess.planUsage) {
          return { id, connected: false, label: LABELS.chatgpt, detail: sess.email, error: { code: 'chatgpt_plan_not_enabled', userMessage: 'You are signed in, but Reel Studio was not allowed to use your ChatGPT plan. Sign in again and allow it.' } };
        }
        return { id, connected: sess.connected && sess.planUsage, label: LABELS.chatgpt, detail: sess.email };
      }
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
      case 'codex-cli': return { id, connected: true, label: LABELS['codex-cli'], detail: s.cliModel };
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
    const ids: ProviderId[] = ['chatgpt', 'claude', 'claude-cli', ...custom, ...(opts.dev ? (['codex-cli', 'replay'] as ProviderId[]) : []), 'none'];
    await localClaude(true);
    return Promise.all(ids.map(statusOf));
  }

  async function active(): Promise<ProviderStatus> {
    const s = await settings();
    if (s.active && s.active !== 'none' && (opts.dev || PEOPLE_PROVIDERS.includes(s.active))) {
      const st = await statusOf(s.active);
      if (st.connected) return st;
    }
    if (s.active === 'none') return statusOf('none');
    // Several connected and none chosen: Claude first (the provider that measured best in testing).
    // Never falls back to claude-cli: it spends the person's own Claude plan, so only their click turns it on.
    for (const id of ['claude', 'chatgpt'] as ProviderId[]) {
      const st = await statusOf(id);
      if (st.connected) return st;
    }
    return statusOf('none');
  }

  async function chatgptModel(): Promise<string> {
    const s = await settings();
    if (s.chatgptModel) return s.chatgptModel;
    const models = await listChatGPTModels(siwc, { baseURL: opts.openaiBaseURL, fetch: opts.fetch });
    if (!models.length) throw new AIError('chatgpt_no_models', 'Your ChatGPT account has no models available for Reel Studio.');
    return models[0].slug;
  }

  async function modelProvider(): Promise<ModelProvider | null> {
    if (opts.providerOverride) return opts.providerOverride;
    const st = await active();
    const s = await settings();
    switch (st.id) {
      case 'chatgpt': return new OpenAIResponsesProvider({ auth: siwc, model: await chatgptModel(), baseURL: opts.openaiBaseURL, fetch: opts.fetch });
      case 'claude': return new AnthropicProvider({ apiKey: (await claudeKey())!, model: s.claudeModel, baseURL: opts.anthropicBaseURL, fetch: opts.fetch });
      case 'claude-cli': {
        const bin = (await localClaude()).bin;
        // one live `claude` process per run (providers/cli.ts): ~2.5 s less per model turn
        return new ClaudeCliProvider({ model: s.cliModel, session: true, ...(bin ? { bin } : {}) });
      }
      case 'custom':
        // read the address and its key together, never halfway through a save that changes both
        return oneAtATime(async () => {
          const c = activeConnection(await settings());
          if (!c) throw new AIError('no_ai', 'That connection is no longer saved. Pick your AI editor again in Settings.');
          return connectionProvider(c, await readSecret(connectionSecret(c.id)));
        });
      case 'codex-cli': return new CodexCliProvider({ model: s.cliModel });
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
    const conn: CustomConnection = { id, label, kind: input.kind, baseURL, model };
    try { await checkConnection(conn, key); } catch (e: any) {
      // busy / out of quota still proves the address, key and model are real: keep it
      if (!(e instanceof AIError && e.code === 'connection_busy')) return fail(e);
    }
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
      } else if (!opts.dev && !PEOPLE_PROVIDERS.includes(id)) {
        throw new AIError('not_available', 'That option is not available.');
      }
      await saveSettings({ active: id });
    },
    async signInChatGPT(openExternal: (url: string) => Promise<void>): Promise<ProviderStatus> {
      try {
        const sess = await siwc.signIn(openExternal);
        if (sess.planUsage) await saveSettings({ active: 'chatgpt' });
      } catch (e: any) {
        if (e instanceof AIError) return { id: 'chatgpt', connected: false, label: LABELS.chatgpt, error: e.toJSON() };
        throw e;
      }
      return statusOf('chatgpt');
    },
    cancelSignInChatGPT(): void { siwc.cancelSignIn(); },
    /** A fresh look at the person's own Claude Code app: state, version, plan kind and the binary path (for the
     * app's sign-in window). Never an e-mail, organization or token. */
    async claudeCodeStatus(): Promise<LocalClaude> { return localClaude(true); },
    async signOutChatGPT(): Promise<void> {
      await siwc.signOut();
      const s = await settings();
      if (s.active === 'chatgpt') await saveSettings({ active: undefined });
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
    /** `key` empty with `id` set uses that connection's stored key, which never leaves this process. */
    connectionModels(q: { kind: ConnectionKind; baseURL: string; key?: string; id?: string }): Promise<ConnectionModels> {
      return oneAtATime(() => connectionModels(q));
    },
    async setModel(which: 'claude' | 'chatgpt' | 'cli', model: string | null): Promise<void> {
      await saveSettings({ [`${which}Model`]: model ?? undefined } as Partial<AISettings>);
    },
    async chatgptModels(): Promise<{ slug: string; displayName: string }[]> {
      return listChatGPTModels(siwc, { baseURL: opts.openaiBaseURL, fetch: opts.fetch });
    },
    async setReplayFixture(file: string | null): Promise<void> { await saveSettings({ replayFixture: file ?? undefined }); },
    /** One tiny request through the active provider (Settings "Test connection"). Throws AIError with a userMessage. */
    async testConnection(signal?: AbortSignal): Promise<{ provider: ProviderId | 'fake'; model?: string; reply: string }> {
      const p = await modelProvider();
      if (!p) throw new AIError('no_ai', 'No AI is connected yet. Sign in with ChatGPT or add a Claude key in Settings.');
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
