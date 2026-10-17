import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { SiwcAuth, OpenAIResponsesProvider, listChatGPTModels, AIError, SecretStore } from '../src';
import { MockOpenAI, fakeBrowser, sse } from './mockOpenAI';
import { tmpDir } from './helpers';

/** Reversible fake of Electron safeStorage (proves we never write tokens in clear text when it exists). */
const fakeSafeStorage: SecretStore = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(Buffer.from(s, 'utf8').map((b) => b ^ 0x5a)),
  decryptString: (b) => Buffer.from(b.map((x) => x ^ 0x5a)).toString('utf8'),
};

let mock: MockOpenAI;
let dir: string;
beforeEach(async () => { mock = new MockOpenAI(); await mock.start(); dir = tmpDir('siwc '); });
afterEach(async () => { await mock.stop(); });

const auth = (extra: Partial<ConstructorParameters<typeof SiwcAuth>[0]> = {}) =>
  new SiwcAuth({ settingsDir: dir, secretStore: fakeSafeStorage, issuer: mock.origin, redirectPort: 0, ...extra });

describe('Sign in with ChatGPT (mock server)', () => {
  it('first sign-in: dynamic registration, PKCE S256, loopback, host id, scopes, encrypted storage', async () => {
    const a = auth();
    const urls: string[] = [];
    const s = await a.signIn(fakeBrowser(urls));
    expect(s).toMatchObject({ connected: true, planUsage: true, email: 'person@example.com' });
    const q = mock.authorizeRequests[0];
    expect(q.get('client_id')).toBe('dynamic_agent_client');
    expect(q.get('agent_name_hint')).toBe('Reel Studio');
    expect(q.get('ext_agent_host_id')).toMatch(/^urn:uuid:[0-9a-f-]{36}$/);
    expect(q.get('scope')).toBe('openid profile email offline_access resource.invoke chatgpt.tokens.use.direct');
    expect(q.get('resource')).toBe('https://api.openai.com/v1');
    expect(q.get('response_type')).toBe('code');
    expect(q.get('code_challenge_method')).toBe('S256');
    expect(q.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/);
    expect(q.get('state')!.length).toBeGreaterThan(30);
    expect(q.get('nonce')!.length).toBeGreaterThan(30);
    expect(q.has('id_token_hint')).toBe(false);
    // token exchange used the issued client id + verifier matching the challenge
    const tr = mock.tokenRequests[0];
    expect(tr.get('client_id')).toBe('oaiapp_mock123');
    expect(createHash('sha256').update(tr.get('code_verifier')!).digest('base64url')).toBe(q.get('code_challenge'));
    expect(tr.get('redirect_uri')).toBe(q.get('redirect_uri'));
    expect(tr.has('client_secret')).toBe(false);
    // storage: account metadata plain, credentials encrypted, never clear-text tokens on disk
    const acct = JSON.parse(fs.readFileSync(path.join(dir, 'chatgpt-account.json'), 'utf8'));
    expect(acct).toMatchObject({ clientId: 'oaiapp_mock123', subject: 'user-sub-1' });
    expect(fs.existsSync(path.join(dir, 'chatgpt-credentials.json'))).toBe(false);
    const enc = fs.readFileSync(path.join(dir, 'chatgpt-credentials.bin'));
    expect(enc.toString('utf8')).not.toMatch(/at_/);
    expect(fakeSafeStorage.decryptString(enc)).toMatch(/"access_token":"at_/);
  });

  it('host id is stable across sign-ins; reauth reuses the issued client id without agent_name_hint', async () => {
    const a = auth();
    await a.signIn(fakeBrowser());
    const host1 = mock.authorizeRequests[0].get('ext_agent_host_id');
    await a.signOut();
    await auth().signIn(fakeBrowser());
    const q = mock.authorizeRequests[1];
    expect(q.get('ext_agent_host_id')).toBe(host1);
    expect(q.get('client_id')).toBe('oaiapp_mock123');
    expect(q.has('agent_name_hint')).toBe(false);
    expect(q.get('login_hint')).toBe('person@example.com');
  });

  it('declined consent gives a friendly message and stores no tokens', async () => {
    mock.opts.deny = true;
    const err: any = await auth().signIn(fakeBrowser()).catch((e) => e);
    expect(err).toBeInstanceOf(AIError);
    expect(err.code).toBe('chatgpt_declined');
    expect(err.userMessage).not.toMatch(/—/);
    expect(fs.existsSync(path.join(dir, 'chatgpt-credentials.bin'))).toBe(false);
  });

  it('signed in without plan permission: connected but plan usage off, inference refused', async () => {
    mock.opts.omitPlanScope = true;
    const a = auth();
    const s = await a.signIn(fakeBrowser());
    expect(s).toMatchObject({ connected: true, planUsage: false });
    await expect(a.accessToken()).rejects.toMatchObject({ code: 'chatgpt_plan_not_enabled' });
  });

  it('rejects an ID token with the wrong audience or a bad signature', async () => {
    mock.opts.wrongAudience = true;
    await expect(auth().signIn(fakeBrowser())).rejects.toMatchObject({ code: 'chatgpt_invalid_identity' });
    mock.opts.wrongAudience = false; mock.opts.badSignature = true;
    await expect(auth().signIn(fakeBrowser())).rejects.toMatchObject({ code: 'chatgpt_invalid_identity' });
  });

  it('ignores a callback with the wrong state (does not consume the pending sign-in)', async () => {
    const a = auth();
    const s = await a.signIn(async (url) => {
      const r = await fetch(url, { redirect: 'manual' });
      const loc = new URL(r.headers.get('location')!);
      const forged = new URL(loc); forged.searchParams.set('state', 'x'.repeat(43));
      const bad = await fetch(forged);
      expect(bad.status).toBe(400);
      setTimeout(() => { fetch(loc).catch(() => undefined); }, 5);
    });
    expect(s.connected).toBe(true);
  });

  it('refreshes near expiry with rotation, serialized across concurrent callers', async () => {
    mock.opts.accessTtl = 30; // under the 60 s refresh margin
    const a = auth();
    await a.signIn(fakeBrowser());
    const before = mock.tokenRequests.length;
    const [t1, t2, t3] = await Promise.all([a.accessToken(), a.accessToken(), a.accessToken()]);
    expect(t1).toBe(t2); expect(t2).toBe(t3);
    const refreshes = mock.tokenRequests.slice(before);
    expect(refreshes).toHaveLength(1);
    expect(refreshes[0].get('grant_type')).toBe('refresh_token');
    expect(refreshes[0].get('client_id')).toBe('oaiapp_mock123');
    expect(refreshes[0].get('resource')).toBe('https://api.openai.com/v1');
    expect(refreshes[0].has('scope')).toBe(false);
    // the rotated refresh token is the one used next time
    mock.opts.accessTtl = 3600;
    await a.accessToken({ forceRefresh: true });
    expect(mock.tokenRequests.at(-1)!.get('refresh_token')).not.toBe(refreshes[0].get('refresh_token'));
  });

  it('unusable refresh token signs out cleanly; network errors keep credentials', async () => {
    const a = auth();
    await a.signIn(fakeBrowser());
    mock.opts.refreshError = 'refresh_token_reused';
    await expect(a.accessToken({ forceRefresh: true })).rejects.toMatchObject({ code: 'chatgpt_signed_out' });
    expect((await a.session()).connected).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'chatgpt-account.json'), 'utf8')).clientId).toBe('oaiapp_mock123');

    const b = new SiwcAuth({ settingsDir: tmpDir(), secretStore: fakeSafeStorage, issuer: mock.origin, redirectPort: 0 });
    mock.opts.refreshError = undefined;
    await b.signIn(fakeBrowser());
    const flaky = new SiwcAuth({ settingsDir: (b as any).o.settingsDir, secretStore: fakeSafeStorage, issuer: mock.origin, redirectPort: 0,
      fetch: (async (u: any, init: any) => { if (String(u).includes('/token')) throw new Error('ECONNRESET'); return fetch(u, init); }) as any });
    await expect(flaky.accessToken({ forceRefresh: true })).rejects.toMatchObject({ code: 'offline' });
    expect((await flaky.session()).connected).toBe(true);
  });

  it('sign out revokes the refresh token and keeps the registration', async () => {
    const a = auth();
    await a.signIn(fakeBrowser());
    const r = await a.signOut();
    expect(r.remoteRevoked).toBe(true);
    const rv = mock.revokeRequests[0];
    expect(rv.get('token_type_hint')).toBe('refresh_token');
    expect(rv.get('client_id')).toBe('oaiapp_mock123');
    expect(rv.get('token')).toMatch(/^rt_/);
    expect((await a.session()).connected).toBe(false);
  });

  it('falls back to a free port if 1455 is taken', async () => {
    const http = await import('node:http');
    const blocker = http.createServer();
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', r));
    const port = (blocker.address() as any).port;
    try {
      const s = await auth({ redirectPort: port }).signIn(fakeBrowser());
      expect(s.connected).toBe(true);
      expect(new URL(mock.authorizeRequests[0].get('redirect_uri')!).port).not.toBe(String(port));
    } finally { blocker.close(); }
  });
});

