import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { AIError, createAI, loadProject, saveProject, type SecretStore } from '../src';
import { mapConnectionError } from '../src/providers/connection';
import { ClaudeCliProvider } from '../src/providers/cli';
import { hubProvider } from '../src/providers/hub';
import { FakeHub } from './fakeHub';
import { fakeCli } from './fake-cli';
import { FakeHost, ScriptedModel, call, firstVersion, makeProject, tinyPng, tmpDir } from './helpers';

const fakeSafeStorage: SecretStore = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(Buffer.from(s, 'utf8').map((b) => b ^ 0x5a)),
  decryptString: (b) => Buffer.from(b.map((x) => x ^ 0x5a)).toString('utf8'),
};
const caught = (p: Promise<unknown>) => p.then(() => { throw new Error('expected a failure'); }, (e) => e as AIError);

let hub: FakeHub;
let dir: string;
let roles: Record<string, string>;
const make = () => createAI({ host: new FakeHost(tmpDir()), settingsDir: dir, secretStore: fakeSafeStorage, roleModels: () => roles });
beforeEach(async () => {
  hub = new FakeHub();
  await hub.start();
  dir = tmpDir();
  roles = {};
});
afterEach(async () => { await hub.stop(); });

describe('CLIProxyAPI as the editor', () => {
  it('keeps the key in the encrypted store, says where it came from, and saves nothing for a refused key', async () => {
    const ai = make();
    const bad = await ai.saveHub({ origin: hub.origin, key: 'stale-key', keySource: '/opt/homebrew/etc/cliproxyapi.conf' });
    expect(bad.error?.code).toBe('hub_key');
    expect(await ai.connections()).toEqual([]);

    const r = await ai.saveHub({ origin: `${hub.origin}/`, key: hub.key, keySource: '/opt/homebrew/etc/cliproxyapi.conf' });
    expect(r.status.connected).toBe(true);
    expect(r.status.label).toBe('CLIProxyAPI');
    const [c] = await ai.connections();
    expect(c).toMatchObject({ kind: 'cliproxy', baseURL: hub.origin, keySource: '/opt/homebrew/etc/cliproxyapi.conf', hasKey: true, active: true, hasManagementKey: false });
    // the suggested model, not the hub's first one
    expect(c.model).toBe('claude-sonnet-5-5');
    for (const f of fs.readdirSync(dir)) expect(fs.readFileSync(path.join(dir, f)).includes(hub.key)).toBe(false);
    expect(fakeSafeStorage.decryptString(fs.readFileSync(path.join(dir, `connection-${c.id}.bin`)))).toBe(hub.key);

    // connecting again updates the one hub instead of adding a second
    await ai.saveHub({ origin: hub.origin, key: hub.key, keySource: 'typed' });
    expect((await ai.connections()).map((x) => x.keySource)).toEqual(['typed']);
  });

  it('sends a Claude model to Messages and a GPT model to Chat Completions, each with its reasoning level', async () => {
    const ai = make();
    await ai.saveHub({ origin: hub.origin, key: hub.key, keySource: 'typed' });
    roles = { editor: 'claude-opus-5-5(high)', checker: 'gpt-6.1-sol(medium)' };

    const claude = await ai.testConnection(undefined, 'editor');
    expect(claude).toMatchObject({ reply: 'OK', model: 'claude-opus-5-5(high)' });
    expect(claude.ms).toBeGreaterThanOrEqual(0);
    expect(hub.requests.at(-1)).toMatchObject({ path: '/v1/messages', header: 'x-api-key', key: 'client', model: 'claude-opus-5-5(high)' });

    await ai.testConnection(undefined, 'checker');
    expect(hub.requests.at(-1)).toMatchObject({ path: '/v1/chat/completions', header: 'bearer', key: 'client', model: 'gpt-6.1-sol(medium)' });

    // a stage left on Auto uses the hub connection's own model
    await ai.testConnection(undefined, 'planner');
    expect(hub.requests.at(-1)).toMatchObject({ path: '/v1/messages', model: 'claude-sonnet-5-5' });
  });

  it('records what the hub answered with: the model it named and the reasoning level asked for, with no CLI version', async () => {
    const p = hubProvider({ origin: hub.origin, key: hub.key, choice: 'gpt-6.1-sol(medium)', supportsImages: false });
    const r = await p.complete({ system: '', messages: [{ role: 'user', content: [{ type: 'text', text: 'Say OK.' }] }], tools: [], jsonOnly: true });
    expect(r.provenance).toEqual({
      provider: 'custom', requestedModel: 'gpt-6.1-sol(medium)', reportedModels: ['gpt-6.1-sol(medium)'], cliVersion: 'not reported', effort: 'medium',
      usage: { input: 9, output: 1, cacheRead: 'not reported', cacheWrite: 'not reported' },
    });
  });

  it('lists models with the hub’s names, levels and order, without hidden ones; ids when it has no catalog', async () => {
    const ai = make();
    await ai.saveHub({ origin: hub.origin, key: hub.key, keySource: 'typed' });
    const models = await ai.editorModels();
    expect(models.map((m) => m.id)).toEqual(['gpt-6.1-sol', 'gpt-6-luna', 'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5']);
    expect(models[2]).toMatchObject({ name: 'Claude Sonnet 5.5', family: 'claude', efforts: ['low', 'medium', 'high', 'max'], defaultEffort: 'medium' });
    expect(models[0]).toMatchObject({ name: 'GPT 6.1 Sol', family: 'gpt', defaultEffort: 'low' });

    hub.noCatalog = true;
    const plain = await make().editorModels(); // a fresh app: nothing cached
    expect(plain.find((m) => m.id === 'claude-opus-5-5')).toMatchObject({ name: 'Claude Opus 5.5', family: 'claude', efforts: [] });
    expect(plain.some((m) => m.id === 'gpt-image-2')).toBe(true); // no catalog says it is hidden
  });

  it('says which accounts hit a limit, when they reset, and which model runs on other accounts', async () => {
    const ai = make();
    await ai.saveHub({ origin: hub.origin, key: hub.key, keySource: 'typed' });
    hub.limited = { family: 'claude', resetSeconds: 3720 };
    const before = Date.now();
    const e = await caught(ai.testConnection(undefined, 'editor'));
    expect(e.code).toBe('connection_limited');
    // no management key, so the accounts are unknown: what the hub said, by display name, and an unverified suggestion
    expect(e.userMessage).toMatch(/^CLIProxyAPI says Claude Sonnet 5\.5’s accounts are all resting until .+ \(in 1 h 2 min\)\. Add its management key in Settings, under Editor, to see which accounts\. If your ChatGPT accounts have room, you could try GPT 6\.1 Sol\. Choose it in Settings, under Editor\.$/);
    expect(Date.parse(e.resetsAt!) - before).toBeGreaterThanOrEqual(3720_000 - 1000);
  });

  it('reads accounts, plans and limits with the management key, and refuses a wrong one without saving it', async () => {
    const ai = make();
    await ai.saveHub({ origin: hub.origin, key: hub.key, keySource: 'typed' });
    expect(await ai.editorAccounts()).toEqual({ accounts: [], needsManagementKey: true });

    const wrong = await caught(ai.setHubManagementKey('not-the-right-key'));
    expect(wrong.code).toBe('hub_management_key');
    expect((await ai.connections())[0].hasManagementKey).toBe(false);

    hub.accounts = [...hub.accounts, { provider: 'claude', email: 'old@example.com', used: [0, 0], resetsInMin: [1, 1], broken: true }];
    await ai.setHubManagementKey(hub.managementKey);
    const { accounts } = await ai.editorAccounts();
    expect(accounts.map((a) => [a.provider, a.name, a.plan])).toEqual([
      ['claude', 'maya@example.com', undefined], ['claude', 'studio@example.com', undefined], ['codex', 'maya@example.com', 'Pro'], ['claude', 'old@example.com', undefined],
    ]);
    expect(accounts[0].windows.map((w) => [w.label, w.left])).toEqual([['5-hour', 62], ['Weekly', 39]]);
    expect(accounts[1].windows[0]).toMatchObject({ label: '5-hour', left: 0 });
    expect(Date.parse(accounts[1].windows[0].resetsAt!)).toBeGreaterThan(Date.now() + 40 * 60_000);
    expect(accounts[2].windows.map((w) => [w.label, w.left])).toEqual([['5-hour', 88], ['Weekly', 96]]);
    expect(accounts[3]).toMatchObject({ windows: [], problem: 'Couldn’t read this account’s limits.' });
    // the management key only ever went to the management API, and the client key never did
    expect(hub.requests.filter((r) => r.key === 'management').every((r) => r.path.startsWith('/v0/management/'))).toBe(true);
    expect(hub.requests.filter((r) => r.path.startsWith('/v0/')).every((r) => r.key !== 'client')).toBe(true);

    hub.managementOff = true;
    expect((await ai.editorAccounts()).problem).toMatch(/management API is off/);
  });
});

