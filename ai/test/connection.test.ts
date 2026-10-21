import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as http from 'node:http';
import { AIError, createAI, OpenAICompatibleProvider, SecretStore, listConnectionModels, mapConnectionError, normalizeBaseURL, suggestedModel } from '../src';
import { AnthropicProvider } from '../src/providers/anthropic';
import { toChatMessages } from '../src/providers/openaiCompatible';
import { MockCompatible } from './mockCompatible';
import { FakeHost, tmpDir } from './helpers';

/** Reversible fake of Electron safeStorage: the file on disk must never hold the key in clear text. */
const fakeSafeStorage: SecretStore = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(Buffer.from(s, 'utf8').map((b) => b ^ 0x5a)),
  decryptString: (b) => Buffer.from(b.map((x) => x ^ 0x5a)).toString('utf8'),
};
const KEY = 'sk-mock-key';
const tools = [{ name: 'set_cut', description: 'cut', parameters: { type: 'object', properties: { keep: { type: 'array' } }, required: ['keep'] } }];
const sayOk = { system: 'SYS', tools: [], messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] }] };

let mock: MockCompatible;
beforeEach(async () => { mock = new MockCompatible(); await mock.start(); });
afterEach(async () => { await mock.stop(); });

const caught = (p: Promise<unknown>) => p.then(() => { throw new Error('expected a failure'); }, (e) => e as AIError);

describe('OpenAI-compatible provider (Chat Completions)', () => {
  it('sends system, images, tool calls and tool results; reads text, tool calls and usage', async () => {
    mock.chatHandlers.push((_b, res) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: 'Picking takes.', tool_calls: [
        { id: 'call_1', type: 'function', function: { name: 'set_cut', arguments: '{"keep":[{"from":"w1","to":"w9"}]}' } },
        { id: 'call_2', type: 'function', function: { name: 'set_cut', arguments: '{not json' } },
      ] }, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 120, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 100 } },
    })));
    const p = new OpenAICompatibleProvider({ baseURL: `${mock.origin}/v1/`, apiKey: KEY, model: 'mock-small' });
    const r = await p.complete({
      system: 'SYS', tools,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'go' }, { type: 'image', mime: 'image/png', base64: 'AAAA' }] },
        { role: 'assistant', text: '', toolCalls: [{ id: 't1', name: 'look_at_frames', args: { times: [1] } }] },
        { role: 'tool', results: [{ callId: 't1', name: 'look_at_frames', content: '{"frames":1}', images: [{ type: 'image', mime: 'image/jpeg', base64: 'BBBB' }] }] },
      ],
    });
    expect(r.text).toBe('Picking takes.');
    expect(r.toolCalls).toEqual([
      { id: 'call_1', name: 'set_cut', args: { keep: [{ from: 'w1', to: 'w9' }] } },
      { id: 'call_2', name: 'set_cut', args: { __unparseable: '{not json' } },
    ]);
    expect(r.usage).toEqual({ input: 120, output: 30, cacheRead: 100 });
    const req = mock.requests.at(-1)!;
    expect(req.path).toBe('/v1/chat/completions');
    expect(req.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(req.body.model).toBe('mock-small');
    expect(req.body.stream).toBeUndefined();
    expect(req.body.tools).toEqual([{ type: 'function', function: { name: 'set_cut', description: 'cut', parameters: tools[0].parameters } }]);
    expect(req.body.messages).toEqual([
      { role: 'system', content: 'SYS' },
      { role: 'user', content: [{ type: 'text', text: 'go' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'look_at_frames', arguments: '{"times":[1]}' } }] },
      { role: 'tool', tool_call_id: 't1', content: '{"frames":1}' },
      // a tool message holds text only: its pictures follow in one user message
      { role: 'user', content: [{ type: 'text', text: 'Images from look_at_frames (t1), in order:' }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,BBBB' } }] },
    ]);
  });

  it('keeps every tool message of a turn together before the pictures', () => {
    const msgs = toChatMessages('S', [
      { role: 'assistant', text: 'x', toolCalls: [{ id: 'a', name: 'n', args: {} }, { id: 'b', name: 'n', args: {} }] },
      { role: 'tool', results: [
        { callId: 'a', name: 'n', content: '1', images: [{ type: 'image', mime: 'image/png', base64: 'A' }] },
        { callId: 'b', name: 'n', content: '2' },
      ] },
    ]);
    expect(msgs.map((m) => m.role)).toEqual(['system', 'assistant', 'tool', 'tool', 'user']);
  });

  it('jsonOnly sends no tools; a server with no key gets no Authorization header', async () => {
    await mock.stop(); mock = new MockCompatible({ key: null }); await mock.start();
    const p = new OpenAICompatibleProvider({ baseURL: `${mock.origin}/v1`, apiKey: null, model: 'mock-small' });
    expect((await p.complete({ ...sayOk, tools, jsonOnly: true })).text).toBe('OK');
    expect(mock.requests.at(-1)!.headers.authorization).toBeUndefined();
    expect(mock.requests.at(-1)!.body.tools).toBeUndefined();
  });

  it('says it called tools but sent none: malformed, so the agent re-asks', async () => {
    mock.chatHandlers.push((_b, res) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { content: '' }, finish_reason: 'tool_calls' }] })));
    const r = await new OpenAICompatibleProvider({ baseURL: `${mock.origin}/v1`, apiKey: KEY, model: 'mock-small' }).complete(sayOk);
    expect(r.malformed).toBe(true);
  });
});

