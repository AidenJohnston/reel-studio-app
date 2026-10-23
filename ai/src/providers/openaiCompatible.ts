// The person's own OpenAI-compatible server on Chat Completions. Most compatible servers (local runners, proxies)
// implement it; few implement the Responses API that openai.ts uses for ChatGPT sign-in. No streaming: the agent
// loop only needs the finished answer.
import { AIError, ChatMessage, CompletionRequest, CompletionResponse, ModelProvider, ToolCall, ToolSchema } from '../types';
import { randomUUID } from 'node:crypto';
import { mapConnectionError, mapFetchFailure, noRedirectFetch, readBody, tookTooLong, withoutSecret, wrongAddress } from './connection';

export interface OpenAICompatibleOptions {
  baseURL: string;
  /** null: a server that needs no key gets no Authorization header */
  apiKey: string | null;
  model: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  supportsImages: boolean;
}

const imageUrl = (mime: string, base64: string) => ({ type: 'image_url', image_url: { url: `data:${mime};base64,${base64}` } });

/** A tool message carries text only, so pictures a tool returned follow that turn's tool messages in one user
 * message. */
function toChatMessages(system: string, messages: ChatMessage[]): any[] {
  const out: any[] = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (m.role === 'user') {
      out.push({ role: 'user', content: m.content.map((p) => (p.type === 'text' ? { type: 'text', text: p.text } : imageUrl(p.mime, p.base64))) });
    } else if (m.role === 'assistant') {
      out.push({
        role: 'assistant',
        content: m.toolCalls.length ? m.text || null : m.text ?? '',
        ...(m.toolCalls.length ? { tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) } })) } : {}),
      });
    } else {
      const pictures: any[] = [];
      for (const r of m.results) {
        out.push({ role: 'tool', tool_call_id: r.callId, content: r.content });
        if (r.images?.length) pictures.push({ type: 'text', text: `Images from ${r.name} (${r.callId}), in order:` }, ...r.images.map((img) => imageUrl(img.mime, img.base64)));
      }
      if (pictures.length) out.push({ role: 'user', content: pictures });
    }
  }
  return out;
}

function toChatTools(tools: ToolSchema[]): any[] {
  return tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
}

function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((p: any) => (typeof p === 'string' ? p : typeof p?.text === 'string' ? p.text : '')).join('');
  return '';
}

/** Arguments that are not JSON are kept as `__unparseable` (like openai.ts) so the tool reports the problem back to
 * the model. */
function fromChatCompletion(json: any): CompletionResponse {
  const choice = json?.choices?.[0];
  const msg = choice?.message ?? {};
  const seen = new Set<string>();
  const toolCalls: ToolCall[] = (Array.isArray(msg.tool_calls) ? msg.tool_calls : [])
    .filter((c: any) => c?.function?.name)
    .map((c: any, i: number) => {
      const raw = c.function.arguments;
      let args: Record<string, unknown> = {};
      if (raw && typeof raw === 'object') args = raw;
      else if (typeof raw === 'string' && raw.trim()) {
        try { args = JSON.parse(raw); } catch { args = { __unparseable: raw }; }
      }
      // some servers send no id, or the same one twice; the next request must still match each result to its call
      const id = c.id && !seen.has(String(c.id)) ? String(c.id) : `call_${randomUUID().slice(0, 8)}_${i}`;
      seen.add(id);
      return { id, name: String(c.function.name), args };
    });
  const u = json?.usage ?? {};
  return {
    text: messageText(msg.content),
    toolCalls,
    raw: { finish_reason: choice?.finish_reason },
    usage: { input: u.prompt_tokens, output: u.completion_tokens, cacheRead: u.prompt_tokens_details?.cached_tokens ?? undefined },
    // said it called tools but sent none: the agent re-asks with a format correction
    ...(choice?.finish_reason === 'tool_calls' && !toolCalls.length ? { malformed: true } : {}),
  };
}

export class OpenAICompatibleProvider implements ModelProvider {
  readonly id = 'custom' as const;
  readonly supportsImages: boolean;
  readonly model: string;
  private readonly url: string;
  constructor(private readonly o: OpenAICompatibleOptions) {
    this.model = o.model;
    this.supportsImages = o.supportsImages;
    this.url = `${o.baseURL.replace(/\/+$/, '')}/chat/completions`;
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    try { return await this.once(req); } catch (e) {
      throw e instanceof AIError ? withoutSecret(e, this.o.apiKey) : e;
    }
  }

  private async once(req: CompletionRequest): Promise<CompletionResponse> {
    const ctx = { kind: 'openai' as const, model: this.model };
    const body: Record<string, unknown> = { model: this.model, messages: toChatMessages(req.system, req.messages) };
    if (req.tools.length && !req.jsonOnly) body.tools = toChatTools(req.tools);
    const signal = AbortSignal.any([...(req.signal ? [req.signal] : []), AbortSignal.timeout(this.o.timeoutMs ?? 300_000)]);
    let res: Response;
    try {
      res = await noRedirectFetch(this.o.fetch)(this.url, {
        method: 'POST', signal,
        headers: { 'content-type': 'application/json', accept: 'application/json', ...(this.o.apiKey ? { authorization: `Bearer ${this.o.apiKey}` } : {}) },
        body: JSON.stringify(body),
      });
    } catch (e: any) {
      if (req.signal?.aborted) throw new AIError('cancelled', 'Stopped.');
      if (signal.aborted) throw tookTooLong(e?.message);
      throw mapFetchFailure(e);
    }
    if (!res.ok) throw mapConnectionError(res.status, await readBody(res), ctx);
    let json: any;
    try { json = await res.json(); } catch (e: any) {
      if (req.signal?.aborted) throw new AIError('cancelled', 'Stopped.');
      if (signal.aborted) throw tookTooLong(e?.message);
      throw wrongAddress(ctx, `answer was not JSON: ${e?.message ?? e}`, res.status);
    }
    // 200 with an error object (some proxies) or without choices (not a Chat Completions server)
    if (json?.error) throw mapConnectionError(Number(json.error.status ?? json.error.code) || undefined, json, ctx);
    const choice = Array.isArray(json?.choices) ? json.choices[0] : undefined;
    const msg = choice?.message;
    const answered = msg && typeof msg === 'object' && (typeof msg.content === 'string' || Array.isArray(msg.content) || (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0));
    if (!answered) throw wrongAddress(ctx, 'answer had no message', res.status);
    const out = fromChatCompletion(json);
    if (choice.finish_reason === 'length' && !out.toolCalls.length) {
      throw new AIError('connection_truncated', 'The AI ran out of room on that step. Try again.', { retryable: true });
    }
    return out;
  }
}
