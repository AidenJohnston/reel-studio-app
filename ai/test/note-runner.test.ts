// Settings › Editor › How notes run (index.ts noteRunner, setNoteRunner, noteHarness): a person, with no developer
// setting, runs notes in the Claude Code or Codex app they use as their editor.
import { expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createAI } from '../src';
import { FakeHost, makeProject, tmpDir } from './helpers';

const signedIn = { run: async (_cmd: string, args: string[]) => ({ code: 0, stdout: args[0] === '--version' ? 'codex-cli 0.164.0' : 'Logged in using ChatGPT', stderr: '' }) };

it.skipIf(process.platform === 'win32')('fails if choosing the Codex app in Settings does not run the next note in it, without a developer setting', async () => {
  const dir = tmpDir('runner ');
  const ran = path.join(dir, 'ran');
  // a stand-in codex that writes down its arguments and fails, so the note ends at once
  const bin = path.join(dir, 'my codex');
  fs.writeFileSync(bin, `#!/bin/sh\necho "$@" >> '${ran}'\nexit 1\n`, { mode: 0o755 });
  const settingsDir = tmpDir('settings ');
  fs.writeFileSync(path.join(settingsDir, 'ai-settings.json'), JSON.stringify({ active: 'codex-cli' }));
  const { root, dir: project } = await makeProject();
  const ai = createAI({ host: new FakeHost(root), settingsDir, localCodex: { bin, ...signedIn } });
  expect(await ai.noteRunner()).toEqual({ runner: 'reelstudio', app: 'codex' });
  expect(await ai.setNoteRunner('app')).toEqual({ runner: 'app', app: 'codex' });
  expect(JSON.parse(fs.readFileSync(path.join(settingsDir, 'ai-settings.json'), 'utf8')).harness).toBe('codex');
  await ai.applyNote(project, 'open with the part about the starter, it is the strongest bit', () => undefined).catch(() => undefined);
  // --strict-config is the MCP harness's own argument; Reel Studio's editor runs `codex exec` without it
  expect(fs.readFileSync(ran, 'utf8')).toContain('--strict-config');
});

it('fails if Settings offers to run notes in an app that is not the editor in use, signed in', async () => {
  const settingsDir = tmpDir('settings ');
  fs.writeFileSync(path.join(settingsDir, 'ai-settings.json'), JSON.stringify({ active: 'codex-cli', harness: 'codex' }));
  const { root } = await makeProject();
  const signedOut = { run: async (_cmd: string, args: string[]) => ({ code: args[0] === '--version' ? 0 : 1, stdout: args[0] === '--version' ? 'codex-cli 0.164.0' : 'Not logged in', stderr: '' }) };
  const ai = createAI({ host: new FakeHost(root), settingsDir, localCodex: { bin: '/nowhere/codex', ...signedOut } });
  // a choice saved while it was signed in reads as Reel Studio's editor now, and cannot be made again
  expect(await ai.noteRunner()).toEqual({ runner: 'reelstudio', app: null });
  await expect(ai.setNoteRunner('app')).rejects.toMatchObject({ code: 'not_available' });
  expect(await ai.setNoteRunner('reelstudio')).toEqual({ runner: 'reelstudio', app: null });
  expect(JSON.parse(fs.readFileSync(path.join(settingsDir, 'ai-settings.json'), 'utf8')).harness).toBeUndefined();
});