describe('plain-words errors from the person\'s own server', () => {
  const openai = (base: string, o: { key?: string; model?: string } = {}) => new OpenAICompatibleProvider({ baseURL: base, apiKey: o.key ?? KEY, model: o.model ?? 'mock-small' });

  it('wrong key, unknown model, wrong address, nothing listening', async () => {
    const badKey = await caught(openai(`${mock.origin}/v1`, { key: 'nope' }).complete(sayOk));
    expect(badKey.code).toBe('connection_bad_key');
    expect(badKey.userMessage).toMatch(/did not accept that key/);

    const model = await caught(openai(`${mock.origin}/v1`, { model: 'gpt-9' }).complete(sayOk));
    expect(model.code).toBe('connection_model');
    expect(model.userMessage).toBe('The server has no model called "gpt-9". Check the model name, or pick one from the list.');

    // the address is missing /v1: the server answers 404 with no word about a model
    const address = await caught(openai(mock.origin).complete(sayOk));
    expect(address.code).toBe('connection_wrong_address');
    expect(address.userMessage).toMatch(/usually end in \/v1/);

    const port = (mock.server.address() as any).port;
    await mock.stop();
    const down = await caught(openai(`http://127.0.0.1:${port}/v1`).complete(sayOk));
    expect(down.code).toBe('connection_unreachable');
    expect(down.userMessage).toMatch(/could not reach that server/);
    await mock.start();
  });

  it('a web page instead of an AI server, a redirect, busy and broken servers', async () => {
    const page = http.createServer((req, res) => {
      if (req.url!.startsWith('/redirect')) return res.writeHead(302, { location: 'http://example.com/' }).end();
      res.writeHead(200, { 'content-type': 'text/html' }).end('<html>hello</html>');
    });
    await new Promise<void>((r) => page.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(page.address() as any).port}`;
    try {
      expect((await caught(openai(`${base}/v1`).complete(sayOk))).code).toBe('connection_wrong_address');
      // never follow a redirect with the key
      expect((await caught(openai(`${base}/redirect`).complete(sayOk))).code).toBe('connection_unreachable');
    } finally { page.closeAllConnections(); page.close(); }

    const busy = mapConnectionError(429, { error: { message: 'Rate limit reached' } }, { kind: 'openai', model: 'm' });
    expect(busy).toMatchObject({ code: 'connection_busy', retryable: true });
    expect(mapConnectionError(503, { error: { message: 'model temporarily unavailable' } }, { kind: 'openai', model: 'm' }).code).toBe('connection_unavailable');
    expect(mapConnectionError(400, { error: { message: 'unknown provider for model x' } }, { kind: 'openai', model: 'x' }).code).toBe('connection_model');
    expect(mapConnectionError(403, 'Forbidden', { kind: 'anthropic', model: 'x' }).code).toBe('connection_bad_key');
  });

  it('Anthropic-compatible errors name the server, not Claude\'s Console', async () => {
    const p = (o: { key?: string; model?: string; base?: string } = {}) => new AnthropicProvider({ id: 'custom', apiKey: o.key ?? KEY, model: o.model ?? 'mock-small', baseURL: o.base ?? mock.origin, maxRetries: 0 });
    expect((await p().complete(sayOk)).text).toBe('OK');
    const badKey = await caught(p({ key: 'nope' }).complete(sayOk));
    expect(badKey.code).toBe('connection_bad_key');
    expect(badKey.userMessage).not.toMatch(/Claude/);
    expect((await caught(p({ model: 'claude-9' }).complete(sayOk))).code).toBe('connection_model');
    // /v1 added by mistake: the SDK asks for /v1/v1/messages
    const address = await caught(p({ base: `${mock.origin}/v1` }).complete(sayOk));
    expect(address.code).toBe('connection_wrong_address');
    expect(address.userMessage).toMatch(/usually do not end in \/v1/);
  });

  it('server addresses: http(s) only, no password or query in them', () => {
    expect(normalizeBaseURL(' http://127.0.0.1:4000/v1/ ')).toBe('http://127.0.0.1:4000/v1');
    for (const bad of ['127.0.0.1:4000', 'ftp://x', 'http://user:pw@host/v1', 'http://host/v1?key=1', '']) {
      expect(() => normalizeBaseURL(bad)).toThrow(AIError);
    }
  });
});

describe('what reaches the person\'s server, and what comes back', () => {
  it('no credential from the environment rides along with the key', async () => {
    const saved = { token: process.env.ANTHROPIC_AUTH_TOKEN, headers: process.env.ANTHROPIC_CUSTOM_HEADERS };
    process.env.ANTHROPIC_AUTH_TOKEN = 'env-token-should-stay-home';
    process.env.ANTHROPIC_CUSTOM_HEADERS = 'Authorization: Bearer env-header-token\nX-Api-Key: env-key';
    try {
      const ai = createAI({ host: new FakeHost(tmpDir()), settingsDir: tmpDir(), secretStore: fakeSafeStorage, localClaude: { bin: null } });
      expect((await ai.saveConnection({ label: 'P', kind: 'anthropic', baseURL: mock.origin, model: 'mock-small', key: KEY })).error).toBeUndefined();
      const h = mock.requests.at(-1)!.headers;
      expect(h['x-api-key']).toBe(KEY);
      expect(h.authorization).toBeUndefined();
      // the Claude key path drops the env token too (it is still sent to Anthropic's own host otherwise)
      await new AnthropicProvider({ apiKey: KEY, baseURL: mock.origin, model: 'mock-small', maxRetries: 0 }).complete(sayOk);
      expect(mock.requests.at(-1)!.headers.authorization ?? '').not.toContain('env-token');
    } finally {
      for (const [k, v] of [['ANTHROPIC_AUTH_TOKEN', saved.token], ['ANTHROPIC_CUSTOM_HEADERS', saved.headers]] as const) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }
  });

  it('a server that echoes the key in an error does not put it in the error text', async () => {
    mock.chatHandlers.push((_b, res) => res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: `key ${KEY} is not allowed for this route` } })));
    const e = await caught(new OpenAICompatibleProvider({ baseURL: `${mock.origin}/v1`, apiKey: KEY, model: 'mock-small' }).complete(sayOk));
    expect(e.message).toContain('[key]');
    expect(JSON.stringify([e.message, e.toJSON()])).not.toContain(KEY);
  });

  it('an answer with no message is not an AI server; a cut-off answer still proves the connection', async () => {
    const p = new OpenAICompatibleProvider({ baseURL: `${mock.origin}/v1`, apiKey: KEY, model: 'mock-small' });
    for (const body of ['{"choices":[]}', '{"choices":[{"message":{},"finish_reason":"stop"}]}']) {
      mock.chatHandlers.push((_b, res) => res.writeHead(200, { 'content-type': 'application/json' }).end(body));
      expect((await caught(p.complete(sayOk))).code, body).toBe('connection_wrong_address');
    }
    // the same tool-call id twice: the second gets its own, so each result still matches one call
    mock.chatHandlers.push((_b, res) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [
      { id: 'dup', type: 'function', function: { name: 'set_cut', arguments: '{}' } }, { id: 'dup', type: 'function', function: { name: 'set_cut', arguments: '{}' } },
    ] }, finish_reason: 'tool_calls' }] })));
    const ids = (await p.complete(sayOk)).toolCalls.map((c) => c.id);
    expect(ids[0]).toBe('dup');
    expect(new Set(ids).size).toBe(2);
    mock.chatHandlers.push((_b, res) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { content: 'O' }, finish_reason: 'length' }] })));
    expect((await caught(p.complete(sayOk))).code).toBe('connection_truncated');
    mock.chatHandlers.push((_b, res) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { content: 'O' }, finish_reason: 'length' }] })));
    const ai = createAI({ host: new FakeHost(tmpDir()), settingsDir: tmpDir(), secretStore: fakeSafeStorage, localClaude: { bin: null } });
    expect((await ai.saveConnection({ label: 'W', kind: 'openai', baseURL: `${mock.origin}/v1`, model: 'mock-small', key: KEY })).error).toBeUndefined();
  });

  it('an error inside an Anthropic stream keeps its meaning (busy, not a wrong address)', async () => {
    const s = http.createServer((_q, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } })}\n\n`);
    });
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    try {
      const e = await caught(new AnthropicProvider({ id: 'custom', apiKey: KEY, baseURL: `http://127.0.0.1:${(s.address() as any).port}`, model: 'm', maxRetries: 0 }).complete(sayOk));
      expect(e.code).toBe('connection_busy');
    } finally { s.closeAllConnections(); s.close(); }
  });
});

