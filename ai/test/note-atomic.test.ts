// A note is all-or-nothing (editor.ts applyNote): the ways a real note ends, on a project that already
// has its first edit (a cut and Version 1), as every note does.
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { createAI, AIError, StyleStore, listVersions } from '../src';
import { FakeHost, ScriptedModel, makeProject, call, tmpDir, firstVersion } from './helpers';

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

  it('a model that answers in words and never calls a tool gets the "not sure" reply, and nothing changes', async () => {
    const { dir, host, settingsDir, read, before } = await setup();
    const m = new ScriptedModel(Array.from({ length: 6 }, () => ({ text: 'The music suits your bread nicely.' })));
    const r = await createAI({ host, settingsDir, providerOverride: m }).applyNote(dir, 'what do you think of the music?', () => undefined);
    expect(r).toMatchObject({ summary: 'I looked, but I was not sure what to change. Could you say it another way?', version: 1, changed: [] });
    expect(await read()).toBe(before);
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
    expect(r).toMatchObject({ version: 1, styleSuggestions: ['Keep music quieter under talking.'] });
    expect(host.calls.filter((c) => c.command === 'render')).toEqual([]);
    expect(JSON.parse(await read()).notes.at(-1)).toMatchObject({ id: 'job-2', version: 1, styleSuggestions: ['Keep music quieter under talking.'] });
    expect(await new StyleStore(() => root).list()).toEqual([]);
  });
});
