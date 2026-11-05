// CLIProxyAPI: one server on the person's computer that pools their Claude and ChatGPT accounts behind an OpenAI and an
// Anthropic endpoint. This file asks it which models it offers, which accounts it pools and how much each has left,
// and builds the provider for one model. A Claude model goes through its Anthropic Messages endpoint and anything else
// through Chat Completions; CLIProxyAPI takes the same client key on both (Authorization: Bearer or x-api-key).
import { AIError, type LimitWindow, type ModelProvider } from '../types';
import { AnthropicProvider } from './anthropic';
import { OpenAICompatibleProvider } from './openaiCompatible';
import { noRedirectFetch } from './connection';
import { nameFromId } from './limits';

export type { LimitWindow };

export const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;
export type Effort = (typeof EFFORTS)[number];
export type ModelFamily = 'claude' | 'gpt' | 'gemini' | 'grok' | 'other';

export interface HubModel {
  id: string;
  /** the server's own display name ("Claude Opus 5.5"), else one made from the id */
  name: string;
  family: ModelFamily;
  /** reasoning levels the model takes, lowest first; empty when it has none */
  efforts: Effort[];
  defaultEffort?: Effort;
  images: boolean;
}

export interface HubAccount {
  /** the hub's id for the account (its auth file name) */
  id: string;
  provider: 'claude' | 'codex';
  /** the account's e-mail, or its label when the hub has none */
  name: string;
  plan?: string;
  windows: LimitWindow[];
  /** the hub is resting this account after a limit, until then */
  restingUntil?: string;
  /** set when the hub could not read this account's limits */
  problem?: string;
}

/** CLIProxyAPI's suffix for a reasoning level: `gpt-6.1-sol(high)`. It reads it on every endpoint and it wins over any
 * level in the request body (internal/thinking/suffix.go). The app stores a choice the same way. */
const SUFFIX = new RegExp(`^(.+)\\((${EFFORTS.join('|')})\\)$`);
export function splitModel(choice: string): { model: string; effort?: Effort } {
  const m = SUFFIX.exec(choice);
  return m ? { model: m[1], effort: m[2] as Effort } : { model: choice };
}
export const joinModel = (model: string, effort?: string | null): string => (effort ? `${model}(${effort})` : model);

export function familyOf(id: string, ownedBy?: string): ModelFamily {
  const o = (ownedBy ?? '').toLowerCase();
  const bare = id.slice(id.lastIndexOf('/') + 1).toLowerCase();
  if (o === 'anthropic' || bare.startsWith('claude')) return 'claude';
  if (o === 'openai' || /^(gpt|o\d|codex|chatgpt)/.test(bare)) return 'gpt';
  if (o === 'google' || bare.startsWith('gemini')) return 'gemini';
  if (o === 'xai' || bare.startsWith('grok')) return 'grok';
  return 'other';
}

const TIMEOUT_MS = 10_000;
/** Any client_version makes CLIProxyAPI answer /v1/models with its Codex catalog, which carries display names,
 * reasoning levels and which models it hides (internal/client/codex/models/models.go). */
const CATALOG_QUERY = '?client_version=0.163.0';