describe('Responses API with a ChatGPT token (mock server)', () => {
  async function provider(retryDelays = [1, 1]) {
    const a = auth();
    await a.signIn(fakeBrowser());
    return new OpenAIResponsesProvider({ auth: a, model: 'gpt-mock-1', baseURL: `${mock.origin}/v1`, retryDelays });
  }
  const tools = [{ name: 'set_cut', description: 'cut', parameters: { type: 'object', properties: { keep: { type: 'array', items: { type: 'string' } } }, required: ['keep'], additionalProperties: false } }];

  it('lists models (visibility list only, server order)', async () => {
    const a = auth();
    await a.signIn(fakeBrowser());
    expect(await listChatGPTModels(a, { baseURL: `${mock.origin}/v1` })).toEqual([{ slug: 'gpt-mock-1', displayName: 'GPT Mock' }]);
  });

  it('sends store:false + stream:true, instructions, namespaced strict tools; parses streamed tool calls', async () => {
    const p = await provider();
    mock.responseHandlers.push((_b, res) => sse(res, [
      { type: 'response.output_text.delta', delta: 'Cutting.' },
      { type: 'response.output_item.done', item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'set_cut', arguments: '{"keep":["w1"]}' } },
      { type: 'response.completed', response: { output: [] } },
    ]));
    const r = await p.complete({ system: 'SYS', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], tools });
    expect(r.text).toBe('Cutting.');
    expect(r.toolCalls).toEqual([expect.objectContaining({ id: 'call_1', name: 'set_cut', args: { keep: ['w1'] } })]);
    const { body, auth: authz } = mock.responseBodies[0];
    expect(authz).toMatch(/^Bearer at_/);
    expect(body).toMatchObject({ model: 'gpt-mock-1', instructions: 'SYS', store: false, stream: true });
    expect(body.previous_response_id).toBeUndefined();
    for (const k of ['temperature', 'max_output_tokens', 'metadata', 'user', 'truncation']) expect(body[k]).toBeUndefined();
    expect(body.input.some((i: any) => i.role === 'system')).toBe(false);
    expect(body.tools[0]).toMatchObject({ type: 'namespace', name: 'reel_editor' });
    expect(body.tools[0].tools[0]).toMatchObject({ type: 'function', name: 'set_cut', strict: true });

    // second turn: history is replayed in input (function_call + function_call_output with an image)
    mock.responseHandlers.push((_b, res) => sse(res, [{ type: 'response.completed', response: { output: [{ type: 'message', content: [{ type: 'output_text', text: 'done' }] }] } }]));
    const r2 = await p.complete({ system: 'SYS', tools, messages: [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'assistant', text: 'Cutting.', toolCalls: r.toolCalls },
      { role: 'tool', results: [{ callId: 'call_1', name: 'set_cut', content: '{"ok":true}', images: [{ type: 'image', mime: 'image/png', base64: 'AAAA' }] }] },
    ] });
    expect(r2.text).toBe('done');
    const input = mock.responseBodies[1].body.input;
    expect(input.find((i: any) => i.type === 'function_call')).toMatchObject({ call_id: 'call_1', name: 'set_cut', arguments: '{"keep":["w1"]}' });
    expect(input.find((i: any) => i.type === 'function_call').id).toBeUndefined();
    const out = input.find((i: any) => i.type === 'function_call_output');
    expect(out.output[1]).toEqual({ type: 'input_image', image_url: 'data:image/png;base64,AAAA' });
  });

  it('usage limit (HTTP 429) stops with a friendly message + usage link, no retry', async () => {
    const p = await provider();
    let calls = 0;
    mock.responseHandlers.push((_b, res) => { calls++; res.writeHead(429, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'limit' } })); });
    mock.responseHandlers.push((_b, res) => { calls++; sse(res, [{ type: 'response.completed', response: { output: [] } }]); });
    const err: any = await p.complete({ system: 's', messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }], tools: [] }).catch((e) => e);
    expect(err).toBeInstanceOf(AIError);
    expect(err.code).toBe('chatgpt_usage_limit');
    expect(err.link).toBe('https://chatgpt.com/settings/usage');
    expect(err.userMessage).toMatch(/limit/);
    expect(err.userMessage).not.toMatch(/—|LUFS|API/);
    expect(err.retryable).toBe(false);
    expect(calls).toBe(1);
  });

  it('usage limit arriving mid-stream as response.failed is handled the same way', async () => {
    const p = await provider();
    mock.responseHandlers.push((_b, res) => sse(res, [
      { type: 'response.output_text.delta', delta: 'Start' },
      { type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_limit_exceeded' } } },
    ]));
    await expect(p.complete({ system: 's', messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }], tools: [] })).rejects.toMatchObject({ code: 'chatgpt_usage_limit' });
  });

  it('temporary 503 retries with backoff; 401 refreshes once; interrupted stream is an error', async () => {
    const p = await provider();
    mock.responseHandlers.push((_b, res) => res.writeHead(503, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { code: 'subscription_sharing_usage_unavailable' } })));
    mock.responseHandlers.push((_b, res) => sse(res, [{ type: 'response.output_text.delta', delta: 'ok' }, { type: 'response.completed', response: { output: [] } }]));
    expect((await p.complete({ system: 's', messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }], tools: [] })).text).toBe('ok');

    mock.validAccess.clear(); // server forgot our token -> 401 -> refresh -> retry
    const n = mock.tokenRequests.length;
    expect((await p.complete({ system: 's', messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }], tools: [] })).text).toBe('ok');
    expect(mock.tokenRequests.length).toBe(n + 1);

    mock.responseHandlers.push((_b, res) => sse(res, [{ type: 'response.output_text.delta', delta: 'par' }], { cut: true }));
    await expect(p.complete({ system: 's', messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }], tools: [] })).rejects.toMatchObject({ code: 'chatgpt_stream' });
  });

  it('maps the documented error codes', async () => {
    const { mapResponsesError } = await import('../src');
    expect(mapResponsesError(403, { error: { code: 'subscription_sharing_user_not_eligible' } }).code).toBe('chatgpt_not_eligible');
    expect(mapResponsesError(400, { error: { code: 'subscription_sharing_unsupported_capability', param: 'tools' } }).code).toBe('chatgpt_unsupported');
    expect(mapResponsesError(401, { error: { code: 'subscription_sharing_invalid_user' } }).code).toBe('chatgpt_signed_out');
    expect(mapResponsesError(403, { detail: 'region' }).code).toBe('chatgpt_restricted');
    expect(mapResponsesError(503, { detail: 'down' }).retryable).toBe(true);
    expect(mapResponsesError(429, {}).link).toBe('https://chatgpt.com/settings/usage');
  });
});

describe('tool encoding fallback', () => {
  it('a 400 on tools retries once with flat function tools', async () => {
    const a = auth();
    await a.signIn(fakeBrowser());
    const p = new OpenAIResponsesProvider({ auth: a, model: 'gpt-mock-1', baseURL: `${mock.origin}/v1`, retryDelays: [1] });
    mock.responseHandlers.push((_b, res) => res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { type: 'invalid_request_error', param: 'tools[0].type', message: 'Invalid value: namespace' } })));
    mock.responseHandlers.push((_b, res) => sse(res, [{ type: 'response.completed', response: { output: [] } }]));
    const tools = [{ name: 'finish', description: 'done', parameters: { type: 'object', properties: {}, required: [], additionalProperties: false } }];
    await p.complete({ system: 's', tools, messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] });
    expect(mock.responseBodies[0].body.tools[0].type).toBe('namespace');
    expect(mock.responseBodies[1].body.tools[0]).toMatchObject({ type: 'function', name: 'finish' });
  });
});
