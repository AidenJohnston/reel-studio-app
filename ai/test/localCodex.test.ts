import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { cliEnv, codexCandidates, codexFromLoginShell, CodexCliProvider, createAI, detectCodex, findCodex } from '../src';
import type { Runner } from '../src/providers/localClaude';
import { FakeHost, tmpDir } from './helpers';

// Built in pieces so no key-like string sits in the source.
const KEY_TAIL = ['sk-proj-', 'ab12', '****', 'wxyz'].join('');

/** A fake `codex`: --version answer + login status answer (or a thrown error). */
function cli(o: { version?: { code: number; stdout: string } | Error; status?: { code: number; stdout: string; stderr?: string } | Error }): Runner & { calls: string[][] } {
  const calls: string[][] = [];
  const run = (async (cmd: string, args: string[]) => {
    calls.push([cmd, ...args]);
    const a = args[0] === '--version' ? (o.version ?? { code: 0, stdout: 'codex-cli 0.164.0\n' }) : (o.status ?? { code: 0, stdout: 'Logged in using ChatGPT\n' });
    if (a instanceof Error) throw a;
    return { code: a.code, stdout: a.stdout, stderr: (a as { stderr?: string }).stderr ?? '' };
  }) as Runner & { calls: string[][] };
  run.calls = calls;
  return run;
}

