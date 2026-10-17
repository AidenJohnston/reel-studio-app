// OpenAI Responses API adapter, used with a "Sign in with ChatGPT" access token.
// Rules from the SIWC preview docs: POST /v1/responses only, store:false + stream:true,
// full history in `input` (no previous_response_id), system text in `instructions`,
// function tools grouped in a namespace, success only on `response.completed`.
// Plan-usage errors STOP: we never switch billing to another provider.
import { AIError, ChatMessage, CompletionRequest, CompletionResponse, ModelProvider, ToolCall, ToolSchema } from '../types';
import { SiwcAuth, USAGE_URL } from './siwc';

export const TOOL_NAMESPACE = 'reel_editor';

export function toResponsesInput(messages: ChatMessage[]): any[] {
  const input: any[] = [];
  for (const m of messages) {
    if (m.role === 'user') {
      input.push({
        role: 'user',
        content: m.content.map((p) => p.type === 'text'
          ? { type: 'input_text', text: p.text }
          : { type: 'input_image', image_url: `data:${p.mime};base64,${p.base64}` }),
      });
    } else if (m.role === 'assistant') {
      if (m.text) input.push({ role: 'assistant', content: m.text });
      for (const c of m.toolCalls) {
        const raw = (c.raw ?? {}) as Record<string, unknown>;
        // Echo the call as received (minus server ids, which are not stored with store:false).
        const { id: _id, status: _status, ...rest } = raw;
        input.push({ ...rest, type: 'function_call', call_id: c.id, name: (raw.name as string) ?? c.name, arguments: JSON.stringify(c.args ?? {}) });
      }
    } else {
      for (const r of m.results) {
        const output = r.images?.length
          ? [{ type: 'input_text', text: r.content }, ...r.images.map((img) => ({ type: 'input_image', image_url: `data:${img.mime};base64,${img.base64}` }))]
          : r.content;
        input.push({ type: 'function_call_output', call_id: r.callId, output });
      }
    }
  }
  return input;
}

export function toResponsesTools(tools: ToolSchema[], mode: 'namespace' | 'flat'): any[] {
  const fns = tools.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters, strict: true }));
  if (mode === 'flat') return fns;
  return [{ type: 'namespace', name: TOOL_NAMESPACE, description: 'Actions that edit the Reel project.', tools: fns }];
}

/** Maps a SIWC / Responses error to a friendly AIError. Exported for tests. */
export function mapResponsesError(status: number | undefined, body: any, requestId?: string): AIError {
  const err = body?.error && typeof body.error === 'object' ? body.error : body?.response?.error ?? body;
  const code: string | undefined = typeof err?.code === 'string' ? err.code : (typeof body?.error === 'string' ? body.error : undefined);
  const param: string | undefined = err?.param ?? undefined;
  const detail = `status=${status ?? '?'} code=${code ?? '-'} param=${param ?? '-'} request=${requestId ?? '-'} ${typeof body?.detail === 'string' ? body.detail : (err?.message ?? '')}`.trim();
  const base = { status, requestId, detail };
  switch (code) {
    case 'subscription_sharing_usage_limit_exceeded':
      return new AIError('chatgpt_usage_limit', "You have reached your ChatGPT plan's limit for now, so I stopped. Nothing else was used or charged. You can check your usage in ChatGPT settings and try again later.", { ...base, link: USAGE_URL });
    case 'subscription_sharing_user_not_eligible':
      return new AIError('chatgpt_not_eligible', 'Your ChatGPT plan cannot be used in Reel Studio. A Plus or Pro plan works, or you can add a Claude key in Settings.', base);
    case 'subscription_sharing_usage_unavailable':
    case 'subscription_sharing_user_unavailable':
      return new AIError('chatgpt_busy', 'ChatGPT is busy right now. Try again in a few minutes.', { ...base, retryable: true });
    case 'subscription_sharing_unsupported_capability':
      return new AIError('chatgpt_unsupported', 'ChatGPT could not do that step with this model. Try again, or pick a different model in Settings.', base);
    case 'subscription_sharing_route_not_supported':
    case 'chatpass_v2_scope_not_authorized':
    case 'chatpass_v2_invalid_authorization_context':
      return new AIError('chatgpt_not_allowed', 'ChatGPT did not allow this request. Sign out and sign in with ChatGPT again in Settings.', base);
    case 'subscription_sharing_invalid_user':
      return new AIError('chatgpt_signed_out', 'Your ChatGPT sign-in has ended. Sign in with ChatGPT again in Settings.', base);
  }
  if (status === 429) {
    return new AIError('chatgpt_usage_limit', "You have reached your ChatGPT plan's limit for now, so I stopped. Nothing else was used or charged. You can check your usage in ChatGPT settings and try again later.", { ...base, link: USAGE_URL });
  }
  if (status === 401) return new AIError('chatgpt_signed_out', 'Your ChatGPT sign-in has ended. Sign in with ChatGPT again in Settings.', base);
  if (status === 403) return new AIError('chatgpt_restricted', 'ChatGPT is not available for this account or in your region.', base);
  if (status === 503 || (status && status >= 500)) return new AIError('chatgpt_busy', 'ChatGPT is busy right now. Try again in a few minutes.', { ...base, retryable: true });
  if (status === 400 && param && /model/i.test(param)) return new AIError('chatgpt_model', 'That ChatGPT model is not available for your account. Pick another one in Settings.', base);
  return new AIError('chatgpt_error', 'Something went wrong talking to ChatGPT. Try again.', base);
}

