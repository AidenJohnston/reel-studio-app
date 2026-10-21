import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { AIError, claudeCandidates, claudeFromLoginShell, createAI, detectLocalClaude, findClaude } from '../src';
import type { Runner } from '../src/providers/localClaude';
import { FakeHost, tmpDir } from './helpers';

// Built in code so no e-mail-like string sits in the source (the public export's leak gate reads every file).
const EMAIL = ['someone', 'mail.test'].join('@');
const ORG_ID = 'org-7f3c1d2e-secret';
const ORG_NAME = 'Acme Private Org';

const authJson = (loggedIn: boolean, extra: Record<string, unknown> = {}) => JSON.stringify({
  loggedIn, authMethod: 'claude.ai', apiProvider: 'firstParty', email: EMAIL, orgId: ORG_ID, orgName: ORG_NAME,
  subscriptionType: 'max', ...extra,
}, null, 2);

/** A fake `claude`: --version answer + auth status answer (or a thrown error). */
function cli(o: { version?: { code: number; stdout: string } | Error; auth?: { code: number; stdout: string; stderr?: string } | Error }): Runner & { calls: string[][] } {
  const calls: string[][] = [];
  const run = (async (cmd: string, args: string[]) => {
    calls.push([cmd, ...args]);
    const a = args[0] === '--version' ? (o.version ?? { code: 0, stdout: '2.1.304 (Claude Code)\n' }) : (o.auth ?? { code: 0, stdout: authJson(true) });
    if (a instanceof Error) throw a;
    return { code: a.code, stdout: a.stdout, stderr: (a as { stderr?: string }).stderr ?? '' };
  }) as Runner & { calls: string[][] };
  run.calls = calls;
  return run;
}
const signedIn = cli({});
const signedOut = cli({ auth: { code: 1, stdout: authJson(false) } });
const noProvider = () => ({ host: new FakeHost(tmpDir()), settingsDir: tmpDir() });