describe('Claude Code at its limit', () => {
  it('names the window and its reset time, and keeps the windows it reported', async () => {
    const resetsAt = Math.round(Date.now() / 1000) + 14 * 3600;
    const event = { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt, rateLimitType: 'seven_day', unifiedWindows: {
      five_hour: { utilization: 0, resetsAt: resetsAt - 3600, status: 'allowed' },
      seven_day: { utilization: 1, resetsAt, status: 'rejected' },
    } } };
    const result = { type: 'result', is_error: true, result: 'You have hit your weekly limit · resets soon', api_error_status: 429 };
    const bin = fakeCli('claude', { stdout: `${JSON.stringify(event)}\n${JSON.stringify(result)}` });
    const e = await caught(new ClaudeCliProvider({ bin }).complete({ system: '', messages: [{ role: 'user', content: [{ type: 'text', text: 'OK?' }] }], tools: [], jsonOnly: true }));
    expect(e.code).toBe('cli_limited');
    expect(e.userMessage).toMatch(/^The account in your Claude Code app has hit its weekly limit\. It resets (tomorrow )?at .+ \(in 14 h\)\.$/);
    expect(e.resetsAt).toBe(new Date(resetsAt * 1000).toISOString());
    expect(e.limits).toEqual([
      { label: '5-hour', left: 100, resetsAt: new Date((resetsAt - 3600) * 1000).toISOString() },
      { label: 'Weekly', left: 0, resetsAt: new Date(resetsAt * 1000).toISOString() },
    ]);
  });
});

