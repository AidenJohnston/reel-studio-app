import { describe, it, expect, afterEach } from 'vitest';
import * as http from 'node:http';
import { AnthropicProvider, AIError, runAgent, newToolState, StyleStore, pickTakes, ChatMessage } from '../src';
import { toAnthropicMessages } from '../src/providers/anthropic';
import { pruneImages } from '../src/agent';
import { FakeHost, makeProject, makeTranscript, SAMPLE_LINES } from './helpers';

let server: http.Server | null = null;
afterEach(() => { server?.closeAllConnections?.(); server?.close(); server = null; });

async function mockAnthropic(handler: (body: any, req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<{ url: string; bodies: any[] }> {
  const bodies: any[] = [];
  server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    bodies.push({ body, headers: req.headers });
    handler(body, req, res);
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server!.address() as any).port}`, bodies };
}

function streamToolUse(res: http.ServerResponse) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const ev = (type: string, data: any) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  ev('message_start', { message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 1 } } });
  ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
  ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Picking takes.' } });
  ev('content_block_stop', { index: 0 });
  ev('content_block_start', { index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'set_cut', input: {} } });
  ev('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: '{"keep":[{"from":"w1",' } });
  ev('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: '"to":"w9"}]}' } });
  ev('content_block_stop', { index: 1 });
  ev('message_delta', { delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 30 } });
  ev('message_stop', {});
  res.end();
}

/** Streams a reply made of the given content blocks, the way the Messages API sends each kind. */
function streamBlocks(res: http.ServerResponse, blocks: any[], stop: { stop_reason: string; stop_details?: unknown }) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const ev = (type: string, data: any) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  ev('message_start', { message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 1 } } });
  blocks.forEach((b, index) => {
    if (b.type === 'thinking') {
      ev('content_block_start', { index, content_block: { type: 'thinking', thinking: '', signature: '' } });
      ev('content_block_delta', { index, delta: { type: 'thinking_delta', thinking: b.thinking } });
      ev('content_block_delta', { index, delta: { type: 'signature_delta', signature: b.signature } });
    } else if (b.type === 'text') {
      ev('content_block_start', { index, content_block: { type: 'text', text: '' } });
      ev('content_block_delta', { index, delta: { type: 'text_delta', text: b.text } });
    } else if (b.type === 'tool_use') {
      ev('content_block_start', { index, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } });
      ev('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } });
    } else {
      ev('content_block_start', { index, content_block: b });
    }
    ev('content_block_stop', { index });
  });
  ev('message_delta', { delta: { stop_sequence: null, ...stop }, usage: { output_tokens: 30 } });
  ev('message_stop', {});
  res.end();
}

const tools = [{ name: 'set_cut', description: 'cut', parameters: { type: 'object', properties: { keep: { type: 'array' } }, required: ['keep'], additionalProperties: false } }];

describe('Anthropic Messages adapter (mock HTTP)', () => {
  it('streams tool use, sends tools + cached system prompt, default model', async () => {
    const m = await mockAnthropic((_b, _q, res) => streamToolUse(res));
    const p = new AnthropicProvider({ apiKey: 'sk-ant-test', baseURL: m.url });
    expect(p.model).toBe('claude-sonnet-5-5');
    const r = await p.complete({ system: 'SYS', tools, messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }] });
    expect(r.text).toBe('Picking takes.');
    expect(r.toolCalls).toEqual([{ id: 'toolu_1', name: 'set_cut', args: { keep: [{ from: 'w1', to: 'w9' }] } }]);
    const { body, headers } = m.bodies[0];
    expect(headers['x-api-key']).toBe('sk-ant-test');
    expect(body.stream).toBe(true);
    expect(body.model).toBe('claude-sonnet-5-5');
    expect(body.system[0]).toMatchObject({ type: 'text', text: 'SYS', cache_control: { type: 'ephemeral' } });
    expect(body.tools[0]).toMatchObject({ name: 'set_cut', input_schema: { type: 'object' } });
  });

  it('converts tool results with images and merges consecutive user turns', () => {
    const msgs = toAnthropicMessages([
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
      { role: 'assistant', text: '', toolCalls: [{ id: 't1', name: 'look_at_frames', args: { times: [1] } }] },
      { role: 'tool', results: [{ callId: 't1', name: 'look_at_frames', content: '{"frames":1}', images: [{ type: 'image', mime: 'image/png', base64: 'AAAA' }] }] },
      { role: 'user', content: [{ type: 'text', text: 'keep going' }] },
    ]);
    expect(msgs).toHaveLength(3);
    expect(msgs[1].content).toEqual([{ type: 'tool_use', id: 't1', name: 'look_at_frames', input: { times: [1] } }]);
    const last = msgs[2].content as any[];
    expect(last[0]).toMatchObject({ type: 'tool_result', tool_use_id: 't1' });
    expect(last[0].content[1]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } });
    expect(last[1]).toEqual({ type: 'text', text: 'keep going' });
  });

  it('bad key -> friendly error; rate limit -> retryable', async () => {
    const m = await mockAnthropic((_b, _q, res) => res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } })));
    const p = new AnthropicProvider({ apiKey: 'bad', baseURL: m.url });
    const e: any = await p.ping().catch((x) => x);
    expect(e).toBeInstanceOf(AIError);
    expect(e.code).toBe('claude_bad_key');
    expect(e.userMessage).toMatch(/key/);
    server!.close(); server = null;
    const m2 = await mockAnthropic((_b, _q, res) => res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '0' }).end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } })));
    const p2 = new AnthropicProvider({ apiKey: 'k', baseURL: m2.url });
    const e2: any = await p2.complete({ system: 's', tools: [], messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] }).catch((x) => x);
    expect(e2.code).toBe('claude_rate_limited');
    expect(e2.retryable).toBe(true);
  });

  it('replays thinking blocks unchanged and in order on the next agent step', async () => {
    const thinking = { type: 'thinking', thinking: 'The second take is cleaner; read the project first.', signature: 'EqQBCkYIBxgCKkDsig+/==' };
    const redacted = { type: 'redacted_thinking', data: 'EmwKAhgBEgy3va3pzix/LafPsn4aDFIT' };
    const m = await mockAnthropic((_b, _q, res) => {
      if (m.bodies.length === 1) {
        streamBlocks(res, [thinking, redacted, { type: 'text', text: 'Reading it.' }, { type: 'tool_use', id: 'toolu_1', name: 'get_project', input: {} }], { stop_reason: 'tool_use' });
      } else {
        streamBlocks(res, [{ type: 'tool_use', id: 'toolu_2', name: 'finish', input: { summary_for_user: 'done' } }], { stop_reason: 'tool_use' });
      }
    });
    const { root, dir } = await makeProject();
    const host = new FakeHost(root);
    const ctx = { projectDir: dir, host, style: new StyleStore(() => host.reelStudioRoot()), emit: () => undefined, state: newToolState(), supportsImages: true };
    const r = await runAgent({ provider: new AnthropicProvider({ apiKey: 'k', baseURL: m.url }), system: 's', task: 't', ctx, onEvent: () => undefined });
    expect(r.finished).toBe('done');
    const assistantTurn = m.bodies[1].body.messages[1];
    expect(assistantTurn.role).toBe('assistant');
    expect(assistantTurn.content).toEqual([
      thinking,
      redacted,
      expect.objectContaining({ type: 'text', text: 'Reading it.' }),
      expect.objectContaining({ type: 'tool_use', id: 'toolu_1', name: 'get_project', input: {} }),
    ]);
    const resultTurn = m.bodies[1].body.messages[2];
    expect(resultTurn.role).toBe('user');
    expect(resultTurn.content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'toolu_1' });
  });

  it('after pruneImages edits an earlier tool result, still replays later thinking and asks to drop stale blocks', async () => {
    const thinkingB = { type: 'thinking', thinking: 'Frame 2 is sharper.', signature: 'SIG-B==' };
    const replies = [
      [{ type: 'thinking', thinking: 'Look first.', signature: 'SIG-A==' }, { type: 'tool_use', id: 'toolu_1', name: 'look_at_frames', input: { times: [1] } }],
      [thinkingB, { type: 'tool_use', id: 'toolu_2', name: 'look_at_frames', input: { times: [2] } }],
      [{ type: 'text', text: 'ok' }],
    ];
    const m = await mockAnthropic((_b, _q, res) => streamBlocks(res, replies[m.bodies.length - 1], { stop_reason: 'tool_use' }));
    const p = new AnthropicProvider({ apiKey: 'k', baseURL: m.url });
    const image = { type: 'image' as const, mime: 'image/png', base64: 'AAAA' };
    const messages: ChatMessage[] = [{ role: 'user', content: [{ type: 'text', text: 'go' }] }];
    for (let step = 0; step < 3; step++) {
      const r = await p.complete({ system: 's', tools, messages: pruneImages(messages) });
      messages.push({ role: 'assistant', text: r.text, toolCalls: r.toolCalls, raw: r.raw });
      for (const c of r.toolCalls) messages.push({ role: 'tool', results: [{ callId: c.id, name: c.name, content: 'frame', images: [image] }] });
    }
    for (const { body, headers } of m.bodies) {
      expect(headers['anthropic-beta']).toContain('thinking-binding-controls-2026-08-01');
      expect(body.thinking).toMatchObject({ type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } });
    }
    const third = m.bodies[2].body.messages;
    expect(third[2].content[0].content).toEqual([{ type: 'text', text: 'frame\n(earlier images removed)' }]);
    expect(third[3].content[0]).toEqual(thinkingB);
  });

  it('sends adaptive thinking only to models that support it, and checks the key with the same shape', async () => {
    const m = await mockAnthropic((_b, _q, res) => streamToolUse(res));
    for (const model of ['claude-sonnet-4-5', 'claude-sonnet-4-6']) {
      const p = new AnthropicProvider({ apiKey: 'k', baseURL: m.url, model });
      await p.complete({ system: 's', tools, messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }] });
      await p.ping().catch(() => undefined);
    }
    const [oldEdit, oldPing, newEdit, newPing] = m.bodies;
    for (const r of [oldEdit, oldPing]) {
      expect(r.body.thinking).toBeUndefined();
      expect(r.headers['anthropic-beta']).toBeUndefined();
    }
    for (const r of [newEdit, newPing]) {
      expect(r.body.thinking).toEqual({ type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } });
      expect(r.headers['anthropic-beta']).toContain('thinking-binding-controls-2026-08-01');
    }
  });

  it('a JSON-correction retry sends the first reply back with its thinking unchanged', async () => {
    const thinking = { type: 'thinking', thinking: 'Keep the second take.', signature: 'SIG-J==' };
    const m = await mockAnthropic((_b, _q, res) => streamBlocks(res, m.bodies.length === 1
      ? [thinking, { type: 'text', text: 'not json' }]
      : [{ type: 'text', text: '{"keep":[{"from":"w16","to":"w26"}],"notes":"ok"}' }], { stop_reason: 'end_turn' }));
    const r = await pickTakes(makeTranscript(SAMPLE_LINES), new AnthropicProvider({ apiKey: 'k', baseURL: m.url }));
    expect(r.attempts).toBe(2);
    const retried = m.bodies[1].body.messages[1];
    expect(retried.role).toBe('assistant');
    expect(retried.content[0]).toEqual(thinking);
  });

  it('a refusal stops with a plain message instead of an empty reply', async () => {
    const m = await mockAnthropic((_b, _q, res) => streamBlocks(res, [], { stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber', explanation: null } }));
    const p = new AnthropicProvider({ apiKey: 'k', baseURL: m.url });
    const e: any = await p.complete({ system: 's', tools, messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] }).catch((x) => x);
    expect(e).toBeInstanceOf(AIError);
    expect(e.code).toBe('claude_refused');
    expect(e.retryable).toBe(false);
    expect(e.message).toContain('cyber');
  });
});
