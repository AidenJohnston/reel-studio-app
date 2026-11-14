// A note is all-or-nothing (editor.ts applyNote): the ways a real note ends, on a project that already
// has its first edit (a cut and Version 1), as every note does.
import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { createAI, AIError, StyleStore, OWNER_LOCK, listVersions, executeTool, newToolState, ToolContext } from '../src';
import { FakeHost, ScriptedModel, makeProject, call, tmpDir, firstVersion, tinyPng } from './helpers';

async function setup(opts: { firstVersion?: boolean } = {}) {
  const { root, dir } = await makeProject();
  const host = new FakeHost(root);
  await firstVersion(dir, host, opts.firstVersion !== false);
  const read = () => fsp.readFile(path.join(dir, 'project.json'), 'utf8');
  return { root, dir, host, settingsDir: tmpDir('settings '), read, before: await read() };
}

const notesLeft = (dir: string) => fs.readdirSync(path.join(dir, 'work', 'notes')).length;
const folder = async (dir: string) => Object.fromEntries(await Promise.all((await fsp.readdir(dir)).map(async (f) => [f, await fsp.readFile(path.join(dir, f), 'utf8')])));
const finish = (summary: string) => ({ toolCalls: [call('finish', { summary_for_user: summary })] });

describe('a note that does not finish leaves the project as it was', () => {
  it('a provider error after a change and a download: nothing saved, and only that download is not offered again', async () => {
    const { dir, host, settingsDir, read } = await setup();
    host.engineAssets = true;
    await fsp.mkdir(path.join(dir, 'work', 'assets'), { recursive: true });
    await fsp.writeFile(path.join(dir, 'work', 'assets', 'old-photo.png'), 'from an older version of the app');
    await createAI({ host, settingsDir, providerOverride: new ScriptedModel([
      { toolCalls: [call('fetch_image', { url: 'https://example.com/crust.png', name: 'crust' }), call('set_gap_cap', { seconds: 0.3 })] },
      finish('I tightened the pauses.'),
    ]) }).applyNote(dir, 'tighter, and find a picture of a crust', () => undefined);
    const before = await read();

    const failing = new ScriptedModel([
      { toolCalls: [call('fetch_image', { url: 'https://example.com/loaf.png', name: 'loaf' }), call('set_gap_cap', { seconds: 0.4 })] },
      new AIError('network', 'I could not reach the AI. Check your internet and try again.'),
    ]);
    await expect(createAI({ host, settingsDir, providerOverride: failing }).applyNote(dir, 'slower, with a picture of my loaf', () => undefined))
      .rejects.toMatchObject({ code: 'network' });
    expect(await read()).toBe(before);
    expect(notesLeft(dir)).toBe(0);

    let offered = '';
    await createAI({ host, settingsDir, providerOverride: new ScriptedModel([
      { toolCalls: [call('list_library', { kind: 'images' })] },
      (req) => { offered = JSON.stringify(req.messages.at(-1)); return finish('Nothing to change.'); },
    ]) }).applyNote(dir, 'any pictures already?', () => undefined);
    expect(offered).toMatch(/crust\.png/);
    expect(offered).toContain('old-photo.png');
    expect(offered).not.toMatch(/loaf\.png/);
  });

  it('Stop during the final render: the half-made version is not a version, and the next note makes it cleanly', async () => {
    const { dir, host, settingsDir, read, before } = await setup();
    const ac = new AbortController();
    host.afterRenderFiles = ({ draft }) => {
      if (draft) return;
      ac.abort();       // the engine had already written versions/v2/export.mp4
      throw { code: 'CANCELLED', userMessage: 'Stopped.' };
    };
    const m = new ScriptedModel([{ toolCalls: [call('set_gap_cap', { seconds: 0.4 })] }, finish('I gave the pauses more room.')]);
    await expect(createAI({ host, settingsDir, providerOverride: m }).applyNote(dir, 'slower', () => undefined, ac.signal)).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(await read()).toBe(before);
    expect(await listVersions(dir)).toEqual([1]);
    expect(notesLeft(dir)).toBe(0);

    host.afterRenderFiles = undefined;
    const again = new ScriptedModel([{ toolCalls: [call('set_gap_cap', { seconds: 0.5 })] }, finish('Even more room now.')]);
    const r = await createAI({ host, settingsDir, providerOverride: again }).applyNote(dir, 'even slower', () => undefined);
    expect(r.version).toBe(2);
    expect(await fsp.readFile(path.join(dir, 'versions', 'v2', 'notes.md'), 'utf8')).toBe('# v2\n\nNote: even slower\n\nEven more room now.\n');
  });

  it('a change made to project.json while the note runs is kept, and the note is not saved over it', async () => {
    const { dir, host, settingsDir, read } = await setup();
    const m = new ScriptedModel([
      { toolCalls: [call('set_gap_cap', { seconds: 0.4 })] },
      async () => {
        const p = JSON.parse(await read());
        await fsp.writeFile(path.join(dir, 'project.json'), JSON.stringify({ ...p, title: 'Renamed by hand' }, null, 2));
        return finish('I gave the pauses more room.');
      },
    ]);
    await expect(createAI({ host, settingsDir, providerOverride: m }).applyNote(dir, 'slower', () => undefined)).rejects.toMatchObject({ code: 'project_changed' });
    const p = JSON.parse(await read());
    expect(p.title).toBe('Renamed by hand');
    expect(p.cut.gapCap).toBe(0.25);
    expect(await listVersions(dir)).toEqual([1]);
  });

  it('a version another edit saved while the note ran is left byte for byte, and the note is not saved', async () => {
    const { dir, host, settingsDir, read } = await setup();
    const v2 = path.join(dir, 'versions', 'v2');
    let saved: Record<string, string> = {};
    const m = new ScriptedModel([
      { toolCalls: [call('set_gap_cap', { seconds: 0.4 })] },
      async () => {
        // a manual change and its render save Version 2 meanwhile
        const p = JSON.parse(await read());
        await fsp.writeFile(path.join(dir, 'project.json'), JSON.stringify({ ...p, title: 'Renamed by hand' }, null, 2));
        await host.runEngine('render', ['--project', dir]);
        saved = await folder(v2);
        return finish('I gave the pauses more room.');
      },
    ]);
    await expect(createAI({ host, settingsDir, providerOverride: m }).applyNote(dir, 'slower', () => undefined)).rejects.toMatchObject({ code: 'project_changed' });
    expect(Object.keys(saved)).toContain('export.mp4');
    expect(await folder(v2)).toEqual(saved);
    expect(JSON.parse(await read())).toMatchObject({ version: 2, title: 'Renamed by hand' });
  });

  it('a model that answers in words and never calls a tool gets the "not sure" reply, saved like any note that changes nothing', async () => {
    const { dir, host, settingsDir, read } = await setup();
    const m = new ScriptedModel(Array.from({ length: 6 }, () => ({ text: 'The music suits your bread nicely.' })));
    const r = await createAI({ host, settingsDir, providerOverride: m })
      .applyNote(dir, 'what do you think of the music?', () => undefined, undefined, { id: 'job-4', saveStyleRules: false });
    const reply = 'I looked, but I was not sure what to change. Could you say it another way?';
    // no version for a note that made none, in the result or the saved note (docs/schema-changes.md)
    expect(r).toMatchObject({ summary: reply, changed: [] });
    expect(r).not.toHaveProperty('version');
    expect(JSON.parse(await read()).notes.at(-1)).toMatchObject({ id: 'job-4', applied: [], reply });
    expect(JSON.parse(await read()).notes.at(-1)).not.toHaveProperty('version');
    expect(host.calls).toEqual([]);
    expect(notesLeft(dir)).toBe(0);
  });

  it('a project with only a preview keeps that preview when a note fails at the final render', async () => {
    const { dir, host, settingsDir, read, before } = await setup({ firstVersion: false });
    const preview = path.join(dir, 'versions', 'preview', 'draft.mp4');
    await fsp.mkdir(path.dirname(preview), { recursive: true });
    await fsp.writeFile(preview, 'the first preview');
    host.afterRenderFiles = ({ draft }) => { if (!draft) throw { code: 'RENDER_FAILED', userMessage: 'The video could not be made.' }; };
    const m = new ScriptedModel([
      { toolCalls: [call('set_gap_cap', { seconds: 0.4 })] },
      { toolCalls: [call('render_draft')] },
      finish('I gave the pauses more room.'),
    ]);
    const events: any[] = [];
    await expect(createAI({ host, settingsDir, providerOverride: m }).applyNote(dir, 'slower', (e) => events.push(e))).rejects.toMatchObject({ code: 'RENDER_FAILED' });
    expect(await fsp.readFile(preview, 'utf8')).toBe('the first preview');
    expect(await read()).toBe(before);
    // the note's own preview was shown while it worked, from its own folder
    expect(events.filter((e) => e.type === 'render').map((e) => e.draft)).toEqual([true]);
    expect(notesLeft(dir)).toBe(0);
  });

  it('part of the engine would not stop during a step that hides its errors: a note that then changes nothing is not saved', async () => {
    const { root, dir, host, settingsDir, read, before } = await setup();
    await fsp.writeFile(path.join(dir, OWNER_LOCK), JSON.stringify({ app: 'Reel Studio', token: 'job-1' }));
    await fsp.mkdir(path.join(root, 'Library', 'Music'), { recursive: true });
    await fsp.writeFile(path.join(root, 'Library', 'Music', 'calm.mp3'), 'song');
    const run = host.runEngine.bind(host);
    host.runEngine = async (command, args, onProgress) => {
      if (command === 'analyze-music') throw { code: 'ENGINE_STUCK', userMessage: "Part of Reel Studio's video engine would not stop." };
      return run(command, args, onProgress);
    };
    const m = new ScriptedModel([{ toolCalls: [call('list_library', { kind: 'music' })] }, finish('The music already fits.')]);
    await expect(createAI({ host, settingsDir, providerOverride: m }).applyNote(dir, 'better music', () => undefined, undefined, { owner: 'job-1' }))
      .rejects.toMatchObject({ code: 'ENGINE_STUCK' });
    expect(await read()).toBe(before);
  });

  it('fails if a note takes back what it froze, or removes its folder, while a moments run that would not stop may still write', async () => {
    const { root, dir, host, settingsDir, read, before } = await setup();
    await fsp.writeFile(path.join(root, 'Library', 'Images', 'bread.png'), tinyPng());
    await fsp.writeFile(path.join(dir, OWNER_LOCK), JSON.stringify({ app: 'Reel Studio', token: 'job-1' }));
    const run = host.runEngine.bind(host);
    let drawn = false;
    host.runEngine = async (command, args, onProgress, signal) => {
      if (command !== 'moments') return run(command, args, onProgress, signal);
      if (args.includes('--mark')) return {};
      // the changed-moments draw, whose engine would not stop: Moments keeps the error to itself
      drawn = true;
      throw { code: 'ENGINE_STUCK', userMessage: "Part of Reel Studio's video engine would not stop." };
    };
    const m = new ScriptedModel([
      { toolCalls: [call('add_broll', { anchor: { from: 'w29', to: 'w30' }, treatment: 'side-card', asset: 'Library/Images/bread.png', animation: null, params: {} })] },
      async () => {
        for (let i = 0; i < 200 && !drawn; i++) await new Promise((r) => setTimeout(r, 10));
        throw new AIError('network', 'I could not reach the AI. Check your internet and try again.');
      },
    ]);
    await expect(createAI({ host, settingsDir, providerOverride: m, moments: true }).applyNote(dir, 'show my bread', () => undefined, undefined, { id: 'stuck-note', owner: 'job-1' }))
      .rejects.toMatchObject({ code: 'ENGINE_STUCK' });
    expect(drawn).toBe(true);
    expect(await read()).toBe(before);
    // the frozen picture and the note's folder, where that engine may still write, are left for recovery
    const frozen = path.join(dir, 'work', 'assets', 'frozen', 'image');
    expect(fs.readdirSync(frozen).filter((f) => f.endsWith('.png'))).toHaveLength(1);
    expect(fs.existsSync(path.join(dir, 'work', 'notes', 'stuck-note'))).toBe(true);
    expect(JSON.parse(await fsp.readFile(path.join(dir, OWNER_LOCK), 'utf8')).token).toBe('job-1');
  });

  // a crash leaves a note's downloads in work/assets: only their note prefix says the note was never saved
  it.each([
    ['the engine saves', true, 'https://example.com/loaf.png'],
    ['the in-app downloader saves from an address with no file name', false, 'https://example.com/?id=123'],
  ])('a picture %s, under an empty name, is not offered after its note crashed', async (_, engine, url) => {
    const { root, dir, host } = await setup();
    host.engineAssets = engine;
    const ctx = (id: string): ToolContext => ({
      projectDir: dir, host, style: new StyleStore(() => root), emit: () => undefined, state: newToolState(), supportsImages: true,
      note: { id, file: path.join(dir, 'project.json'), dir: tmpDir() },
      lookupImpl: async () => ['93.184.215.14'], fetchImpl: (async () => new Response(tinyPng(), { headers: { 'content-type': 'image/png' } })) as any,
    });
    expect((await executeTool(ctx('crashed'), 'fetch_image', { url, name: '' })).isError).toBe(false);
    const listed = JSON.parse((await executeTool(ctx('next'), 'list_library', { kind: 'images' })).content);
    expect(listed.projectAssets).toEqual([]);
  });
});

