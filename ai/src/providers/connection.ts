// The person's own AI server ("custom" provider), Anthropic-compatible (Messages) or OpenAI-compatible (Chat
// Completions): address checks, plain-words errors and the model list both kinds share.
import { AIError } from '../types';

export type ConnectionKind = 'anthropic' | 'openai';

export const CONNECTION_KINDS: Record<ConnectionKind, string> = {
  anthropic: 'Anthropic-compatible',
  openai: 'OpenAI-compatible',
};

export interface ConnectionErrorContext { kind: ConnectionKind; model: string }

export function normalizeBaseURL(raw: string): string {
  const text = raw.trim();
  let url: URL;
  try { url = new URL(text); } catch {
    throw new AIError('connection_bad_address', 'That server address is not complete. It should start with http:// or https://, like http://127.0.0.1:4000.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new AIError('connection_bad_address', 'That server address is not complete. It should start with http:// or https://, like http://127.0.0.1:4000.');
  }
  // a user:password@ in the address would be sent with every request and saved in plain text
  if (url.username || url.password) throw new AIError('connection_bad_address', 'Put the key in the Key box, not in the server address.');
  if (url.search || url.hash) throw new AIError('connection_bad_address', 'Remove everything after ? or # from the server address.');
  return url.toString().replace(/\/+$/, '');
}

/** fetch that refuses redirects, so a key is never forwarded to another host (Anthropic's SDK and undici forward
 * custom headers such as x-api-key on a cross-origin redirect). */
export function noRedirectFetch(base: typeof fetch = fetch): typeof fetch {
  return ((input: any, init?: RequestInit) => base(input, { ...init, redirect: 'error' })) as typeof fetch;
}

/** The same error with every copy of `secret` in its diagnostic text replaced: a server that echoes the key in an
 * error ("Incorrect API key provided: ...") must not put it in the app's log. */
export function withoutSecret(e: AIError, secret: string | null | undefined): AIError {
  if (!secret || !e.message.includes(secret)) return e;
  return new AIError(e.code, e.userMessage, { detail: e.message.split(secret).join('[key]'), link: e.link, retryable: e.retryable, status: e.status, requestId: e.requestId });
}

export function unreachable(detail?: string): AIError {
  return new AIError('connection_unreachable', 'Reel Studio could not reach that server. Check the server address and that the server is running.', { retryable: true, detail });
}

export function tookTooLong(detail?: string): AIError {
  return new AIError('connection_timeout', 'The server took too long to answer. Check that it is running, then try again.', { retryable: true, detail });
}

export function wrongAddress(ctx: ConnectionErrorContext, detail?: string, status?: number): AIError {
  const hint = ctx.kind === 'openai'
    ? 'OpenAI-compatible addresses usually end in /v1.'
    : 'Anthropic-compatible addresses usually do not end in /v1.';
  return new AIError('connection_wrong_address', `That address answered, but not like an ${CONNECTION_KINDS[ctx.kind]} server. Check the server address and the kind of server. ${hint}`, { status, detail });
}

function errorText(body: any): string {
  if (!body) return '';
  if (typeof body === 'string') return body;
  const e = body.error ?? body;
  return [e?.message, e?.type, e?.code, e?.param, typeof body.detail === 'string' ? body.detail : ''].filter((x) => typeof x === 'string').join(' ');
}

export function mapConnectionError(status: number | undefined, body: unknown, ctx: ConnectionErrorContext, detail?: string): AIError {
  const text = errorText(body);
  const info = { status, detail: detail ?? `status=${status ?? '?'} ${text.slice(0, 300)}` };
  // "model ... not found / unknown / not supported"; for a 5xx, "unavailable" means the server is struggling, not
  // that the model is missing
  const missing = status && status >= 500 ? /(not[ _-]?found|does not exist|unknown|no such)/i : /(not[ _-]?found|does not exist|unknown|invalid|not[ _-]?supported|unsupported|no such|not available|unavailable)/i;
  const aboutModel = /model/i.test(text) && missing.test(text);
  if (status === 401 || status === 403) {
    return new AIError('connection_bad_key', 'The server did not accept that key. Check the key, then paste it again.', info);
  }
  if (aboutModel || (status === 404 && /model/i.test(text))) {
    return new AIError('connection_model', `The server has no model called "${ctx.model}". Check the model name, or pick one from the list.`, info);
  }
  if (status === 404 || status === 405) return wrongAddress(ctx, info.detail, status);
  if (status === 429) {
    return new AIError('connection_busy', 'The server is busy, or this key has used up its limit. Wait a minute, then try again.', { ...info, retryable: true });
  }
  if (status && status >= 500) {
    return new AIError('connection_unavailable', 'The server had a problem answering. Try again in a few minutes.', { ...info, retryable: true });
  }
  return new AIError('connection_error', 'Something went wrong talking to your server. Try again.', info);
}

export function mapFetchFailure(e: any): AIError {
  const code = e?.cause?.code ?? e?.code;
  return unreachable(`${e?.message ?? e}${code ? ` (${code})` : ''}`);
}

export async function readBody(res: Response): Promise<unknown> {
  const text = await res.text().catch(() => '');
  try { return JSON.parse(text); } catch { return text.slice(0, 300); }
}

/** Best first. A server's own list order says nothing about quality (CLIProxyAPI lists claude-3-5-haiku first), so
 * the first entry is never picked blindly. This is the Sonnet family the built-in Claude providers use; ChatGPT
 * sign-in has no fixed model, so no GPT model is here. Add a model when a built-in provider moves to it. */
const PREFERRED_MODELS = ['claude-sonnet-5-5', 'claude-sonnet-5', 'claude-sonnet-4-6', 'claude-sonnet-4-5'];

/** Matches with a date suffix (claude-sonnet-4-5-20250929) or a provider prefix (anthropic/claude-sonnet-5-5).
 * null when none is offered: the person picks. */
export function suggestedModel(models: string[]): string | null {
  const bare = (m: string) => m.slice(m.lastIndexOf('/') + 1).replace(/-\d{8}$/, '');
  for (const want of PREFERRED_MODELS) {
    const hit = models.find((m) => bare(m) === want);
    if (hit) return hit;
  }
  return null;
}

/** Empty when the server does not answer: the person then types the model name. */
export async function listConnectionModels(kind: ConnectionKind, baseURL: string, key: string | null, opts: { fetch?: typeof fetch } = {}): Promise<{ models: string[]; keyRefused: boolean }> {
  const base = normalizeBaseURL(baseURL);
  const url = kind === 'openai' ? `${base}/models` : `${base}/v1/models`;
  const headers: Record<string, string> = kind === 'openai'
    ? (key ? { authorization: `Bearer ${key}` } : {})
    : { 'anthropic-version': '2023-06-01', ...(key ? { 'x-api-key': key } : {}) };
  try {
    const res = await noRedirectFetch(opts.fetch)(url, { headers, signal: AbortSignal.timeout(10_000) });
    // 401/403: the server wants a (different) key before it lists anything
    if (!res.ok) return { models: [], keyRefused: res.status === 401 || res.status === 403 };
    const json: any = await res.json();
    const list: any[] = Array.isArray(json?.data) ? json.data : Array.isArray(json?.models) ? json.models : [];
    const ids = list.map((m) => (typeof m === 'string' ? m : m?.id ?? m?.slug ?? m?.name)).filter((x): x is string => typeof x === 'string' && x.length > 0);
    return { models: [...new Set(ids)], keyRefused: false };
  } catch {
    return { models: [], keyRefused: false };
  }
}