export interface OpenAIResponsesOptions {
  auth: Pick<SiwcAuth, 'accessToken' | 'markDisconnected'>;
  model: string;
  baseURL?: string;
  fetch?: typeof fetch;
  toolsMode?: 'namespace' | 'flat';
  /** delays (ms) between retries of temporary 503s; never used for 429 */
  retryDelays?: number[];
  timeoutMs?: number;
}

export class OpenAIResponsesProvider implements ModelProvider {
  readonly id = 'chatgpt' as const;
  readonly supportsImages = true;
  readonly model: string;
  private toolsMode: 'namespace' | 'flat';
  constructor(private readonly o: OpenAIResponsesOptions) {
    this.model = o.model;
    this.toolsMode = o.toolsMode ?? 'namespace';
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const delays = this.o.retryDelays ?? [1500, 4000];
    let triedRefresh = false; let triedToolsMode = false;
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.once(req, triedRefresh);
      } catch (e: any) {
        if (!(e instanceof AIError) || req.signal?.aborted) throw e;
        if (e.code === 'chatgpt_signed_out' && e.status === 401 && !triedRefresh) { triedRefresh = true; continue; }
        const toolsRejected = (e.code === 'chatgpt_unsupported' && /tools?|namespace/i.test(e.message)) ||
          (e.status === 400 && /param=tools/i.test(e.message));
        if (toolsRejected && !triedToolsMode && req.tools.length) {
          // Same provider, same billing: only the tool encoding changes.
          this.toolsMode = this.toolsMode === 'namespace' ? 'flat' : 'namespace';
          triedToolsMode = true; continue;
        }
        if (e.retryable && e.code === 'chatgpt_busy' && attempt < delays.length) { await sleep(delays[attempt], req.signal); continue; }
        if (e.code === 'chatgpt_signed_out' && triedRefresh) await this.o.auth.markDisconnected().catch(() => undefined);
        throw e;
      }
    }
  }

  private async once(req: CompletionRequest, forceRefresh: boolean): Promise<CompletionResponse> {
    const token = await this.o.auth.accessToken({ forceRefresh, signal: req.signal });
    const body: Record<string, unknown> = {
      model: this.model,
      instructions: req.system,
      input: toResponsesInput(req.messages),
      store: false,
      stream: true,
    };
    if (req.tools.length && !req.jsonOnly) body.tools = toResponsesTools(req.tools, this.toolsMode);
    const signal = AbortSignal.any([...(req.signal ? [req.signal] : []), AbortSignal.timeout(this.o.timeoutMs ?? 300_000)]);
    let res: Response;
    try {
      res = await (this.o.fetch ?? fetch)(`${(this.o.baseURL ?? 'https://api.openai.com/v1').replace(/\/$/, '')}/responses`, {
        method: 'POST', signal, redirect: 'error',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'text/event-stream' },
        body: JSON.stringify(body),
      });
    } catch (e: any) {
      if (req.signal?.aborted) throw new AIError('cancelled', 'Stopped.');
      throw new AIError('offline', 'I could not reach ChatGPT. Check your internet connection and try again.', { retryable: true, detail: e?.message });
    }
    const requestId = res.headers.get('x-request-id') ?? undefined;
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let json: any = null; try { json = JSON.parse(text); } catch { json = { detail: text.slice(0, 300) }; }
      throw mapResponsesError(res.status, json, requestId);
    }
    if (!res.body) throw new AIError('chatgpt_stream', 'ChatGPT stopped answering. Try again.', { retryable: true });

    let text = '';
    const calls = new Map<string, ToolCall>();
    let completed = false;
    const addCall = (item: any) => {
      if (!item || item.type !== 'function_call') return;
      let args: Record<string, unknown> = {};
      try { args = item.arguments ? JSON.parse(item.arguments) : {}; } catch { args = { __unparseable: String(item.arguments) }; }
      const name = String(item.name ?? '');
      calls.set(item.call_id, { id: item.call_id, name: name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : name, args, raw: item });
    };
    try {
      for await (const ev of sseEvents(res.body, signal)) {
        switch (ev.type) {
          case 'response.output_text.delta': if (typeof ev.delta === 'string') text += ev.delta; break;
          case 'response.output_item.done': addCall(ev.item); break;
          case 'response.failed': throw mapResponsesError(res.status, ev.response ?? ev, requestId);
          case 'error': throw mapResponsesError((ev as any).status ?? res.status, ev, requestId);
          case 'response.incomplete': throw new AIError('chatgpt_incomplete', 'ChatGPT stopped before finishing that step. Try again.', { retryable: true, detail: JSON.stringify(ev.response?.incomplete_details ?? {}) });
          case 'response.completed': {
            completed = true;
            for (const item of ev.response?.output ?? []) {
              if (item.type === 'function_call' && !calls.has(item.call_id)) addCall(item);
              if (!text && item.type === 'message') text = (item.content ?? []).filter((c: any) => c.type === 'output_text').map((c: any) => c.text).join('');
            }
            break;
          }
        }
        if (completed) break;
      }
    } catch (e: any) {
      if (e instanceof AIError) throw e;
      if (req.signal?.aborted) throw new AIError('cancelled', 'Stopped.');
      throw new AIError('chatgpt_stream', 'The connection to ChatGPT was interrupted. Try again.', { retryable: true, detail: e?.message });
    }
    if (!completed) throw new AIError('chatgpt_stream', 'The connection to ChatGPT was interrupted. Try again.', { retryable: true });
    return { text, toolCalls: [...calls.values()] };
  }
}

