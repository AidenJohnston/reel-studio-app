import { afterEach, describe, expect, it } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { executeTool, newToolState, runAgent, StyleStore, ToolContext } from '../src';
import { resolveAsset } from '../src/tools';
import { FakeHost, makeProject, ScriptedModel } from './helpers';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fsp.rm(root, { recursive: true, force: true }))); });

async function stagedContext() {
  const { root, dir } = await makeProject();
  roots.push(root);
  const stage = path.join(dir, '.staging', 'txn-test');
  await fsp.mkdir(path.join(stage, 'work'), { recursive: true });
  await fsp.copyFile(path.join(dir, 'project.json'), path.join(stage, 'project.json'));
  await fsp.copyFile(path.join(dir, 'work', 'transcript.json'), path.join(stage, 'work', 'transcript.json'));
  const ac = new AbortController();
  const host = new FakeHost(root);
  const ctx: ToolContext = {
    projectDir: stage, host, style: new StyleStore(() => root), supportsImages: false,
    emit: () => { throw new Error('A staged tool reported success before publish'); },
    state: newToolState(), signal: ac.signal,
    note: { txnId: 'txn-test', liveDir: dir, versionDir: path.join(stage, 'version'),
      fail: () => ac.abort(), pending: new Set(), styleRules: [] },
  };
  return { ctx, dir, root, ac, host };
}

describe('staged note tools', () => {
  it('deduplicates repeated writes, reads existing live assets, and defers style writes', async () => {
    const { ctx, dir } = await stagedContext();
    const before = await fsp.readFile(path.join(dir, 'project.json'));
    await fsp.mkdir(path.join(dir, 'work', 'assets'), { recursive: true });
    const asset = path.join(dir, 'work', 'assets', 'existing.png');
    await fsp.writeFile(asset, 'existing');
    expect(resolveAsset(ctx, 'work/assets/existing.png')?.abs).toBe(await fsp.realpath(asset));
    const args = { seconds: 0.12 };
    await Promise.all([executeTool(ctx, 'set_gap_cap', args, 'repeat'), executeTool(ctx, 'set_gap_cap', args, 'repeat')]);
    expect(ctx.state.toolCalls).toBe(1);
    expect(await fsp.readFile(path.join(dir, 'project.json'))).toEqual(before);
    expect(JSON.parse(await fsp.readFile(path.join(ctx.projectDir, 'project.json'), 'utf8')).cut.gapCap).toBe(0.12);
    ctx.userNote = 'Always keep music quiet';
    await executeTool(ctx, 'add_style_rule', { rule: 'Keep music quiet' }, 'style');
    expect(ctx.note?.styleRules).toEqual(['Keep music quiet.']);
    expect(await ctx.style.list()).toEqual([]);
    await expect(executeTool(ctx, 'set_gap_cap', { seconds: 0.2 }, 'repeat')).rejects.toThrow(/already used/);
  });

  it('stops queued parallel tools on failure and waits for the tool already running', async () => {
    const { ctx, ac, host } = await stagedContext();
    ctx.emit = () => undefined;
    let release: (() => void) | undefined;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const started: string[] = [];
    let reportStarted: (() => void) | undefined;
    const bothStarted = new Promise<void>((resolve) => { reportStarted = resolve; });
    host.runEngine = async (command: string) => {
      started.push(command);
      if (command === 'search-images') throw new Error('search failed');
      reportStarted?.();
      await waiting;
      return { asset: 'work/assets/txn-test-image.png' };
    };
    const model = new ScriptedModel([{ toolCalls: [
      { id: 'search', name: 'search_images', args: { query: 'picture' } },
      { id: 'fetch', name: 'fetch_image', args: { url: 'https://example.com/picture.png', name: null } },
      { id: 'queued', name: 'fetch_image', args: { url: 'https://example.com/queued.png', name: null } },
    ] }]);
    let settled = false;
    const result = runAgent({ ctx, provider: model, system: '', task: '', parallel: 2, signal: ac.signal, onEvent: () => undefined });
    const checked = result.then(() => { settled = true; }, (error: unknown) => { settled = true; throw error; });
    await bothStarted;
    await Promise.resolve();
    expect(ac.signal.aborted).toBe(true);
    expect(settled).toBe(false);
    expect(ctx.note?.pending.size).toBeGreaterThan(0);
    release?.();
    await expect(checked).rejects.toThrow(/search failed/);
    expect(started).toEqual(['search-images', 'fetch-image']);
    expect(ctx.note?.pending.size).toBe(0);
  });
});