describe('where the Codex app is looked for', () => {
  it('Windows: PATH codex.exe, OpenAI\'s installer folder, its package store, ~/.local/bin, then the npm native exe; never a .cmd shim', () => {
    const W = path.win32;
    const home = 'C:\\Users\\Pat Q';
    const roaming = W.join(home, 'AppData', 'Roaming');
    const scope = W.join(roaming, 'npm', 'node_modules', '@openai', 'codex', 'node_modules', '@openai');
    const list = codexCandidates({ USERPROFILE: home, PATH: 'C:\\Windows\\System32;C:\\Users\\Pat Q\\AppData\\Roaming\\npm' }, 'win32', (d) => {
      if (d === scope) return ['codex-win32-x64', 'codex-something-else'];
      if (d === W.join(scope, 'codex-win32-x64', 'vendor')) return ['x86_64-pc-windows-msvc'];
      return [];
    });
    expect(list).toEqual([
      'C:\\Windows\\System32\\codex.exe',
      'C:\\Users\\Pat Q\\AppData\\Roaming\\npm\\codex.exe',
      'C:\\Users\\Pat Q\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe',
      'C:\\Users\\Pat Q\\.codex\\packages\\standalone\\current\\bin\\codex.exe',
      'C:\\Users\\Pat Q\\.local\\bin\\codex.exe',
      W.join(scope, 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe'),
    ]);
    expect(list.some((p) => /\.cmd$/i.test(p))).toBe(false);
  });

  it('macOS: PATH, OpenAI\'s installer (~/.local/bin, ~/.codex/packages), Homebrew, npm-global, nvm newest first', () => {
    const home = '/Users/x';
    const nvm = path.posix.join(home, '.nvm', 'versions', 'node');
    const list = codexCandidates({ HOME: home, PATH: '/usr/bin' }, 'darwin', (d) => (d === nvm ? ['v20.3.1', 'v22.11.0'] : []));
    expect(list).toEqual([
      '/usr/bin/codex',
      '/Users/x/.local/bin/codex', '/Users/x/.codex/packages/standalone/current/bin/codex',
      '/opt/homebrew/bin/codex', '/usr/local/bin/codex', '/Users/x/.npm-global/bin/codex',
      '/Users/x/.nvm/versions/node/v22.11.0/bin/codex', '/Users/x/.nvm/versions/node/v20.3.1/bin/codex',
      '/Users/x/.volta/bin/codex', '/Users/x/.bun/bin/codex',
    ]);
  });

  it('CODEX_HOME moves the package store (the app\'s test switch uses it)', () => {
    expect(codexCandidates({ HOME: '/Users/x', PATH: '', CODEX_HOME: '/tmp/t/.codex' }, 'darwin', () => [])).toContain('/tmp/t/.codex/packages/standalone/current/bin/codex');
  });

  it('macOS: finds codex outside PATH (Finder gives an app a bare PATH)', () => {
    expect(findCodex({ HOME: '/Users/x', PATH: '' }, 'darwin', (p) => p === '/Users/x/.local/bin/codex')).toBe('/Users/x/.local/bin/codex');
    expect(findCodex({ HOME: '/Users/x', PATH: '' }, 'darwin', () => false)).toBeNull();
  });

  it('the login shell answer counts only as an absolute path to a file that exists', async () => {
    const run: Runner = async () => ({ code: 0, stdout: 'Welcome!\nnot a path\n/Users/x/.local/bin/codex\n', stderr: '' });
    expect(await codexFromLoginShell(run, { SHELL: '/bin/zsh' }, (p) => p === '/Users/x/.local/bin/codex')).toBe('/Users/x/.local/bin/codex');
    expect(await codexFromLoginShell(run, { SHELL: '/bin/zsh' }, () => false)).toBeNull();
  });
});

describe('asking the Codex app if it is signed in', () => {
  it('ready: "Logged in using ChatGPT", version kept', async () => {
    expect(await detectCodex({ bin: '/x/codex', run: cli({}) })).toMatchObject({ state: 'ready', signedIn: true, installed: true, version: '0.164.0', authMethod: 'chatgpt' });
  });

  it('signed out: "Not logged in", exit 1 (measured on 0.164.0)', async () => {
    expect(await detectCodex({ bin: '/x/codex', run: cli({ status: { code: 1, stdout: 'Not logged in\n' } }) }))
      .toMatchObject({ state: 'signed_out', signedIn: false, reason: 'Your Codex app is not signed in yet.' });
  });

  it('an API-key sign-in counts, but no part of the key survives the parse', async () => {
    const r = await detectCodex({ bin: '/x/codex', run: cli({ status: { code: 0, stdout: `Logged in using an API key - ${KEY_TAIL}\n` } }) });
    expect(r).toMatchObject({ state: 'ready', authMethod: 'api_key' });
    expect(JSON.stringify(r)).not.toContain(KEY_TAIL);
  });

  it('missing, broken, slow', async () => {
    expect(await detectCodex({ bin: null })).toMatchObject({ state: 'missing', reason: 'We could not find the Codex app on this computer.' });
    expect(await detectCodex({ bin: '/x/codex', run: cli({ version: { code: 2, stdout: '' } }) })).toMatchObject({ state: 'broken' });
    expect(await detectCodex({ bin: '/x/codex', run: cli({ version: new Error('ENOENT') }) })).toMatchObject({ state: 'broken' });
    expect(await detectCodex({ bin: '/x/codex', run: cli({ status: Object.assign(new Error('slow'), { code: 'cli_timeout' }) }) }))
      .toMatchObject({ state: 'signed_out', reason: 'Your Codex app took too long to answer. Click Check again.' });
  });

  it('runs only --version and login status (never reads ~/.codex, never starts a session)', async () => {
    const run = cli({});
    await detectCodex({ bin: '/x/codex', run });
    expect(run.calls).toEqual([['/x/codex', '--version'], ['/x/codex', 'login', 'status']]);
  });
});

describe('the environment the person\'s own apps get', () => {
  it('no ANTHROPIC_* or OPENAI_* variable, everything else (CODEX_HOME, PATH) kept', () => {
    const env = cliEnv({ PATH: '/bin', OPENAI_API_KEY: 'x', openai_base_url: 'y', ANTHROPIC_API_KEY: 'z', CODEX_HOME: '/c', CLAUDE_CONFIG_DIR: '/d' });
    expect(env).toEqual({ PATH: '/bin', CODEX_HOME: '/c', CLAUDE_CONFIG_DIR: '/d' });
  });
});

describe('ChatGPT (your Codex app) as the AI editor', () => {
  const ai = (o: { run?: Runner; bin?: string | null; settingsDir?: string } = {}) =>
    createAI({ host: new FakeHost(tmpDir()), settingsDir: o.settingsDir ?? tmpDir(), localClaude: { bin: null }, localCodex: { bin: o.bin === undefined ? '/x/codex' : o.bin, run: o.run ?? cli({}) } });

  it('listed for people with its people label, in its real state; detail is the version only', async () => {
    const st = (await ai().providers()).find((p) => p.id === 'codex-cli')!;
    expect(st).toMatchObject({ connected: true, label: 'ChatGPT (your Codex app)', detail: '0.164.0' });
    const out = (await ai({ run: cli({ status: { code: 1, stdout: 'Not logged in' } }) }).providers()).find((p) => p.id === 'codex-cli')!;
    expect(out).toMatchObject({ connected: false, error: { code: 'codex_signed_out' } });
  });

  it('never chosen on its own: only setActive turns it on, and only when ready', async () => {
    const a = ai();
    expect((await a.active()).id).toBe('none');
    await a.setActive('codex-cli');
    expect((await a.active()).id).toBe('codex-cli');
    await expect(ai({ run: cli({ status: { code: 1, stdout: 'Not logged in' } }) }).setActive('codex-cli')).rejects.toMatchObject({ code: 'not_available', message: 'Your Codex app is not signed in yet.' });
  });

  it('edits run the binary the app found, with --ignore-user-config, read-only and ephemeral', () => {
    const p = new CodexCliProvider({ bin: 'C:\\Users\\Pat Q\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe' });
    const args = p.args(['-i', 'a.png'], 'out.txt');
    expect(args.slice(0, 8)).toEqual(['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '--ephemeral', '--color', 'never', '--ignore-user-config']);
    expect(args).toContain('-o');
    expect(args.at(-1)).toBe('-');
    expect((p as any).resolveBin()).toBe('C:\\Users\\Pat Q\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe');
    // never Node + codex.js: inside Electron, process.execPath is Reel Studio itself
    expect((new CodexCliProvider({}) as any).resolveBin()).toBe('codex');
  });
});

describe('retiring "Sign in with ChatGPT"', () => {
  it('a saved session is signed out once (files deleted), the old choice cleared, and the Codex card is told why', async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'chatgpt-credentials.bin'), 'opaque');
    fs.writeFileSync(path.join(dir, 'ai-settings.json'), JSON.stringify({ active: 'chatgpt', claudeModel: 'x' }));
    const a = createAI({ host: new FakeHost(tmpDir()), settingsDir: dir, localClaude: { bin: null }, localCodex: { bin: null } });
    expect(await a.retireSignInWithChatGPT()).toBe(true);
    expect(fs.existsSync(path.join(dir, 'chatgpt-credentials.bin'))).toBe(false);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'ai-settings.json'), 'utf8'));
    expect(saved).toEqual({ claudeModel: 'x', chatgptMoved: true });
    expect((await a.codexStatus()).chatgptMoved).toBe(true);
    expect((await a.active()).id).toBe('none');
    // second start: nothing left to do
    expect(await a.retireSignInWithChatGPT()).toBe(false);
  });

  it('nobody ever signed in: nothing happens, no note', async () => {
    const dir = tmpDir();
    const a = createAI({ host: new FakeHost(tmpDir()), settingsDir: dir, localClaude: { bin: null }, localCodex: { bin: null } });
    expect(await a.retireSignInWithChatGPT()).toBe(false);
    expect(fs.existsSync(path.join(dir, 'ai-settings.json'))).toBe(false);
    expect((await a.codexStatus()).chatgptMoved).toBeUndefined();
  });

  it('choosing either own app clears the note', async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'ai-settings.json'), JSON.stringify({ chatgptMoved: true }));
    const a = createAI({ host: new FakeHost(tmpDir()), settingsDir: dir, localClaude: { bin: null }, localCodex: { bin: '/x/codex', run: cli({}) } });
    await a.setActive('codex-cli');
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'ai-settings.json'), 'utf8'))).toEqual({ active: 'codex-cli' });
  });
});
