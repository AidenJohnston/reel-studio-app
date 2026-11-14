// One writer per project (index.ts exclusive, owner.ts): the app's job token, its lock file, and the
// edit lock every edit holds for its whole run.
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { createAI, OWNER_LOCK } from '../src';
import { FakeHost, ScriptedModel, makeProject, call, tmpDir } from './helpers';

async function setup() {
  const { root, dir } = await makeProject();
  const read = () => fsp.readFile(path.join(dir, 'project.json'), 'utf8');
  return { dir, host: new FakeHost(root), settingsDir: tmpDir('settings '), read, before: await read() };
}

const slower = () => new ScriptedModel([{ toolCalls: [call('set_gap_cap', { seconds: 0.4 })] }, { toolCalls: [call('finish', { summary_for_user: 'Done.' })] }]);

describe('one writer per project', () => {
  it('the dev CLI refuses a project Reel Studio has open, and changes nothing', async () => {
    const { dir, host, settingsDir, read, before } = await setup();
    await fsp.writeFile(path.join(dir, OWNER_LOCK), JSON.stringify({ app: 'Reel Studio', token: 'the app\'s job' }));
    const m = slower();
    await expect(createAI({ host, settingsDir, providerOverride: m }).applyNote(dir, 'slower', () => undefined)).rejects.toMatchObject({ code: 'project_open' });
    expect(await read()).toBe(before);
    expect(m.requests).toEqual([]);
  });

  it('an edit, with or without the app\'s token, refuses while another program is editing the project', async () => {
    const { dir, host, settingsDir, read, before } = await setup();
    // a dev CLI note that is still running holds the project: a second dev CLI, then an app job's token
    await fsp.writeFile(path.join(dir, OWNER_LOCK), JSON.stringify({ app: 'reelstudio-ai', pid: process.ppid, started: Date.now(), token: 'dev-cli', engines: [] }));
    for (const [owner, code] of [[undefined, 'project_open'], ['job-1', 'not_owner']] as const) {
      const m = slower();
      await expect(createAI({ host, settingsDir, providerOverride: m }).applyNote(dir, 'slower', () => undefined, undefined, owner ? { owner } : {}))
        .rejects.toMatchObject({ code });
      expect(m.requests).toEqual([]);
    }
    expect(await read()).toBe(before);
  });
  it('fails if a job token the lock no longer holds edits the project', async () => {
    const { dir, host, settingsDir, read, before } = await setup();
    const lock = path.join(dir, OWNER_LOCK);
    // the job that had job-1 let go and another job has the project now
    await fsp.writeFile(lock, JSON.stringify({ app: 'Reel Studio', token: 'job-2' }));
    const m = slower();
    await expect(createAI({ host, settingsDir, providerOverride: m }).applyNote(dir, 'slower', () => undefined, undefined, { owner: 'job-1' }))
      .rejects.toMatchObject({ code: 'not_owner' });
    expect(m.requests).toEqual([]);
    // it lets go while the note runs: the note is not saved
    await fsp.writeFile(lock, JSON.stringify({ app: 'Reel Studio', token: 'job-1' }));
    const late = new ScriptedModel([
      { toolCalls: [call('set_gap_cap', { seconds: 0.4 })] },
      async () => {
        await fsp.writeFile(lock, JSON.stringify({ app: 'Reel Studio', token: 'job-2' }));
        return { toolCalls: [call('finish', { summary_for_user: 'Done.' })] };
      },
    ]);
    await expect(createAI({ host, settingsDir, providerOverride: late }).applyNote(dir, 'slower', () => undefined, undefined, { owner: 'job-1' }))
      .rejects.toMatchObject({ code: 'not_owner' });
    expect(await read()).toBe(before);
  });

  it('fails if the dev CLI edits without holding the project, or keeps it once the edit is done', async () => {
    const { dir, host, settingsDir, read } = await setup();
    const lock = path.join(dir, OWNER_LOCK);
    let held: { app?: string; pid?: number; token?: string } = {};
    const m = new ScriptedModel([
      async () => {
        held = JSON.parse(await fsp.readFile(lock, 'utf8'));
        return { toolCalls: [call('set_gap_cap', { seconds: 0.4 })] };
      },
      { toolCalls: [call('finish', { summary_for_user: 'Done.' })] },
    ]);
    await createAI({ host, settingsDir, providerOverride: m }).applyNote(dir, 'slower', () => undefined);
    expect(JSON.parse(await read()).cut.gapCap).toBe(0.4);
    // what app/src/main/owner.ts reads to refuse a job's claim: not the app's, and a live process
    expect(held).toMatchObject({ app: expect.not.stringMatching(/^Reel Studio$/), pid: process.pid, token: expect.any(String) });
    // its engine commands join with its own token, as a job's do
    const engine = host.calls.filter((c) => c.args.includes('--project'));
    expect(engine.length).toBeGreaterThan(0);
    expect(engine.map((c) => c.args[c.args.indexOf('--owner') + 1])).toEqual(engine.map(() => held.token));
    expect(fs.existsSync(lock)).toBe(false);
  });
  it('fails if the dev CLI\'s claim leaves out an engine it started, which the app must wait for after a crash', async () => {
    const { dir, host, settingsDir } = await setup();
    const lock = path.join(dir, OWNER_LOCK);
    // a host whose engines outlive it, as the dev CLI's PythonEngineHost does
    const listeners = new Set<(pid: number) => void>();
    host.watchSpawns = (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
    const run = host.runEngine.bind(host);
    host.runEngine = async (command, args, onProgress) => {
      for (const listener of listeners) listener(4242);
      return run(command, args, onProgress);
    };
    let recorded: { pid?: number }[] = [];
    const m = new ScriptedModel([
      { toolCalls: [call('render_draft')] },
      async () => {
        for (let i = 0; i < 100 && !recorded.length; i++) {
          recorded = JSON.parse(await fsp.readFile(lock, 'utf8')).engines ?? [];
          if (!recorded.length) await new Promise((r) => setTimeout(r, 10));
        }
        return { toolCalls: [call('finish', { summary_for_user: 'Done.' })] };
      },
    ]);
    await createAI({ host, settingsDir, providerOverride: m }).applyNote(dir, 'show me', () => undefined);
    expect(recorded).toEqual(expect.arrayContaining([expect.objectContaining({ pid: 4242, started: expect.any(Number) })]));
    expect(listeners.size).toBe(0);
    expect(fs.existsSync(lock)).toBe(false);
  });
});