describe('where the Claude Code app is looked for', () => {
  it('macOS: PATH, the native installer, Homebrew, npm-global, nvm (newest first), volta, bun', () => {
    const home = '/Users/x';
    const nvm = path.posix.join(home, '.nvm', 'versions', 'node');
    const list = claudeCandidates({ HOME: home, PATH: '/usr/bin:/bin' }, 'darwin', (d) => (d === nvm ? ['v20.3.1', 'v22.11.0', 'v9.0.0'] : []));
    expect(list).toEqual([
      '/usr/bin/claude', '/bin/claude',
      '/Users/x/.local/bin/claude', '/Users/x/.claude/local/claude',
      '/opt/homebrew/bin/claude', '/usr/local/bin/claude', '/Users/x/.npm-global/bin/claude',
      '/Users/x/.nvm/versions/node/v22.11.0/bin/claude', '/Users/x/.nvm/versions/node/v20.3.1/bin/claude', '/Users/x/.nvm/versions/node/v9.0.0/bin/claude',
      '/Users/x/.volta/bin/claude', '/Users/x/.bun/bin/claude',
    ]);
  });

  it('macOS: finds claude outside PATH (Finder gives an app a bare PATH)', () => {
    const home = '/Users/x';
    expect(findClaude({ HOME: home, PATH: '/usr/bin' }, 'darwin', (p) => p === '/Users/x/.local/bin/claude')).toBe('/Users/x/.local/bin/claude');
    expect(findClaude({ HOME: home, PATH: '' }, 'darwin', (p) => p === '/opt/homebrew/bin/claude')).toBe('/opt/homebrew/bin/claude');
    expect(findClaude({ HOME: home, PATH: '' }, 'darwin', () => false)).toBeNull();
  });

  it('Windows: PATH claude.exe, native installer, WinGet links + packages, npm native exe; never a .cmd shim', () => {
    const W = path.win32;
    const home = 'C:\\Users\\Pat Q';
    const local = W.join(home, 'AppData', 'Local');
    const roaming = W.join(home, 'AppData', 'Roaming');
    const pk = W.join(local, 'Microsoft', 'WinGet', 'Packages');
    const scope = W.join(roaming, 'npm', 'node_modules', '@anthropic-ai');
    const tree: Record<string, string[]> = {
      [pk]: ['Anthropic.ClaudeCode_Microsoft.Winget.Source_8wekyb3d8bbwe', 'Other.Thing_1'],
      [scope]: ['claude-code', 'sdk'],
      [W.join(scope, 'claude-code')]: ['bin', 'cli.js', 'node_modules'],
      [W.join(scope, 'claude-code', 'node_modules', '@anthropic-ai')]: ['claude-code-win32-x64'],
      [W.join(scope, 'claude-code', 'node_modules', '@anthropic-ai', 'claude-code-win32-x64')]: ['claude.exe'],
    };
    const env = { USERPROFILE: home, LOCALAPPDATA: local, APPDATA: roaming, Path: `C:\\Windows;${W.join(roaming, 'npm')}` };
    const list = claudeCandidates(env, 'win32', (d) => tree[d] ?? []);
    expect(list.every((p) => p.endsWith('claude.exe'))).toBe(true);
    expect(list.some((p) => /\.cmd$/i.test(p))).toBe(false);
    expect(list.slice(0, 4)).toEqual([
      'C:\\Windows\\claude.exe', W.join(roaming, 'npm', 'claude.exe'),
      W.join(home, '.local', 'bin', 'claude.exe'), W.join(home, '.claude', 'local', 'claude.exe'),
    ]);
    expect(list).toContain(W.join(local, 'Microsoft', 'WinGet', 'Links', 'claude.exe'));
    expect(list).toContain(W.join(pk, 'Anthropic.ClaudeCode_Microsoft.Winget.Source_8wekyb3d8bbwe', 'claude.exe'));
    expect(list.some((p) => p.includes('Other.Thing'))).toBe(false);
    expect(list).toContain(W.join(scope, 'claude-code', 'bin', 'claude.exe'));
    expect(list).toContain(W.join(scope, 'claude-code', 'node_modules', '@anthropic-ai', 'claude-code-win32-x64', 'claude.exe'));
    expect(list.some((p) => p.includes(W.join(scope, 'sdk')))).toBe(false);
    // the native installer wins over WinGet when both exist (it comes first)
    const both = [W.join(home, '.local', 'bin', 'claude.exe'), W.join(local, 'Microsoft', 'WinGet', 'Links', 'claude.exe')];
    expect(findClaude(env, 'win32', (p) => both.includes(p), (d) => tree[d] ?? [])).toBe(both[0]);
    // npm only: the native exe under node_modules, not the claude.cmd next to it
    const npmExe = W.join(scope, 'claude-code', 'node_modules', '@anthropic-ai', 'claude-code-win32-x64', 'claude.exe');
    expect(findClaude(env, 'win32', (p) => p === npmExe || p === W.join(roaming, 'npm', 'claude.cmd'), (d) => tree[d] ?? [])).toBe(npmExe);
  });

  it('macOS login shell: only an absolute path that exists is accepted, 5 s cap', async () => {
    const seen: { cmd: string; args: string[]; timeoutMs?: number }[] = [];
    const run = (out: string, code = 0): Runner => async (cmd, args, o) => { seen.push({ cmd, args, timeoutMs: o?.timeoutMs }); return { code, stdout: out, stderr: '' }; };
    const real = '/Users/x/.asdf/shims/claude';
    expect(await claudeFromLoginShell(run(`Welcome back!\n${real}\n`), { SHELL: '/bin/zsh' }, (p) => p === real)).toBe(real);
    expect(seen[0]).toEqual({ cmd: '/bin/zsh', args: ['-ilc', 'command -v claude'], timeoutMs: 5000 });
    expect(await claudeFromLoginShell(run('claude: aliased to foo\n'), { SHELL: '/bin/bash' }, () => true)).toBeNull();
    expect(await claudeFromLoginShell(run(`${real}\n`), { SHELL: '/bin/zsh' }, () => false)).toBeNull();
    expect(await claudeFromLoginShell(run('', 1), { SHELL: '/bin/zsh' }, () => true)).toBeNull();
    expect(await claudeFromLoginShell(async () => { throw new AIError('cli_timeout', 'slow'); }, {}, () => true)).toBeNull();
    await claudeFromLoginShell(run(''), { SHELL: 'zsh; rm -rf /' }, () => true);
    expect(seen.at(-1)!.cmd).toBe('/bin/zsh'); // a SHELL that is not a plain absolute path is not run
  });

  it('macOS detection asks the login shell only when nothing was found on disk', async () => {
    const real = '/Users/x/.asdf/shims/claude';
    const calls: string[] = [];
    const run: Runner = async (cmd, args) => {
      calls.push(`${cmd} ${args.join(' ')}`);
      if (cmd === '/bin/zsh') return { code: 0, stdout: `${real}\n`, stderr: '' };
      return args[0] === '--version' ? { code: 0, stdout: '2.1.304 (Claude Code)', stderr: '' } : { code: 0, stdout: authJson(true), stderr: '' };
    };
    const r = await detectLocalClaude({ run, env: { HOME: '/Users/x', PATH: '/usr/bin', SHELL: '/bin/zsh' }, platform: 'darwin', exists: (p) => p === real, listDir: () => [] });
    expect(r).toMatchObject({ state: 'ready', bin: real });
    expect(calls[0]).toBe('/bin/zsh -ilc command -v claude');
    const win = await detectLocalClaude({ run, env: { USERPROFILE: 'C:\\U', PATH: '' }, platform: 'win32', exists: () => false, listDir: () => [] });
    expect(win.state).toBe('missing'); // no login-shell lookup on Windows
    expect(calls.filter((c) => c.startsWith('/bin/zsh'))).toHaveLength(1);
  });
});