describe('the model that made a version', () => {
  it('is named the way the notes say it, with its reasoning level, and only for a note that changed something', async () => {
    const { root, dir: project } = await makeProject();
    const host = new FakeHost(root);
    await firstVersion(project, host);
    roles = { editor: 'claude-opus-5-5(high)' };
    const steps = (summary: string, change: boolean) => new ScriptedModel([
      ...(change ? [{ toolCalls: [call('set_gap_cap', { seconds: 0.3 })] }] : []),
      { toolCalls: [call('finish', { summary_for_user: summary })] },
    ]);
    let next = steps('Tightened.', true);
    const ai = createAI({ host, settingsDir: dir, secretStore: fakeSafeStorage, roleModels: () => roles, providerOverride: () => next });
    await ai.saveHub({ origin: hub.origin, key: hub.key, keySource: 'typed' });
    const changed = await ai.applyNote(project, 'tighter', () => undefined);
    expect(changed.version).toBe(2);
    expect(changed.model).toBe('Claude Opus 5.5 · High');
    next = steps('Nothing to change.', false);
    const same = await ai.applyNote(project, 'is it fine?', () => undefined);
    expect(same.model).toBeUndefined();
  });
});

describe('review fixes (r12)', () => {
  it('a Test reply that repeats the key shows [key], never the key', async () => {
    const ai = make();
    await ai.saveHub({ origin: hub.origin, key: hub.key, keySource: 'typed' });
    await ai.setHubManagementKey(hub.managementKey);
    hub.echo = true;
    for (const role of ['editor', 'checker'] as const) {
      roles = { checker: 'gpt-6.1-sol' };
      const r = await ai.testConnection(undefined, role);
      expect(r.reply).toContain('[key]');
      expect(r.reply).not.toContain(hub.key);
    }
  });

  it('a management refusal that repeats its key keeps the key out of the error, its detail and the log line', async () => {
    const ai = make();
    await ai.saveHub({ origin: hub.origin, key: hub.key, keySource: 'typed' });
    hub.managementEcho = true;
    const e = await caught(ai.setHubManagementKey(hub.managementKey));
    expect(e.code).toBe('hub_management');
    for (const text of [e.message, e.userMessage, JSON.stringify(e.toJSON())]) expect(text).not.toContain(hub.managementKey);
    expect(e.message).toBe('management API answered 500');
  });

  it('a stage model the hub no longer lists runs as Auto (the connection’s model), not an error', async () => {
    const ai = make();
    await ai.saveHub({ origin: hub.origin, key: hub.key, keySource: 'typed' });
    roles = { editor: 'claude-opus-9(high)' };
    const r = await ai.testConnection(undefined, 'editor');
    expect(r.model).toBe('claude-sonnet-5-5');
    expect(hub.requests.filter((q) => q.model).at(-1)?.model).toBe('claude-sonnet-5-5');
  });

  it('a text-only model is sent no pictures; a model that takes them is sent them', async () => {
    hub.models = hub.models.map((m) => (m.id === 'gpt-6-luna' ? { ...m, textOnly: true } : m));
    hub.finish = true;
    const { root, dir: project } = await makeProject();
    const p = await loadProject(project);
    p.cut.keep = [{ from: 'w0', to: 'w5' }];
    await saveProject(project, p);
    const asset = 'work/assets/attach-1a2b3c4d-meme.png';
    fs.mkdirSync(path.join(project, 'work', 'assets'), { recursive: true });
    fs.mkdirSync(path.join(project, 'work', 'thumbs'), { recursive: true });
    fs.writeFileSync(path.join(project, asset), tinyPng());
    fs.writeFileSync(path.join(project, 'work', 'thumbs', 'attach-1a2b3c4d-meme.jpg'), tinyPng());
    fs.writeFileSync(path.join(project, `${asset}.attach.json`), JSON.stringify({ asset, name: 'meme.png', kind: 'image', bytes: 64, width: 4, height: 4, thumb: 'work/thumbs/attach-1a2b3c4d-meme.jpg', createdAt: new Date().toISOString() }));
    const ai = createAI({ host: new FakeHost(root), settingsDir: dir, secretStore: fakeSafeStorage, roleModels: () => roles, finalRender: false });
    await ai.saveHub({ origin: hub.origin, key: hub.key, keySource: 'typed' });
    roles = { editor: 'gpt-6-luna' };
    await ai.applyNote(project, 'put this over my face', () => undefined, undefined, { attachments: [asset] });
    expect(hub.requests.filter((q) => q.path === '/v1/chat/completions').at(-1)).toMatchObject({ model: 'gpt-6-luna', images: 0 });
    roles = { editor: 'gpt-6.1-sol' };
    await ai.applyNote(project, 'put this over my face', () => undefined, undefined, { attachments: [asset] });
    expect(hub.requests.filter((q) => q.path === '/v1/chat/completions').at(-1)!.images).toBeGreaterThan(0);
  });

  it('removing CLIProxyAPI deletes its key and its management key', async () => {
    const ai = make();
    await ai.saveHub({ origin: hub.origin, key: hub.key, keySource: 'typed' });
    await ai.setHubManagementKey(hub.managementKey);
    const [c] = await ai.connections();
    expect(fs.existsSync(path.join(dir, `connection-${c.id}-management.bin`))).toBe(true);
    await ai.removeConnection(c.id);
    expect(fs.readdirSync(dir).filter((f) => f.startsWith('connection-'))).toEqual([]);
  });

  it('suggests another model only when it is listed now and its accounts have room', async () => {
    const ai = make();
    await ai.saveHub({ origin: hub.origin, key: hub.key, keySource: 'typed' });
    await ai.setHubManagementKey(hub.managementKey);
    hub.limited = { family: 'claude', resetSeconds: 3600 };
    hub.accounts = hub.accounts.map((a) => (a.provider === 'codex' ? { ...a, used: [100, 40] } : a));
    expect((await caught(ai.testConnection())).userMessage).not.toMatch(/could try/);
    hub.accounts = hub.accounts.map((a) => (a.provider === 'codex' ? { ...a, used: [10, 40] } : a));
    expect((await caught(ai.testConnection())).userMessage).toMatch(/ Your ChatGPT accounts have room: you could try GPT 6\.1 Sol\. Choose it in Settings, under Editor\.$/);
    hub.models = hub.models.filter((m) => m.ownedBy !== 'openai');
    expect((await caught(ai.testConnection())).userMessage).not.toMatch(/could try/);
  });

  it('refuses an address that is not this computer before sending it anything', async () => {
    const asked: string[] = [];
    const ai = createAI({ host: new FakeHost(tmpDir()), settingsDir: dir, secretStore: fakeSafeStorage, fetch: (async (u: string) => { asked.push(String(u)); throw new Error('no'); }) as any });
    const r = await ai.saveHub({ origin: 'http://hub.example.com:8317', key: 'k-123456', keySource: '/etc/cliproxyapi.conf' });
    expect(r.error?.code).toBe('hub_not_local');
    expect(asked).toEqual([]);
    expect(await ai.connections()).toEqual([]);
  });

  it('reads a reset in milliseconds or seconds, and says it doesn’t know one it can’t read, never throwing', () => {
    const ctx = { kind: 'openai' as const, model: 'claude-opus-5-5' };
    const at = Date.now() + 3 * 3600_000;
    expect(mapConnectionError(429, { error: { code: 'model_cooldown', resets_at: at } }, ctx).resetsAt).toBe(new Date(at).toISOString());
    expect(mapConnectionError(429, { error: { code: 'model_cooldown', resets_at: Math.round(at / 1000) } }, ctx).resetsAt).toBe(new Date(Math.round(at / 1000) * 1000).toISOString());
    for (const odd of [9e20, -5, 1e15 * 1e6]) {
      const e = mapConnectionError(429, { error: { code: 'model_cooldown', resets_at: odd, provider: 'claude' } }, ctx);
      expect(e.resetsAt).toBeUndefined();
      expect(e.userMessage).toMatch(/It didn’t say when they reset\.$/);
    }
  });
});