describe('model list', () => {
  it('preselects the preferred model, not the first one listed, and nothing when none is known', () => {
    expect(suggestedModel(['claude-3-5-haiku-20241022', 'gpt-5.6-luna', 'claude-sonnet-4-5-20250929', 'claude-sonnet-5-5', 'claude-opus-5'])).toBe('claude-sonnet-5-5');
    expect(suggestedModel(['claude-3-5-haiku-20241022', 'anthropic/claude-sonnet-4-5-20250929'])).toBe('anthropic/claude-sonnet-4-5-20250929');
    expect(suggestedModel(['claude-3-5-haiku-20241022', 'llama-3.3-70b'])).toBeNull();
  });

  it('reads GET /models when the server answers it, else nothing', async () => {
    expect(await listConnectionModels('openai', `${mock.origin}/v1`, KEY)).toEqual({ models: ['mock-small', 'mock-large'], keyRefused: false });
    expect(mock.requests.at(-1)!.headers.authorization).toBe(`Bearer ${KEY}`);
    expect((await listConnectionModels('anthropic', mock.origin, KEY)).models).toEqual(['mock-small', 'mock-large']);
    expect(mock.requests.at(-1)!.headers['x-api-key']).toBe(KEY);
    // refused for the key, not missing: the form asks for the key instead of blaming the server
    expect(await listConnectionModels('openai', `${mock.origin}/v1`, null)).toEqual({ models: [], keyRefused: true });
    expect(await listConnectionModels('openai', `${mock.origin}/nothing`, KEY)).toEqual({ models: [], keyRefused: false });
  });
});

