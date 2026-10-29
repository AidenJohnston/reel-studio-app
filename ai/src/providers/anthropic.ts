// Claude via a pasted API key: Anthropic Messages API, tool use, streaming (official SDK).
import Anthropic from '@anthropic-ai/sdk';
import { AIError, ChatMessage, CompletionRequest, CompletionResponse, ModelProvider, ToolSchema } from '../types';

export const DEFAULT_CLAUDE_MODEL = 'claude-sonnet-5-5';
/** The same key's small model, for short text (version titles). */
export const SMALL_CLAUDE_MODEL = 'claude-haiku-5-5';

export interface AnthropicOptions {
  apiKey: string;
  model?: string;
  maxTokens?: number;
  /** test hook: base URL of a mock server */
  baseURL?: string;
  fetch?: typeof fetch;
}

/** Converts provider-neutral messages to Anthropic content blocks (tool results carry images). */
export function toAnthropicMessages(messages: ChatMessage[]): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];
  for (const m of messages) {
    if (m.role === 'user') {
      out.push({
        role: 'user',
        content: m.content.map((p) => p.type === 'text'
          ? { type: 'text', text: p.text }
          : { type: 'image', source: { type: 'base64', media_type: p.mime as any, data: p.base64 } }),
      });
    } else if (m.role === 'assistant') {
      const content: Anthropic.ContentBlockParam[] = [];
      if (m.text) content.push({ type: 'text', text: m.text });
      for (const c of m.toolCalls) content.push({ type: 'tool_use', id: c.id, name: c.name, input: c.args });
      if (!content.length) content.push({ type: 'text', text: '(no reply)' });
      out.push({ role: 'assistant', content });
    } else {
      out.push({
        role: 'user',
        content: m.results.map((r) => ({
          type: 'tool_result' as const,
          tool_use_id: r.callId,
          is_error: r.isError || undefined,
          content: [
            { type: 'text' as const, text: r.content },
            ...(r.images ?? []).map((img) => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: img.mime as any, data: img.base64 } })),
          ],
        })),
      });
    }
  }
  // Merge consecutive same-role turns (e.g. tool results followed by a nudge) into one.
  const merged: Anthropic.MessageParam[] = [];
  for (const m of out) {
    const prev = merged.at(-1);
    if (prev && prev.role === m.role) {
      const asBlocks = (c: Anthropic.MessageParam['content']) => (typeof c === 'string' ? [{ type: 'text' as const, text: c }] : c);
      prev.content = [...asBlocks(prev.content), ...asBlocks(m.content)] as any;
    } else merged.push({ ...m });
  }
  return merged;
}

/** Puts a cache breakpoint on the LAST block of the last message. The agent resends the whole
 * history every step; with only the system prompt cached, the growing message list was paid in
 * full each time. One breakpoint at the end caches everything before it for
 * the next step (the system prompt keeps its own). */
export function withCacheBreakpoint(msgs: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  const last = msgs.at(-1);
  if (!last) return msgs;
  const blocks = typeof last.content === 'string' ? [{ type: 'text' as const, text: last.content }] : [...last.content];
  const i = blocks.length - 1;
  if (i < 0) return msgs;
  blocks[i] = { ...(blocks[i] as any), cache_control: { type: 'ephemeral' } };
  return [...msgs.slice(0, -1), { ...last, content: blocks as any }];
}

export function toAnthropicTools(tools: ToolSchema[]): Anthropic.Tool[] {
  return tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters as Anthropic.Tool.InputSchema }));
}

export function mapAnthropicError(err: any): AIError {
  const status: number | undefined = err?.status;
  const type: string | undefined = err?.error?.error?.type ?? err?.error?.type;
  if (status === 401 || type === 'authentication_error') {
    return new AIError('claude_bad_key', 'That Claude key did not work. Check that you copied the whole key, then paste it again in Settings.', { status, detail: err?.message });
  }
  if (status === 403 || type === 'permission_error') {
    return new AIError('claude_forbidden', 'Your Claude account does not allow this yet. Check your Claude Console account, then try again.', { status, detail: err?.message });
  }
  if (status === 429 || type === 'rate_limit_error') {
    return new AIError('claude_rate_limited', 'Claude is busy for your account right now. Wait a minute, then try again.', { status, retryable: true, detail: err?.message, link: 'https://console.anthropic.com/settings/limits' });
  }
  if (status === 400 && /credit balance/i.test(err?.message ?? '')) {
    return new AIError('claude_no_credit', 'Your Claude account is out of credit. Add credit in the Claude Console, then try again.', { status, link: 'https://console.anthropic.com/settings/billing', detail: err?.message });
  }
  if (status === 529 || type === 'overloaded_error' || (status && status >= 500)) {
    return new AIError('claude_unavailable', 'Claude is having trouble right now. Try again in a few minutes.', { status, retryable: true, detail: err?.message });
  }
  if (err?.name === 'APIConnectionError' || err?.code === 'ECONNREFUSED' || err?.code === 'ENOTFOUND') {
    return new AIError('offline', 'I could not reach Claude. Check your internet connection and try again.', { retryable: true, detail: err?.message });
  }
  return new AIError('claude_error', 'Something went wrong talking to Claude. Try again.', { status, detail: err?.message });
}

export class AnthropicProvider implements ModelProvider {
  readonly id = 'claude' as const;
  readonly supportsImages = true;
  readonly model: string;
  private client: Anthropic;
  private maxTokens: number;

  constructor(opts: AnthropicOptions) {
    this.model = opts.model || DEFAULT_CLAUDE_MODEL;
    this.maxTokens = opts.maxTokens ?? 16000;
    // baseURL explicit: the SDK otherwise honours ANTHROPIC_BASE_URL, so an env var could send the
    // user's key to another host
    this.client = new Anthropic({ apiKey: opts.apiKey, baseURL: opts.baseURL ?? 'https://api.anthropic.com', fetch: opts.fetch as any, maxRetries: 2 });
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    try {
      const stream = this.client.messages.stream({
        model: this.model,
        max_tokens: this.maxTokens,
        // Cache the long, stable prefix (system prompt + tool definitions) across agent steps.
        system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
        messages: withCacheBreakpoint(toAnthropicMessages(req.messages)),
        ...(req.tools.length && !req.jsonOnly ? { tools: toAnthropicTools(req.tools) } : {}),
      }, { signal: req.signal });
      const msg = await stream.finalMessage();
      const text = msg.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map((b) => b.text).join('');
      const toolCalls = msg.content
        .filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
        .map((b) => ({ id: b.id, name: b.name, args: (b.input ?? {}) as Record<string, unknown> }));
      if (msg.stop_reason === 'max_tokens' && !toolCalls.length) {
        throw new AIError('claude_truncated', 'Claude ran out of room on that step. Try again.', { retryable: true });
      }
      const u: any = msg.usage ?? {};
      return { text, toolCalls, raw: { stop_reason: msg.stop_reason }, usage: {
        input: u.input_tokens, output: u.output_tokens, cacheRead: u.cache_read_input_tokens ?? undefined, cacheWrite: u.cache_creation_input_tokens ?? undefined,
      } };
    } catch (err: any) {
      if (err instanceof AIError) throw err;
      if (req.signal?.aborted || err?.name === 'APIUserAbortError') throw new AIError('cancelled', 'Stopped.');
      throw mapAnthropicError(err);
    }
  }

  /** Tiny request used to validate a pasted key. */
  async ping(): Promise<void> {
    try {
      await this.client.messages.create({ model: this.model, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] });
    } catch (err: any) {
      throw mapAnthropicError(err);
    }
  }
}
