// A saved version folder is never rewritten (docs/versions.md): a note whose edit makes the same video
// takes the version the engine reuses.
import { describe, it, expect } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { createAI } from '../src';
import { FakeHost, ScriptedModel, makeProject, call, tmpDir, firstVersion } from './helpers';

const folder = async (dir: string) => Object.fromEntries(await Promise.all((await fsp.readdir(dir)).map(async (f) => [f, await fsp.readFile(path.join(dir, f), 'utf8')])));

describe('a saved version is never rewritten', () => {
  it('a caption-only note takes the version the engine reuses and writes nothing into its folder', async () => {
    const { root, dir } = await makeProject();
    const host = new FakeHost(root);
    await firstVersion(dir, host);
    const v1 = path.join(dir, 'versions', 'v1');
    const before = await folder(v1);
    const m = new ScriptedModel([
      { toolCalls: [call('write_post', { caption: 'Bread takes patience', hashtags: ['bread', 'baking', 'sourdough', 'homemade', 'patience'], keywords: ['bread'] })] },
      { toolCalls: [call('finish', { summary_for_user: 'I rewrote your caption.' })] },
    ]);
    const r = await createAI({ host, settingsDir: tmpDir('settings '), providerOverride: m }).applyNote(dir, 'new caption about patience', () => undefined);
    expect(r.version).toBe(1);
    expect(JSON.parse(await fsp.readFile(path.join(dir, 'project.json'), 'utf8')).post.caption).toBe('Bread takes patience');
    expect(await folder(v1)).toEqual(before);
  });

  it.each([['the simple edit (no AI)', false], ['the AI edit', true]])('%s run again after its version was saved (a resumed job) leaves that folder as it was', async (_, ai) => {
    const { root, dir } = await makeProject();
    const host = new FakeHost(root);
    // an AI that changes nothing, so the second run makes the same video
    const edit = () => createAI({ host, settingsDir: tmpDir('settings '), ...(ai ? { providerOverride: new ScriptedModel([]) } : {}) }).firstEdit(dir, () => undefined);
    expect((await edit()).version).toBe(1);
    const v1 = path.join(dir, 'versions', 'v1');
    const before = await folder(v1);
    expect((await edit()).version).toBe(1);
    expect(await folder(v1)).toEqual(before);
  });
});
