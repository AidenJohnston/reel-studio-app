import { describe, it, expect, afterEach } from 'vitest';
import * as http from 'node:http';
import { AnthropicProvider, AIError } from '../src';
import { toAnthropicMessages } from '../src/providers/anthropic';

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
});