export async function* sseEvents(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<any> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  try {
    while (true) {
      if (signal?.aborted) throw new Error('aborted');
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      let i: number;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
        const data = chunk.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
        if (!data || data === '[DONE]') continue;
        yield JSON.parse(data);
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** GET /v1/models for the signed-in account; keeps server order, `visibility: "list"` only. */
export async function listChatGPTModels(auth: Pick<SiwcAuth, 'accessToken'>, opts: { baseURL?: string; fetch?: typeof fetch; timeoutMs?: number } = {}): Promise<{ slug: string; displayName: string }[]> {
  const token = await auth.accessToken();
  let res: Response;
  try {
    // a hung host must not block Settings or an edit forever
    res = await (opts.fetch ?? fetch)(`${(opts.baseURL ?? 'https://api.openai.com/v1').replace(/\/$/, '')}/models`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000) });
  } catch (e: any) {
    throw new AIError('offline', 'I could not reach ChatGPT. Check your internet connection and try again.', { retryable: true, detail: e?.message });
  }
  const json: any = await res.json().catch(() => null);
  if (!res.ok) throw mapResponsesError(res.status, json, res.headers.get('x-request-id') ?? undefined);
  const list: any[] = json?.models ?? json?.data ?? [];
  return list.filter((m) => (m.visibility ?? 'list') === 'list').map((m) => ({ slug: m.slug ?? m.id, displayName: m.display_name ?? m.slug ?? m.id }));
}

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(new AIError('cancelled', 'Stopped.')); }, { once: true });
  });
}