describe('what detection reports', () => {
  it('not installed / broken / signed out / signed in', async () => {
    expect(await detectLocalClaude({ bin: null })).toMatchObject({ state: 'missing', installed: false, signedIn: false });
    expect(await detectLocalClaude({ bin: '/x/claude', run: cli({ version: { code: 1, stdout: '' } }) })).toMatchObject({ state: 'broken', installed: false, bin: '/x/claude' });
    expect(await detectLocalClaude({ bin: '/x/claude', run: cli({ version: Object.assign(new Error('spawn EACCES'), { code: 'EACCES' }) }) })).toMatchObject({ state: 'broken' });
    expect(await detectLocalClaude({ bin: '/x/claude', run: signedOut })).toMatchObject({ state: 'signed_out', installed: true, signedIn: false, version: '2.1.304' });
    expect(await detectLocalClaude({ bin: '/x/claude', run: signedIn })).toEqual({
      state: 'ready', installed: true, signedIn: true, bin: '/x/claude', version: '2.1.304', plan: 'max', authMethod: 'claude.ai',
    });
  });

  it('unparsable answers, timeouts and an old CLI without `auth status` are "not signed in", with a plain reason', async () => {
    const garbage = await detectLocalClaude({ bin: '/x/claude', run: cli({ auth: { code: 0, stdout: 'something {not json' } }) });
    expect(garbage).toMatchObject({ state: 'signed_out', signedIn: false });
    expect(garbage.reason).toMatch(/Update it/);
    const old = await detectLocalClaude({ bin: '/x/claude', run: cli({ auth: { code: 1, stdout: '', stderr: "error: unknown command 'auth'" } }) });
    expect(old).toMatchObject({ state: 'signed_out' });
    expect(old.reason).toMatch(/could not tell/);
    const text = await detectLocalClaude({ bin: '/x/claude', run: cli({ auth: { code: 1, stdout: 'Not logged in. Run claude to sign in.' } }) });
    expect(text).toMatchObject({ state: 'signed_out', reason: 'Your Claude Code app is not signed in yet.' });
    const slow = await detectLocalClaude({ bin: '/x/claude', run: cli({ auth: new AIError('cli_timeout', 'The AI took too long to answer.') }) });
    expect(slow).toMatchObject({ state: 'signed_out' });
    expect(slow.reason).toMatch(/too long/);
    // loggedIn must be a real boolean true
    expect((await detectLocalClaude({ bin: '/x/claude', run: cli({ auth: { code: 0, stdout: '{"loggedIn":"yes"}' } }) })).state).toBe('signed_out');
    // exit non-zero with JSON loggedIn:false
    expect((await detectLocalClaude({ bin: '/x/claude', run: cli({ auth: { code: 1, stdout: '{"loggedIn": false}' } }) })).state).toBe('signed_out');
  });

  it('never keeps the e-mail, the organization or anything that is not a plain plan word', async () => {
    const r = await detectLocalClaude({ bin: '/x/claude', run: signedIn });
    const s = JSON.stringify(r);
    for (const secret of [EMAIL, ORG_ID, ORG_NAME, 'firstParty', '@']) expect(s).not.toContain(secret);
    const odd = await detectLocalClaude({ bin: '/x/claude', run: cli({ auth: { code: 0, stdout: authJson(true, { subscriptionType: EMAIL, authMethod: 'a b c' }) } }) });
    expect(odd.state).toBe('ready');
    expect(odd.plan).toBeUndefined();
    expect(odd.authMethod).toBeUndefined();
  });

  it('runs only --version and auth status (never reads files, never starts a session)', async () => {
    const run = cli({});
    await detectLocalClaude({ bin: '/x/claude', run });
    expect(run.calls).toEqual([['/x/claude', '--version'], ['/x/claude', 'auth', 'status']]);
  });
});

