import { afterEach, describe, expect, it } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { executeTool, newToolState, runAgent, StyleStore, ToolContext } from '../src';
import { resolveAsset } from '../src/tools';
import { FakeHost, makeProject, ScriptedModel, tinyPng } from './helpers';

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
    emit: () => undefined,
    state: newToolState(), signal: ac.signal,
    note: { txnId: 'txn-test', liveDir: dir, versionDir: path.join(stage, 'version'),
      fail: () => ac.abort(), pending: new Set(), styleRules: [] },
  };
  return { ctx, dir, root, ac, host };
}

describe('staged note tools', () => {
  it('lets the model correct bad arguments and anchors, then retries an unusable image through the older-engine fallback', async () => {
    const { ctx, dir, host, ac } = await stagedContext();
    const before = await fsp.readFile(path.join(dir, 'project.json'));
    const downloads: string[] = [];
    let searches = 0;
    ctx.lookupImpl = async () => ['93.184.215.14'];
    ctx.fetchImpl = async () => new Response(tinyPng(), { headers: { 'content-type': 'image/png' } });
    host.runEngine = async (command, args) => {
      if (command === 'search-images') {
        if (++searches === 1) throw new Error('search temporarily unavailable');
        return { results: [{ url: 'https://example.com/not-an-image' }, { url: 'https://example.com/bread.png' }] };
      }
      if (command === 'fetch-image') {
        const url = args[args.indexOf('--url') + 1];
        downloads.push(url);
        if (url.endsWith('not-an-image')) throw { code: 'NOT_AN_IMAGE', userMessage: 'This link is a web page.' };
        throw { code: 'UNKNOWN_COMMAND', userMessage: 'unknown command' };
      }
      throw new Error(`Unexpected engine call: ${command}`);
    };
    const model = new ScriptedModel([
      { toolCalls: [{ id: 'search', name: 'search_images', args: { query: 'bread photo' } }] },
      (req) => {
        const feedback = req.messages.at(-1);
        if (feedback?.role !== 'tool') throw new Error('Expected search feedback');
        expect(feedback.results[0].content).toMatch(/Use the library, text-pop, or make_animation/);
        return { toolCalls: [
          { id: 'bad-args', name: 'set_gap_cap', args: { seconds: 20 } },
          { id: 'bad-anchor', name: 'set_cut', args: { keep: [{ from: 'w0', to: 'w999' }] } },
        ] };
      },
      (req) => {
        const feedback = req.messages.at(-1);
        if (feedback?.role !== 'tool') throw new Error('Expected correction feedback');
        expect(feedback.results.map((result) => result.isError)).toEqual([true, true]);
        expect(feedback.results[0].content).toMatch(/invalid arguments/);
        expect(feedback.results[1].content).toMatch(/unknown word id w999/);
        return { toolCalls: [{ id: 'corrected', name: 'add_broll', args: {
          anchor: { from: 'w0', to: 'w8' }, treatment: 'card-above-head', search: 'bread photo', params: {},
        } }] };
      },
      { toolCalls: [{ id: 'finish', name: 'finish', args: { summary_for_user: 'I added a picture of bread.' } }] },
    ]);
    const result = await runAgent({ ctx, provider: model, system: '', task: 'Add a picture of bread at the start.', signal: ac.signal, onEvent: () => undefined });
    expect(result.finished).toBe('I added a picture of bread.');
    expect(downloads).toEqual(['https://example.com/not-an-image', 'https://example.com/bread.png']);
    const staged = JSON.parse(await fsp.readFile(path.join(ctx.projectDir, 'project.json'), 'utf8'));
    expect(staged.broll).toHaveLength(1);
    expect(staged.broll[0].asset).toMatch(/^work\/assets\/txn-test-.*\.png$/);
    expect(await fsp.readFile(path.join(ctx.projectDir, staged.broll[0].asset))).toEqual(tinyPng());
    expect(await fsp.readFile(path.join(dir, 'project.json'))).toEqual(before);
    expect(ac.signal.aborted).toBe(false);
  });

  it('keeps music analysis and its optional fallback inside the note cache', async () => {
    const { ctx, root, host, ac } = await stagedContext();
    for (const name of ['gentle.mp3', 'fallback.mp3']) await fsp.writeFile(path.join(root, 'Library', 'Music', name), 'song');
    host.runEngine = async (command, args) => {
      expect(command).toBe('analyze-music');
      expect(args[args.indexOf('--project') + 1]).toBe(ctx.projectDir);
      expect(args[args.indexOf('--cache-dir') + 1]).toBe(path.join(ctx.projectDir, 'work', 'cache'));
      if (args.includes('--library')) return { songs: [{ track: 'Library/Music/gentle.mp3', bpm: 92.2, mood: 'dreamy', energy: 'calm' }] };
      if (args.some((arg) => arg.endsWith('fallback.mp3'))) throw new Error('analysis unavailable');
      return { bpm: 92.2, mood: 'dreamy', energy: 'calm', suggestedStartAt: 7.5 };
    };
    const library = JSON.parse((await executeTool(ctx, 'list_library', { kind: 'music' })).content);
    expect(library.songs[0]).toMatchObject({ bpm: 92, mood: 'dreamy', energy: 'calm' });
    const chosen = JSON.parse((await executeTool(ctx, 'choose_music', { track: 'Library/Music/gentle.mp3' })).content);
    expect(chosen.music.startAt).toBe(7.5);
    expect(chosen.song).toMatchObject({ bpm: 92.2, mood: 'dreamy', energy: 'calm' });
    const fallback = JSON.parse((await executeTool(ctx, 'choose_music', { track: 'Library/Music/fallback.mp3' })).content);
    expect(fallback.music.startAt).toBe(0);
    expect(ac.signal.aborted).toBe(false);
  });

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
    await expect(executeTool(ctx, 'set_gap_cap', { seconds: 0.2 }, 'repeat')).resolves.toMatchObject({
      isError: true, content: expect.stringMatching(/already used/),
    });
  });

  it('stops queued parallel tools after an unreadable project and waits for the tool already running', async () => {
    const { ctx, ac, host } = await stagedContext();
    await fsp.writeFile(path.join(ctx.projectDir, 'project.json'), '{invalid project');
    ctx.emit = () => undefined;
    let release: (() => void) | undefined;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const started: string[] = [];
    let reportStarted: (() => void) | undefined;
    const bothStarted = new Promise<void>((resolve) => { reportStarted = resolve; });
    const aborted = new Promise<void>((resolve) => { ac.signal.addEventListener('abort', () => resolve(), { once: true }); });
    host.runEngine = async (command: string) => {
      started.push(command);
      reportStarted?.();
      await waiting;
      return { asset: 'work/assets/txn-test-image.png' };
    };
    const model = new ScriptedModel([{ toolCalls: [
      { id: 'read', name: 'get_project', args: {} },
      { id: 'fetch', name: 'fetch_image', args: { url: 'https://example.com/picture.png', name: null } },
      { id: 'queued', name: 'fetch_image', args: { url: 'https://example.com/queued.png', name: null } },
    ] }]);
    let settled = false;
    const result = runAgent({ ctx, provider: model, system: '', task: '', parallel: 2, signal: ac.signal, onEvent: () => undefined });
    const checked = result.then(() => { settled = true; }, (error: unknown) => { settled = true; throw error; });
    await bothStarted;
    await aborted;
    expect(ac.signal.aborted).toBe(true);
    expect(settled).toBe(false);
    expect(ctx.note?.pending.size).toBeGreaterThan(0);
    release?.();
    await expect(checked).rejects.toThrow(/Could not read/);
    expect(started).toEqual(['fetch-image']);
    expect(ctx.note?.pending.size).toBe(0);
  });
});