describe('a note that finishes is saved in one write', () => {
  it('the note, its reply and the rule to ask about are in project.json and its version, and My style waits for the app', async () => {
    const { root, dir, host, settingsDir, read } = await setup();
    const m = new ScriptedModel([
      { toolCalls: [call('set_gap_cap', { seconds: 0.4 }), call('add_style_rule', { rule: 'Leave a little more room between sentences' })] },
      finish('I gave the pauses more room.'),
    ]);
    const events: any[] = [];
    const r = await createAI({ host, settingsDir, providerOverride: m })
      .applyNote(dir, 'from now on leave more room', (e) => events.push(e), undefined, { id: 'job-1', saveStyleRules: false });
    const saved = await read();
    expect(JSON.parse(saved).notes.at(-1)).toMatchObject({ id: 'job-1', version: 2, reply: r.summary, styleRulesAdded: ['Leave a little more room between sentences.'] });
    expect(await fsp.readFile(path.join(dir, 'versions', 'v2', 'project.json'), 'utf8')).toBe(saved);
    expect(await new StyleStore(() => root).list()).toEqual([]);
    expect(events.filter((e) => e.type === 'render').at(-1)).toMatchObject({ draft: false, version: 2 });
    expect(notesLeft(dir)).toBe(0);
  });

  it('a note that only proposes a rule is saved with its question, with no render', async () => {
    const { root, dir, host, settingsDir, read } = await setup();
    const m = new ScriptedModel([{ toolCalls: [call('add_style_rule', { rule: 'Keep music quieter under talking' })] }, finish('I can do that in every video.')]);
    const r = await createAI({ host, settingsDir, providerOverride: m })
      .applyNote(dir, 'I like quieter music', () => undefined, undefined, { id: 'job-2', saveStyleRules: false });
    expect(r).toMatchObject({ styleSuggestions: ['Keep music quieter under talking.'] });
    expect(r).not.toHaveProperty('version');
    expect(host.calls.filter((c) => c.command === 'render')).toEqual([]);
    expect(JSON.parse(await read()).notes.at(-1)).toMatchObject({ id: 'job-2', styleSuggestions: ['Keep music quieter under talking.'] });
    expect(await new StyleStore(() => root).list()).toEqual([]);
  });

  it('fails if a note that changed nothing is saved with a reply claiming it changed the video', async () => {
    const { dir, host, settingsDir, read } = await setup();
    // a live Codex note did this: finish with an edit claimed, no tool changed anything
    const m = new ScriptedModel([finish('I made the captions bigger and cut the first pause.')]);
    const r = await createAI({ host, settingsDir, providerOverride: m })
      .applyNote(dir, 'make the captions bigger and cut the first pause', () => undefined, undefined, { id: 'job-3', saveStyleRules: false });
    const reply = "I made the captions bigger and cut the first pause. (Your video didn't change, so there's no new version.)";
    expect(r).toMatchObject({ changed: [], summary: reply });
    expect(r).not.toHaveProperty('version');
    expect(host.calls.filter((c) => c.command === 'render')).toEqual([]);
    expect(JSON.parse(await read()).notes.at(-1)).toMatchObject({ id: 'job-3', applied: [], reply });
  });
});