async function getJson(fetchImpl: typeof fetch, url: string, headers: Record<string, string>, init: { method?: string; body?: string } = {}): Promise<{ status: number; json: any }> {
  const res = await noRedirectFetch(fetchImpl)(url, { method: init.method ?? 'GET', headers, body: init.body, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const text = await res.text().catch(() => '');
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json };
}

/**
 * Every model the hub offers, in the hub's own order (its catalog's priority, else its list order). Models the hub
 * hides (image models, its review helper) are left out. Throws AIError hub_key when the key is refused.
 */
export async function hubModels(origin: string, key: string | null, opts: { fetch?: typeof fetch } = {}): Promise<HubModel[]> {
  const f = opts.fetch ?? fetch;
  const auth: Record<string, string> = key ? { authorization: `Bearer ${key}` } : {};
  let list: { status: number; json: any };
  try { list = await getJson(f, `${origin}/v1/models`, auth); } catch (e: any) {
    throw new AIError('hub_unreachable', 'CLIProxyAPI is not answering. Check that it is running.', { retryable: true, detail: String(e?.message ?? e) });
  }
  if (list.status === 401 || list.status === 403) throw new AIError('hub_key', 'CLIProxyAPI did not accept that key. Use one from api-keys in its config.', { status: list.status });
  if (list.status !== 200 || !Array.isArray(list.json?.data)) throw new AIError('hub_wrong', 'That address answered, but not like CLIProxyAPI.', { status: list.status });
  const owned = new Map<string, string>();
  for (const m of list.json.data) if (typeof m?.id === 'string') owned.set(m.id, String(m.owned_by ?? ''));

  // The catalog is optional: an older hub, or one that fails it, still lists its models by id.
  const catalog = new Map<string, any>();
  try {
    const c = await getJson(f, `${origin}/v1/models${CATALOG_QUERY}`, auth);
    if (c.status === 200 && Array.isArray(c.json?.models)) for (const m of c.json.models) if (typeof m?.slug === 'string') catalog.set(m.slug, m);
  } catch { /* names come from the ids */ }

  const out: (HubModel & { order: number })[] = [];
  let i = 0;
  for (const [id, ownedBy] of owned) {
    const c = catalog.get(id);
    i++;
    if (c?.visibility === 'hide') continue;
    const efforts = Array.isArray(c?.supported_reasoning_levels)
      ? EFFORTS.filter((e) => c.supported_reasoning_levels.some((l: any) => l?.effort === e))
      : [];
    const def = EFFORTS.find((e) => e === c?.default_reasoning_level);
    out.push({
      id,
      name: typeof c?.display_name === 'string' && c.display_name.trim() ? c.display_name.trim() : nameFromId(id),
      family: familyOf(id, ownedBy),
      efforts,
      ...(def && efforts.includes(def) ? { defaultEffort: def } : {}),
      // unknown is no: without the catalog's word, a model is sent no pictures
      images: Array.isArray(c?.input_modalities) && c.input_modalities.includes('image'),
      order: typeof c?.priority === 'number' ? c.priority : 100_000 + i,
    });
  }
  return out.sort((a, b) => a.order - b.order).map(({ order: _o, ...m }) => m);
}

/** Whether `choice`'s model takes pictures, as the hub's catalog says. A model the list doesn't have, or no list at
 * all, takes none: a text-only model must never be sent one. */
export function hubImages(models: HubModel[] | null, choice: string): boolean {
  const { model } = splitModel(choice);
  return !!models?.find((m) => m.id === model)?.images;
}

/** A CLIProxyAPI address the app found must be this computer: a literal loopback address, so nothing resolves it
 * again on the way. Anything else is refused before a key is sent. */
export function loopbackOrigin(origin: string): boolean {
  let host: string;
  try { host = new URL(origin).hostname; } catch { return false; }
  return /^127(\.\d{1,3}){3}$/.test(host) || host === '[::1]';
}

/** The provider for one model on the hub. `choice` may carry a reasoning level (`claude-opus-5-5(high)`), which goes
 * to the hub as it is. */
export function hubProvider(o: { origin: string; key: string; choice: string; supportsImages: boolean; fetch?: typeof fetch; check?: boolean }): ModelProvider {
  const { model, effort } = splitModel(o.choice);
  const quick = o.check ? { timeoutMs: 30_000 } : {};
  if (familyOf(model) === 'claude') {
    // no SDK retries: the hub already moves to another account, and the agent loop retries what is worth retrying
    return new AnthropicProvider({ id: 'custom', apiKey: o.key, model: o.choice, effort, baseURL: o.origin, fetch: noRedirectFetch(o.fetch), supportsImages: o.supportsImages, maxRetries: 0, ...(o.check ? { maxTokens: 64, ...quick } : {}) });
  }
  return new OpenAICompatibleProvider({ baseURL: `${o.origin}/v1`, apiKey: o.key, model: o.choice, effort, fetch: o.fetch, supportsImages: o.supportsImages, ...quick });
}

// ---- accounts and limits, through the management API (needs its management key)

const CLAUDE_USAGE = 'https://api.anthropic.com/api/oauth/usage';
const CODEX_USAGE = 'https://chatgpt.com/backend-api/wham/usage';

/** ChatGPT plan ids as Codex and the hub report them (T3 Code's codexPlanLabel lists the same). */
export function chatgptPlanLabel(id: unknown): string | undefined {
  if (typeof id !== 'string' || !id) return undefined;
  const k = id.toLowerCase();
  const known: Record<string, string> = { free: 'Free', go: 'Go', plus: 'Plus', pro: 'Pro', prolite: 'Pro 5x', promax: 'Pro Max', team: 'Team', business: 'Business', enterprise: 'Enterprise', edu: 'Edu' };
  if (known[k]) return known[k];
  if (k.includes('business')) return 'Business';
  if (k.startsWith('ent')) return 'Enterprise';
  if (k.startsWith('edu')) return 'Edu';
  return undefined;
}

/** Claude plan kinds as Claude Code reports them (`subscriptionType`). */
export function claudePlanLabel(id: unknown): string | undefined {
  if (typeof id !== 'string' || !id) return undefined;
  const k = id.toLowerCase().replace(/^claude|subscription$|plan$/g, '');
  const known: Record<string, string> = { max: 'Max', max5x: 'Max 5x', max5: 'Max 5x', max20x: 'Max 20x', max20: 'Max 20x', pro: 'Pro', team: 'Team', enterprise: 'Enterprise', free: 'Free' };
  return known[k];
}

const clampLeft = (used: number): number => Math.max(0, Math.min(100, Math.round(100 - used)));
const isoFromEpoch = (s: unknown): string | undefined => (typeof s === 'number' && s > 0 ? new Date(s * 1000).toISOString() : undefined);
const isoFrom = (s: unknown): string | undefined => {
  if (typeof s !== 'string' || !s) return undefined;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
};

/** Anthropic's usage answer for a Claude subscription: five_hour and seven_day carry `utilization` (percent used). */
export function claudeWindows(u: any): LimitWindow[] {
  const out: LimitWindow[] = [];
  const add = (label: string, w: any) => {
    if (w && typeof w.utilization === 'number') out.push({ label, left: clampLeft(w.utilization), ...(isoFrom(w.resets_at) ? { resetsAt: isoFrom(w.resets_at) } : {}) });
  };
  add('5-hour', u?.five_hour);
  add('Weekly', u?.seven_day);
  for (const l of Array.isArray(u?.limits) ? u.limits : []) {
    if (l?.kind === 'weekly_scoped' && typeof l.percent === 'number' && typeof l.scope?.model?.display_name === 'string') {
      out.push({ label: `Weekly · ${l.scope.model.display_name}`, left: clampLeft(l.percent), ...(isoFrom(l.resets_at) ? { resetsAt: isoFrom(l.resets_at) } : {}) });
    }
  }
  return out;
}

/** ChatGPT's usage answer: rate_limit.primary_window and secondary_window with used_percent and reset_at (epoch s). */
export function codexWindows(u: any): LimitWindow[] {
  const out: LimitWindow[] = [];
  const plan = String(u?.plan_type ?? '').toLowerCase();
  const add = (w: any, fallback: string) => {
    if (!w || typeof w.used_percent !== 'number') return;
    const mins = typeof w.limit_window_seconds === 'number' ? w.limit_window_seconds / 60 : null;
    out.push({ label: windowLabel(mins, fallback), left: clampLeft(w.used_percent), ...(isoFromEpoch(w.reset_at) ? { resetsAt: isoFromEpoch(w.reset_at) } : {}) });
  };
  add(u?.rate_limit?.primary_window, plan === 'free' || plan === 'go' ? 'Monthly' : '5-hour');
  add(u?.rate_limit?.secondary_window, 'Weekly');
  return out;
}

/** A window's length in minutes → its name; the usual ones by name, others by hours or days. */
export function windowLabel(mins: number | null | undefined, fallback: string): string {
  if (!mins) return fallback;
  if (Math.abs(mins - 300) < 5) return '5-hour';
  if (Math.abs(mins - 10_080) < 60) return 'Weekly';
  if (mins >= 40_000) return 'Monthly';
  return mins < 1440 ? `${Math.round(mins / 60)}-hour` : `${Math.round(mins / 1440)}-day`;
}

/**
 * Plain words for a management API refusal. Its body is read only to tell the cases apart and never copied into the
 * error: a hub may echo the key it was sent, and the error's detail goes to the app's log. The detail is the status.
 */
function managementError(status: number, json: any): AIError {
  const said = String(json?.error ?? '');
  const detail = `management API answered ${status}`;
  if (status === 401) return new AIError('hub_management_key', 'CLIProxyAPI did not accept that management key. Use the secret-key you set under remote-management in its config.', { status, detail });
  if (status === 404 || /key not set|disabled/i.test(said)) {
    return new AIError('hub_management_off', 'CLIProxyAPI’s management API is off. Set remote-management secret-key in its config, restart it, then add that key here.', { status, detail });
  }
  if (status === 403 && /banned/i.test(said)) return new AIError('hub_management_banned', 'CLIProxyAPI is refusing management requests for a while after several wrong keys. Try again in 30 minutes.', { status, detail });
  return new AIError('hub_management', 'CLIProxyAPI could not list its accounts.', { status, detail });
}

/**
 * The accounts the hub pools and what each has left. One management call lists them; each Claude and ChatGPT account's
 * limits come from its provider's usage page, fetched by the hub with that account's own sign-in (the hub fills in
 * $TOKEN$; this app never sees it). Four accounts are read at a time. One account that cannot be read keeps its row,
 * with `problem` set.
 */
export async function hubAccounts(origin: string, managementKey: string, opts: { fetch?: typeof fetch } = {}): Promise<HubAccount[]> {
  const f = opts.fetch ?? fetch;
  const headers = { authorization: `Bearer ${managementKey}`, 'content-type': 'application/json' };
  let listed: { status: number; json: any };
  try { listed = await getJson(f, `${origin}/v0/management/auth-files`, headers); } catch (e: any) {
    throw new AIError('hub_unreachable', 'CLIProxyAPI is not answering. Check that it is running.', { retryable: true, detail: String(e?.message ?? e) });
  }
  if (listed.status !== 200) throw managementError(listed.status, listed.json);
  const files: any[] = Array.isArray(listed.json?.files) ? listed.json.files : [];
  const wanted = files.filter((a) => (a?.provider === 'claude' || a?.provider === 'codex') && !a.disabled && typeof a.auth_index === 'string');

  const read = async (a: any): Promise<HubAccount> => {
    const provider: HubAccount['provider'] = a.provider;
    const base: HubAccount = {
      id: String(a.id ?? a.name ?? a.auth_index),
      provider,
      name: String(a.email || a.label || a.name || a.id),
      windows: [],
      ...(isoFrom(a.next_retry_after) && Date.parse(a.next_retry_after) > Date.now() ? { restingUntil: isoFrom(a.next_retry_after) } : {}),
    };
    const plan = provider === 'codex' ? chatgptPlanLabel(a.id_token?.plan_type ?? a.id_token?.chatgpt_plan_type) : claudePlanLabel(a.account_type);
    if (plan) base.plan = plan;
    const header = provider === 'codex'
      ? { Authorization: 'Bearer $TOKEN$', 'Content-Type': 'application/json', 'OpenAI-Beta': 'codex-1', Originator: 'Codex Desktop', ...(a.id_token?.chatgpt_account_id ? { 'Chatgpt-Account-Id': String(a.id_token.chatgpt_account_id) } : {}) }
      : { Authorization: 'Bearer $TOKEN$', 'anthropic-beta': 'oauth-2025-04-20' };
    try {
      const r = await getJson(f, `${origin}/v0/management/api-call`, headers, {
        method: 'POST',
        body: JSON.stringify({ auth_index: a.auth_index, method: 'GET', url: provider === 'codex' ? CODEX_USAGE : CLAUDE_USAGE, header }),
      });
      if (r.status !== 200 || typeof r.json?.status_code !== 'number') throw new Error(`api-call ${r.status}`);
      if (r.json.status_code < 200 || r.json.status_code >= 300) throw new Error(`provider ${r.json.status_code}`);
      const usage = JSON.parse(String(r.json.body ?? 'null'));
      base.windows = provider === 'codex' ? codexWindows(usage) : claudeWindows(usage);
      if (provider === 'codex' && chatgptPlanLabel(usage?.plan_type)) base.plan = chatgptPlanLabel(usage.plan_type);
      if (!base.windows.length) base.problem = 'No limits reported.';
    } catch {
      base.problem = 'Couldn’t read this account’s limits.';
    }
    return base;
  };

  const out: HubAccount[] = new Array(wanted.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, wanted.length) }, async () => {
    while (next < wanted.length) { const i = next++; out[i] = await read(wanted[i]); }
  }));
  return out;
}

const FAMILY_NAME: Record<ModelFamily, string> = { claude: 'Claude', gpt: 'ChatGPT', gemini: 'Gemini', grok: 'Grok', other: 'Other' };
export const familyName = (f: ModelFamily): string => FAMILY_NAME[f];