describe('design review and re-check (r12)', () => {
  it('a limit names the account at its limit and the one with room, by display name, without "all at their limit"', async () => {
    const ai = make();
    await ai.saveHub({ origin: hub.origin, key: hub.key, keySource: 'typed' });
    await ai.setHubManagementKey(hub.managementKey);
    hub.limited = { family: 'claude', resetSeconds: 3600 };
    const e = await caught(ai.testConnection());
    expect(e.userMessage).toMatch(/^studio@example\.com is at its 5-hour limit until .+; Claude Sonnet 5\.5 can still use maya@example\.com\. Try again in a minute\./);
    expect(e.userMessage).not.toMatch(/all at their limit|claude-sonnet-5-5/);
    hub.accounts = hub.accounts.map((a) => (a.provider === 'claude' ? { ...a, used: [100, 50] } : a));
    expect((await caught(ai.testConnection())).userMessage).toMatch(/^Every Claude account is at a limit: maya@example\.com is at its 5-hour limit until .+; studio@example\.com is at its 5-hour limit until /);
  });

  it('says what Auto runs for each stage, by name', async () => {
    const ai = make();
    await ai.saveHub({ origin: hub.origin, key: hub.key, keySource: 'typed' });
    const auto = await ai.autoModels();
    expect(auto.editor).toBe('Claude Sonnet 5.5');
    expect(auto.planner).toBe('Claude Sonnet 5.5');
    expect(auto.namer).toBeNull();
  });

  it('a saved CLIProxyAPI that is not a loopback address is never used and never sent either key', async () => {
    const id = 'c_deadbeef';
    const client = 'client-key-0123456789';
    const mgmt = 'management-key-0123456789';
    fs.writeFileSync(path.join(dir, 'ai-settings.json'), JSON.stringify({ active: 'custom', activeConnection: id, connections: [{ id, label: 'CLIProxyAPI', kind: 'cliproxy', baseURL: 'http://hub.example.com:8317', model: 'claude-sonnet-5-5', supportsImages: true }] }));
    fs.writeFileSync(path.join(dir, `connection-${id}.bin`), fakeSafeStorage.encryptString(client));
    fs.writeFileSync(path.join(dir, `connection-${id}-management.bin`), fakeSafeStorage.encryptString(mgmt));
    const sent: string[] = [];
    const spy = (async (u: string, init?: RequestInit) => {
      sent.push(`${u} ${JSON.stringify(init?.headers ?? {})}`);
      throw new Error('offline');
    }) as unknown as typeof fetch;
    const ai = createAI({ host: new FakeHost(tmpDir()), settingsDir: dir, secretStore: fakeSafeStorage, fetch: spy, roleModels: () => ({ editor: 'claude-opus-5-5' }) });
    const st = (await ai.providers()).find((p) => p.id === 'custom')!;
    expect(st).toMatchObject({ connected: false, error: { code: 'hub_not_local' } });
    expect((await ai.active()).id).toBe('none');
    await caught(ai.testConnection());
    expect(await ai.editorModels()).toEqual([]);
    expect(await ai.editorAccounts()).toEqual({ accounts: [] });
    expect(await ai.autoModels()).toEqual({});
    expect((await caught(ai.setHubManagementKey('another-key-0123'))).code).toBe('hub_not_local');
    expect((await caught(ai.setActive('custom', id))).code).toBe('hub_not_local');
    await ai.connectionModels({ kind: 'openai', baseURL: 'http://hub.example.com:8317/v1', id });
    for (const line of sent) for (const secret of [client, mgmt]) expect(line).not.toContain(secret);
  });

  it('refuses a CLIProxyAPI key or management key under 8 characters, so every saved key can be scrubbed', async () => {
    const ai = make();
    expect((await ai.saveHub({ origin: hub.origin, key: 'short7k', keySource: 'typed' })).error?.code).toBe('hub_key_short');
    expect(await ai.connections()).toEqual([]);
    await ai.saveHub({ origin: hub.origin, key: hub.key, keySource: 'typed' });
    expect((await caught(ai.setHubManagementKey('abc'))).code).toBe('hub_key_short');
  });

  it('a chosen model the list can’t confirm is sent, and "no such model" falls back to Auto once, saying so', async () => {
    await make().saveHub({ origin: hub.origin, key: hub.key, keySource: 'typed' });
    hub.listDown = true;
    roles = { editor: 'claude-opus-9' };
    const r = await make().testConnection(undefined, 'editor'); // a fresh app: no list kept
    expect(r.model).toBe('claude-sonnet-5-5');
    expect(r.note).toBe('Edits used Claude Sonnet 5.5, because Claude Opus 9 isn’t offered any more.');
    expect(hub.requests.filter((q) => q.model).map((q) => q.model)).toEqual(['claude-opus-9', 'claude-sonnet-5-5']);
  });

  it('a model whose picture support the hub doesn’t say is sent no pictures', async () => {
    const ai = make();
    await ai.saveHub({ origin: hub.origin, key: hub.key, keySource: 'typed' });
    hub.noCatalog = true;
    const models = await make().editorModels();
    expect(models.length).toBeGreaterThan(0);
    expect(models.every((m) => m.images === false)).toBe(true);
  });
});

