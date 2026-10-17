// @reelstudio/ai: providers, prompts, tools and the editor agent loop (docs/architecture.md sections 6 and 8).
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import {
  AgentEvent, AgentResult, AIError, EngineHost, ModelProvider, ProviderId, ProviderStatus, ScriptResult, SecretStore,
} from './types';
import { Prompts, defaultPromptsDir } from './prompts';
import { StyleStore } from './style';
import { writeFileAtomic } from './project';
import { AnthropicProvider, DEFAULT_CLAUDE_MODEL } from './providers/anthropic';
import { SiwcAuth } from './providers/siwc';
import { OpenAIResponsesProvider, listChatGPTModels } from './providers/openai';
import { ClaudeCliProvider, CodexCliProvider } from './providers/cli';
import { ReplayProvider } from './providers/replay';
import { detectLocalClaude, LocalClaude, Runner } from './providers/localClaude';
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
export { detectLocalClaude, findClaude } from './providers/localClaude';
export type { LocalClaude } from './providers/localClaude';
export { pickTakes, formatForPicking, deterministicEdit } from './editor';

export interface AISettings {
  active?: ProviderId;
  claudeModel?: string;
  chatgptModel?: string;
  cliModel?: string;
  replayFixture?: string;
}

export interface CreateAIOptions {
  host: EngineHost;
  settingsDir: string;
  dev?: boolean;
  /** Local Claude Code build: offer "Claude Code on this computer" (the logged-in `claude` CLI) when it is
   * installed and signed in. Default false; the public build leaves it off. Independent of `dev`. */
  allowLocalClaudeCode?: boolean;
  /** test hook: how `claude` is found and run for detection */
  localClaude?: { run?: Runner; bin?: string | null };
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

const LABELS: Record<ProviderId, string> = {
  chatgpt: 'ChatGPT', claude: 'Claude', 'codex-cli': 'Codex CLI (dev)', 'claude-cli': 'Claude CLI (dev)', replay: 'Replay (dev)', none: 'No AI',
};

const LOCAL_CLAUDE_LABEL = 'Claude Code on this computer';
const LOCAL_CLAUDE_TTL_MS = 60_000;

export function createAI(opts: CreateAIOptions) {
  // claude-cli is selectable in dev builds, or (labelled for people) when local Claude Code is allowed
  const cliClaudeAllowed = (): boolean => !!opts.dev || !!opts.allowLocalClaudeCode;
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

  // ---- Claude key (secret)
  const keyEnc = path.join(opts.settingsDir, 'claude-key.bin');
  const keyPlain = path.join(opts.settingsDir, 'claude-key.txt');
  async function claudeKey(): Promise<string | null> {
    try {
      if (fs.existsSync(keyEnc) && opts.secretStore) return opts.secretStore.decryptString(await fsp.readFile(keyEnc));
      if (opts.allowPlaintextSecrets && fs.existsSync(keyPlain)) return (await fsp.readFile(keyPlain, 'utf8')).trim() || null;
    } catch { /* unreadable */ }
    return null;
  }
  async function storeClaudeKey(key: string | null): Promise<void> {
    await fsp.rm(keyEnc, { force: true }); await fsp.rm(keyPlain, { force: true });
    if (!key) return;
    if (opts.secretStore?.isEncryptionAvailable()) await writeFileAtomic(keyEnc, opts.secretStore.encryptString(key), 0o600);
    else if (opts.allowPlaintextSecrets) await writeFileAtomic(keyPlain, key, 0o600);
    else throw new AIError('no_secure_storage', 'This computer has no safe place to keep your Claude key, so I did not save it. Add it from the Reel Studio app.');
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
        if (!opts.allowLocalClaudeCode) return { id, connected: true, label: LABELS['claude-cli'], detail: s.cliModel ?? 'sonnet' };
        const lc = await localClaude();
        return {
          id, connected: lc.installed && lc.loggedIn, label: LOCAL_CLAUDE_LABEL, detail: lc.account ?? lc.version,
          ...(lc.installed && lc.loggedIn ? {} : { error: { code: lc.installed ? 'claude_code_signed_out' : 'claude_code_missing', userMessage: lc.reason ?? 'Claude Code is not ready.' } }),
        };
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
    let ids: ProviderId[] = ['chatgpt', 'claude', ...(opts.dev ? (['claude-cli', 'codex-cli', 'replay'] as ProviderId[]) : []), 'none'];
    if (opts.allowLocalClaudeCode && !opts.dev) {
      // only offered when Claude Code is actually installed here (signed out: listed, with how to fix it)
      const lc = await localClaude(true);
      if (lc.installed) ids = ['chatgpt', 'claude', 'claude-cli', 'none'];
    }
    return Promise.all(ids.map(statusOf));
  }

  async function active(): Promise<ProviderStatus> {
    const s = await settings();
    if (s.active && s.active !== 'none' && (opts.dev || ['chatgpt', 'claude'].includes(s.active) || (s.active === 'claude-cli' && cliClaudeAllowed()))) {
      const st = await statusOf(s.active);
      if (st.connected) return st;
    }
    if (s.active === 'none') return statusOf('none');
    // Several connected and none chosen: Claude first (the provider that measured best in testing).
    for (const id of ['claude', 'chatgpt'] as ProviderId[]) {
      const st = await statusOf(id);
      if (st.connected) return st;
    }
    if (opts.allowLocalClaudeCode) {          // nothing else connected: use Claude Code if it is ready
      const st = await statusOf('claude-cli');
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
        const bin = opts.allowLocalClaudeCode ? (await localClaude()).bin : undefined;
        // one live `claude` process per run (providers/cli.ts): ~2.5 s less per model turn
        return new ClaudeCliProvider({ model: s.cliModel, session: true, ...(bin ? { bin } : {}) });
      }
      case 'codex-cli': return new CodexCliProvider({ model: s.cliModel });
      case 'replay': return new ReplayProvider((s.replayFixture ?? process.env.REELSTUDIO_REPLAY)!);
      default: return null;
    }
  }

  return {
    providers,
    active,
    async setActive(id: ProviderId): Promise<void> {
      if (id === 'claude-cli' && opts.allowLocalClaudeCode && !opts.dev) {
        const lc = await localClaude(true);
        if (!lc.installed || !lc.loggedIn) throw new AIError('not_available', lc.reason ?? 'Claude Code is not ready on this computer.');
      } else if (!opts.dev && !['chatgpt', 'claude', 'none'].includes(id)) {
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
    async applyNote(projectDir: string, note: string, onEvent: (e: AgentEvent) => void, signal?: AbortSignal): Promise<AgentResult> {
      return exclusive(projectDir, async () => editor.applyNote(deps(), await modelProvider(), projectDir, note, onEvent, signal));
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
