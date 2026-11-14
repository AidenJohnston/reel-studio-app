// A saved version folder is never rewritten (docs/versions.md): a note whose edit makes the same video
// takes the version the engine reuses.
import { describe, it, expect } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { createAI } from '../src';
import { FakeHost, ScriptedModel, makeProject, call, tmpDir, firstVersion } from './helpers';

// what a model call ran on, as the agent loop records it (ai-run.json)
const ran = { provider: 'claude-cli' as const, requestedModel: 'sonnet', reportedModels: ['claude-sonnet-5-5'], cliVersion: '2.1.296', effort: null, usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0 } };
const keptRuns = async (dir: string) => {
  const d = path.join(dir, 'work', 'ai-runs');
  const files = await fsp.readdir(d).catch(() => [] as string[]);
  return Promise.all(files.map(async (f) => ({ file: f, ...JSON.parse(await fsp.readFile(path.join(d, f), 'utf8')) })));
};
const folder = async (dir: string) => Object.fromEntries(await Promise.all((await fsp.readdir(dir)).map(async (f) => [f, await fsp.readFile(path.join(dir, f), 'utf8')])));

describe('a saved version is never rewritten', () => {
  it('a caption-only note takes the version the engine reuses and writes nothing into its folder', async () => {
    const { root, dir } = await makeProject();
    const host = new FakeHost(root);
    await firstVersion(dir, host);
    const v1 = path.join(dir, 'versions', 'v1');
    const before = await folder(v1);
    const m = new ScriptedModel([
      { toolCalls: [call('write_post', { caption: 'Bread takes patience', hashtags: ['bread', 'baking', 'sourdough', 'homemade', 'patience'], keywords: ['bread'] })], provenance: ran },
      { toolCalls: [call('finish', { summary_for_user: 'I rewrote your caption.' })], provenance: ran },
    ]);
    const r = await createAI({ host, settingsDir: tmpDir('settings '), providerOverride: m }).applyNote(dir, 'new caption about patience', () => undefined, undefined, { id: 'caption-note' });
    expect(r.version).toBe(1);
    expect(JSON.parse(await fsp.readFile(path.join(dir, 'project.json'), 'utf8')).post.caption).toBe('Bread takes patience');
    expect(await folder(v1)).toEqual(before);
    // the note's model calls are kept beside the project, not added to v1's ai-run.json
    expect(await keptRuns(dir)).toEqual([{ file: 'caption-note.json', version: 1, calls: [ran, ran], usage: { input: 20, output: 40, cacheRead: 0, cacheWrite: 0 } }]);
  });

  it.each([['the simple edit (no AI)', false], ['the AI edit', true]])('%s run again after its version was saved (a resumed job) leaves that folder as it was', async (_, ai) => {
    const { root, dir } = await makeProject();
    const host = new FakeHost(root);
    // an AI that changes nothing, so the second run makes the same video; its one call is recorded
    const model = () => new ScriptedModel([{ toolCalls: [call('finish', { summary_for_user: 'Done.' })], provenance: ran }]);
    const edit = () => createAI({ host, settingsDir: tmpDir('settings '), ...(ai ? { providerOverride: model() } : {}) }).firstEdit(dir, () => undefined);
    expect((await edit()).version).toBe(1);
    const v1 = path.join(dir, 'versions', 'v1');
    const before = await folder(v1);
    expect((await edit()).version).toBe(1);
    expect(await folder(v1)).toEqual(before);
    // the second run's calls are kept beside the project, naming the version it got back
    expect((await keptRuns(dir)).map((r) => [r.version, r.calls])).toEqual(ai ? [[1, [ran]]] : []);
  });
});
