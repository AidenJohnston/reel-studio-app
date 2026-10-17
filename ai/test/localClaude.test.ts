import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { createAI, findClaude, detectLocalClaude } from '../src';
import { FakeHost, tmpDir } from './helpers';

const signedIn = async (_cmd: string, args: string[]) => args[0] === '--version'
  ? { code: 0, stdout: '2.1.302 (Claude Code)\n', stderr: '' }
  : { code: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'me@example.com' }), stderr: '' };
const signedOut = async (_cmd: string, args: string[]) => args[0] === '--version'
  ? { code: 0, stdout: '2.1.302 (Claude Code)\n', stderr: '' }
  : { code: 1, stdout: JSON.stringify({ loggedIn: false }), stderr: '' };

describe('Claude Code on this computer (allowLocalClaudeCode)', () => {
  it('finds claude outside PATH (a GUI app on macOS has a bare PATH)', () => {
    const home = '/Users/x';
    const want = path.posix.join(home, '.local', 'bin', 'claude');
    expect(findClaude({ HOME: home, PATH: '/usr/bin' }, 'darwin', (p) => p === want)).toBe(want);
    expect(findClaude({ HOME: home, PATH: '' }, 'darwin', (p) => p === '/opt/homebrew/bin/claude')).toBe('/opt/homebrew/bin/claude');
    expect(findClaude({ HOME: home, PATH: '' }, 'darwin', () => false)).toBeNull();
  });

  it('detects installed + signed in, signed out, and missing', async () => {
    expect(await detectLocalClaude({ bin: '/x/claude', run: signedIn })).toMatchObject({ installed: true, loggedIn: true, version: '2.1.302', account: 'me@example.com' });
    expect(await detectLocalClaude({ bin: '/x/claude', run: signedOut })).toMatchObject({ installed: true, loggedIn: false });
    expect(await detectLocalClaude({ bin: null })).toMatchObject({ installed: false, loggedIn: false });
  });

  it('public build (default): never offered, never selectable', async () => {
    const ai = createAI({ host: new FakeHost(tmpDir()), settingsDir: tmpDir(), localClaude: { bin: '/x/claude', run: signedIn } });
    expect((await ai.providers()).map((p) => p.id)).toEqual(['chatgpt', 'claude', 'none']);
    await expect(ai.setActive('claude-cli')).rejects.toMatchObject({ code: 'not_available' });
  });

  it('local Claude Code build: offered with a friendly label when installed and signed in, and used when nothing else is connected', async () => {
    const ai = createAI({ host: new FakeHost(tmpDir()), settingsDir: tmpDir(), allowLocalClaudeCode: true, localClaude: { bin: '/x/claude', run: signedIn } });
    const list = await ai.providers();
    expect(list.map((p) => p.id)).toEqual(['chatgpt', 'claude', 'claude-cli', 'none']);
    expect(list.find((p) => p.id === 'claude-cli')).toMatchObject({ connected: true, label: 'Claude Code on this computer' });
    expect((await ai.active()).id).toBe('claude-cli');
    await ai.setActive('claude-cli');
    expect((await ai.active()).label).toBe('Claude Code on this computer');
  });

  it('local Claude Code build: signed out = listed with how to fix it, not selectable; not installed = not listed', async () => {
    const out = createAI({ host: new FakeHost(tmpDir()), settingsDir: tmpDir(), allowLocalClaudeCode: true, localClaude: { bin: '/x/claude', run: signedOut } });
    const st = (await out.providers()).find((p) => p.id === 'claude-cli')!;
    expect(st.connected).toBe(false);
    expect(st.error?.userMessage).toMatch(/sign in/);
    await expect(out.setActive('claude-cli')).rejects.toMatchObject({ code: 'not_available' });
    expect((await out.active()).id).toBe('none');
    const missing = createAI({ host: new FakeHost(tmpDir()), settingsDir: tmpDir(), allowLocalClaudeCode: true, localClaude: { bin: null } });
    expect((await missing.providers()).map((p) => p.id)).toEqual(['chatgpt', 'claude', 'none']);
  });
});