describe('saved connections (createAI)', () => {
  const make = (secretStore: SecretStore | undefined = fakeSafeStorage) => {
    const settingsDir = tmpDir();
    return { settingsDir, ai: createAI({ host: new FakeHost(tmpDir()), settingsDir, secretStore, localClaude: { bin: null } }) };
  };
  const filesIn = (dir: string) => fs.readdirSync(dir).map((f) => ({ f, text: fs.readFileSync(path.join(dir, f)).toString('utf8') }));

  it('saves after one small request works, encrypts the key and never returns it', async () => {
    const { ai, settingsDir } = make();
    const r = await ai.saveConnection({ label: 'Work', kind: 'openai', baseURL: `${mock.origin}/v1`, model: 'mock-small', key: KEY });
    expect(r.error).toBeUndefined();
    expect(r.status).toMatchObject({ id: 'custom', connected: true, label: 'Work', detail: 'mock-small' });
    const check = mock.requests.at(-1)!;
    expect(check.path).toBe('/v1/chat/completions');
    expect(check.body.tools).toBeUndefined();

    // on disk: one encrypted key file, the key in no file in clear text
    const files = filesIn(settingsDir);
    expect(files.map((x) => x.f).sort()).toEqual(['ai-settings.json', `connection-${r.connection!.id}.bin`]);
    for (const x of files) expect(x.text).not.toContain(KEY);
    expect(fakeSafeStorage.decryptString(fs.readFileSync(path.join(settingsDir, `connection-${r.connection!.id}.bin`)))).toBe(KEY);
    // what the app gets back holds no key
    const list = await ai.connections();
    expect(list).toEqual([{ id: r.connection!.id, label: 'Work', kind: 'openai', baseURL: `${mock.origin}/v1`, model: 'mock-small', hasKey: true, active: true }]);
    expect(JSON.stringify([r, list, await ai.providers(), await ai.active()])).not.toContain(KEY);

    // it is now the AI editor, and its requests carry the key
    expect((await ai.active()).id).toBe('custom');
    expect((await ai.testConnection()).reply).toBe('OK');
    expect(mock.requests.at(-1)!.headers.authorization).toBe(`Bearer ${KEY}`);
  });

  it('a failing check saves nothing and names the field to fix', async () => {
    const { ai, settingsDir } = make();
    const cases: [Partial<Parameters<typeof ai.saveConnection>[0]>, string, string][] = [
      [{ key: 'wrong' }, 'connection_bad_key', 'key'],
      [{ model: 'nope' }, 'connection_model', 'model'],
      [{ baseURL: mock.origin }, 'connection_wrong_address', 'address'],
      [{ baseURL: 'localhost:4000' }, 'connection_bad_address', 'address'],
      [{ label: '  ' }, 'connection_no_label', 'label'],
      [{ model: '' }, 'connection_no_model', 'model'],
    ];
    for (const [patch, code, field] of cases) {
      const r = await ai.saveConnection({ label: 'Work', kind: 'openai', baseURL: `${mock.origin}/v1`, model: 'mock-small', key: KEY, ...patch });
      expect(r.error, code).toMatchObject({ code, field });
      expect(r.status.connected).toBe(false);
    }
    expect(fs.readdirSync(settingsDir)).toEqual([]);
    expect(await ai.connections()).toEqual([]);
  });

  it('Anthropic-compatible: needs a key, checks through the Messages API', async () => {
    const { ai } = make();
    expect((await ai.saveConnection({ label: 'Proxy', kind: 'anthropic', baseURL: mock.origin, model: 'mock-large' })).error).toMatchObject({ code: 'connection_no_key', field: 'key' });
    const r = await ai.saveConnection({ label: 'Proxy', kind: 'anthropic', baseURL: mock.origin, model: 'mock-large', key: KEY });
    expect(r.error).toBeUndefined();
    expect(mock.requests.at(-1)).toMatchObject({ path: '/v1/messages', body: { model: 'mock-large' } });
    expect(mock.requests.at(-1)!.headers['x-api-key']).toBe(KEY);
    expect((await ai.testConnection()).provider).toBe('custom');
  });

  it('editing keeps the stored key until a new one is entered, but never sends it to a new address', async () => {
    const { ai, settingsDir } = make();
    const { connection } = await ai.saveConnection({ label: 'Work', kind: 'openai', baseURL: `${mock.origin}/v1`, model: 'mock-small', key: KEY });
    const id = connection!.id;
    const edited = await ai.saveConnection({ id, label: 'Home', kind: 'openai', baseURL: `${mock.origin}/v1`, model: 'mock-large', key: '' });
    expect(edited.error).toBeUndefined();
    expect(mock.requests.at(-1)!.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(await ai.connections()).toMatchObject([{ id, label: 'Home', model: 'mock-large', hasKey: true }]);

    const other = new MockCompatible(); await other.start();
    try {
      const moved = await ai.saveConnection({ id, label: 'Home', kind: 'openai', baseURL: `${other.origin}/v1`, model: 'mock-small' });
      expect(moved.error).toMatchObject({ code: 'connection_key_new_address', field: 'key' });
      expect(other.requests).toEqual([]);
      expect((await ai.connectionModels({ id, kind: 'openai', baseURL: `${other.origin}/v1` })).models).toEqual([]);
      expect(other.requests.every((q) => !q.headers.authorization)).toBe(true);
      // the stored key does go to its own address for the model list
      expect((await ai.connectionModels({ id, kind: 'openai', baseURL: `${mock.origin}/v1` })).models).toEqual(['mock-small', 'mock-large']);
    } finally { await other.stop(); }

    await ai.removeConnection(id);
    expect(await ai.connections()).toEqual([]);
    expect(fs.readdirSync(settingsDir)).toEqual(['ai-settings.json']);
    expect((await ai.active()).id).toBe('none');
  });

  it('two connections: pick one, removing the one in use falls back', async () => {
    const { ai } = make();
    const a = (await ai.saveConnection({ label: 'A', kind: 'openai', baseURL: `${mock.origin}/v1`, model: 'mock-small', key: KEY })).connection!;
    const b = (await ai.saveConnection({ label: 'B', kind: 'anthropic', baseURL: mock.origin, model: 'mock-small', key: KEY })).connection!;
    expect((await ai.active()).connectionId).toBe(b.id);
    await ai.setActive('custom', a.id);
    expect(await ai.active()).toMatchObject({ id: 'custom', label: 'A', connectionId: a.id });
    expect((await ai.connections()).map((c) => [c.label, c.active])).toEqual([['A', true], ['B', false]]);
    await expect(ai.setActive('custom', 'c_00000000')).rejects.toMatchObject({ code: 'not_available' });
    await ai.removeConnection(a.id);
    expect((await ai.active()).id).toBe('none');
    await expect(ai.removeConnection('../claude-key')).rejects.toMatchObject({ code: 'connection_gone' });
  });

  it('changes run one at a time: a slow save cannot undo a later one', async () => {
    const { ai } = make();
    const { connection } = await ai.saveConnection({ label: 'Work', kind: 'openai', baseURL: `${mock.origin}/v1`, model: 'mock-small', key: KEY });
    mock.chatHandlers.push((_b, res) => setTimeout(() => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }] })), 300));
    const slow = ai.saveConnection({ id: connection!.id, label: 'One', kind: 'openai', baseURL: `${mock.origin}/v1`, model: 'mock-small' });
    const fast = ai.saveConnection({ id: connection!.id, label: 'Two', kind: 'openai', baseURL: `${mock.origin}/v1`, model: 'mock-large' });
    await Promise.all([slow, fast]);
    expect(await ai.connections()).toMatchObject([{ label: 'Two', model: 'mock-large' }]);
  });

  it('a failed key replacement keeps the key that works', async () => {
    let encrypt = true;
    const store: SecretStore = { ...fakeSafeStorage, isEncryptionAvailable: () => encrypt };
    const { ai, settingsDir } = make(store);
    const { connection } = await ai.saveConnection({ label: 'Work', kind: 'openai', baseURL: `${mock.origin}/v1`, model: 'mock-small', key: KEY });
    mock.opts.key = null; // the server takes any key, so only storing can fail
    encrypt = false;
    const r = await ai.saveConnection({ id: connection!.id, label: 'Work', kind: 'openai', baseURL: `${mock.origin}/v1`, model: 'mock-small', key: 'sk-new' });
    expect(r.error).toMatchObject({ code: 'no_secure_storage', field: 'key' });
    expect(fakeSafeStorage.decryptString(fs.readFileSync(path.join(settingsDir, `connection-${connection!.id}.bin`)))).toBe(KEY);
  });

  it('no safe place for the key: says so and saves nothing', async () => {
    const { ai, settingsDir } = make({ ...fakeSafeStorage, isEncryptionAvailable: () => false });
    const r = await ai.saveConnection({ label: 'Work', kind: 'openai', baseURL: `${mock.origin}/v1`, model: 'mock-small', key: KEY });
    expect(r.error).toMatchObject({ code: 'no_secure_storage', field: 'key' });
    expect(fs.readdirSync(settingsDir)).toEqual([]);
  });
});