describe('the Claude Code choice in the provider list', () => {
  it('offered to everyone, labelled for people, in its real state, between the API key and No AI', async () => {
    for (const [run, connected] of [[signedIn, true], [signedOut, false]] as const) {
      const ai = createAI({ ...noProvider(), localClaude: { bin: '/x/claude', run } });
      const list = await ai.providers();
      expect(list.map((p) => p.id)).toEqual(['chatgpt', 'claude', 'claude-cli', 'none']);
      const st = list.find((p) => p.id === 'claude-cli')!;
      expect(st).toMatchObject({ connected, label: 'Claude (your Claude Code app)' });
      expect(st.label).not.toBe('Claude Code');
    }
    const missing = createAI({ ...noProvider(), localClaude: { bin: null } });
    const st = (await missing.providers()).find((p) => p.id === 'claude-cli')!;
    expect(st).toMatchObject({ connected: false, error: { code: 'claude_code_missing' } });
  });

  it('dev mode adds codex-cli and replay with their dev labels', async () => {
    const ai = createAI({ ...noProvider(), dev: true, localClaude: { bin: '/x/claude', run: signedIn } });
    const list = await ai.providers();
    expect(list.map((p) => p.id)).toEqual(['chatgpt', 'claude', 'claude-cli', 'codex-cli', 'replay', 'none']);
    expect(list.find((p) => p.id === 'codex-cli')!.label).toBe('Codex CLI (dev)');
    expect(list.find((p) => p.id === 'replay')!.label).toBe('Replay (dev)');
    expect(list.find((p) => p.id === 'claude-cli')!.label).toBe('Claude (your Claude Code app)');
  });

  it('no e-mail or organization in any ProviderStatus (detail is the version at most)', async () => {
    const ai = createAI({ ...noProvider(), localClaude: { bin: '/x/claude', run: signedIn } });
    const st = (await ai.providers()).find((p) => p.id === 'claude-cli')!;
    expect(st.detail).toBe('2.1.304');
    await ai.setActive('claude-cli');
    const all = JSON.stringify([await ai.providers(), await ai.active(), await ai.claudeCodeStatus()]);
    for (const secret of [EMAIL, ORG_ID, ORG_NAME]) expect(all).not.toContain(secret);
  });

  it('setActive refuses claude-cli unless it is ready, with a plain reason', async () => {
    const out = createAI({ ...noProvider(), localClaude: { bin: '/x/claude', run: signedOut } });
    await expect(out.setActive('claude-cli')).rejects.toMatchObject({ code: 'not_available', userMessage: 'Your Claude Code app is not signed in yet.' });
    const missing = createAI({ ...noProvider(), localClaude: { bin: null } });
    await expect(missing.setActive('claude-cli')).rejects.toMatchObject({ code: 'not_available' });
    const broken = createAI({ ...noProvider(), localClaude: { bin: '/x/claude', run: cli({ version: { code: 2, stdout: '' } }) } });
    await expect(broken.setActive('claude-cli')).rejects.toMatchObject({ code: 'not_available' });
    const ready = createAI({ ...noProvider(), localClaude: { bin: '/x/claude', run: signedIn } });
    await ready.setActive('claude-cli');
    expect(await ready.active()).toMatchObject({ id: 'claude-cli', connected: true, label: 'Claude (your Claude Code app)' });
  });

  it('never picks claude-cli on its own, even when it is the only thing ready', async () => {
    const ai = createAI({ ...noProvider(), localClaude: { bin: '/x/claude', run: signedIn } });
    expect((await ai.providers()).find((p) => p.id === 'claude-cli')!.connected).toBe(true);
    expect((await ai.active()).id).toBe('none');
  });

  it('a saved choice of claude-cli keeps working, and falls back to No AI when the app signs out', async () => {
    const dir = tmpDir();
    const host = new FakeHost(tmpDir());
    await createAI({ host, settingsDir: dir, localClaude: { bin: '/x/claude', run: signedIn } }).setActive('claude-cli');
    // a later start (new process) with the same settings: still Claude through the person's Claude Code app
    expect((await createAI({ host, settingsDir: dir, localClaude: { bin: '/x/claude', run: signedIn } }).active()).id).toBe('claude-cli');
    expect((await createAI({ host, settingsDir: dir, localClaude: { bin: '/x/claude', run: signedOut } }).active()).id).toBe('none');
  });

  it('claudeCodeStatus is a fresh look every time (not the 60 s cache)', async () => {
    let n = 0;
    const run: Runner = async (_c, args) => (args[0] === '--version' ? { code: 0, stdout: '2.1.304', stderr: '' } : (n++, { code: 0, stdout: authJson(n > 1), stderr: '' }));
    const ai = createAI({ ...noProvider(), localClaude: { bin: '/x/claude', run } });
    expect((await ai.claudeCodeStatus()).state).toBe('signed_out');
    expect((await ai.claudeCodeStatus()).state).toBe('ready');
  });
});