describe('a saved note stays saved', () => {
  const ledger = async (dir: string) => (await fsp.readFile(path.join(dir, 'work', 'assets', 'manifest.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  const place = (asset: string, from: string, to: string) => call('add_broll', { anchor: { from, to }, treatment: 'side-card', asset, animation: null, params: {} });

  it('fails if an error after project.json points at the new version takes back a picture that version uses', async () => {
    const { root, dir, host, settingsDir, read } = await setup();
    await fsp.writeFile(path.join(root, 'Library', 'Images', 'loaf.png'), tinyPng([20, 20, 220]));
    await fsp.writeFile(path.join(root, 'Library', 'Images', 'bread.png'), tinyPng());
    // an earlier note froze a picture, so the ledger exists before the one under test
    await createAI({ host, settingsDir, providerOverride: new ScriptedModel([{ toolCalls: [place('Library/Images/loaf.png', 'w29', 'w30')] }, finish('Added the loaf.')]) })
      .applyNote(dir, 'show my loaf', () => undefined);
    expect(JSON.parse(await read()).version).toBe(2);
    // My style turns unreadable once Version 3 is saved: the last read, for the rules to propose, fails
    const checks = StyleStore.prototype.checks;
    const spy = vi.spyOn(StyleStore.prototype, 'checks').mockImplementation(async function (this: unknown) {
      if (JSON.parse(await read()).version === 3) throw Object.assign(new Error('EACCES: permission denied, open style.json'), { code: 'EACCES' });
      return checks.call(this as StyleStore);
    });
    let r;
    try {
      r = await createAI({ host, settingsDir, providerOverride: new ScriptedModel([{ toolCalls: [place('Library/Images/bread.png', 'w33', 'w34')] }, finish('Added the bread.')]) })
        .applyNote(dir, 'show my bread', () => undefined, undefined, { id: 'job-bread' });
    } finally {
      spy.mockRestore();
    }
    expect(spy).toHaveBeenCalled();
    expect(r).toMatchObject({ version: 3, summary: expect.stringContaining('Added the bread.') });
    const saved = JSON.parse(await read());
    expect(saved.notes.at(-1)).toMatchObject({ id: 'job-bread', version: 3 });
    const picture = saved.broll.find((b: { anchor: { from: string } }) => b.anchor.from === 'w33').asset;
    expect(picture).toMatch(/^work\/assets\/frozen\/image\/[0-9a-f]{64}\.png$/);
    expect(fs.existsSync(path.join(dir, picture))).toBe(true);
    expect(JSON.parse(await fsp.readFile(path.join(dir, 'versions', 'v3', 'project.json'), 'utf8')).broll.map((b: { asset: string }) => b.asset)).toContain(picture);
    expect((await ledger(dir)).map((a) => a.committedPath)).toEqual([expect.stringMatching(/frozen\/image\//), picture]);
  });
});

describe('a project.json some Windows editors saved with a byte-order mark', () => {
  it('takes a note like any other project', async () => {
    const { dir, host, settingsDir, read } = await setup();
    await fsp.writeFile(path.join(dir, 'project.json'), '﻿' + (await read()));
    await createAI({ host, settingsDir, providerOverride: new ScriptedModel([
      { toolCalls: [call('set_gap_cap', { seconds: 0.3 })] },
      finish('I tightened the pauses.'),
    ]) }).applyNote(dir, 'tighter', () => undefined);
    expect(JSON.parse(await read()).cut.gapCap).toBe(0.3);
  });

  // a note that changes no picture saves from the starting bytes, not the edited copy: those keep the mark too
  it('saves a note that changes nothing', async () => {
    const { dir, host, settingsDir, read } = await setup();
    await fsp.writeFile(path.join(dir, 'project.json'), '\uFEFF' + (await read()));
    const r = await createAI({ host, settingsDir, providerOverride: new ScriptedModel([finish('It already looks right to me.')]) })
      .applyNote(dir, 'make it pop', () => undefined, undefined, { id: 'job-bom', saveStyleRules: false });
    const reply = "It already looks right to me. (Your video didn't change, so there's no new version.)";
    expect(r).toMatchObject({ changed: [], summary: reply });
    expect(JSON.parse((await read()).replace(/^\uFEFF/, '')).notes.at(-1)).toMatchObject({ id: 'job-bom', reply });
  });
});
