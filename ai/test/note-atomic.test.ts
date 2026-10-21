// A note is all-or-nothing (editor.ts applyNote): these are the ways a real note ends early.
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { createAI, AIError, StyleStore } from '../src';
import { FakeHost, ScriptedModel, makeProject, call, tmpDir } from './helpers';

async function setup() {
  const { root, dir } = await makeProject();
  const host = new FakeHost(root);
  const read = () => fsp.readFile(path.join(dir, 'project.json'), 'utf8');
  return { root, dir, host, settingsDir: tmpDir('settings '), read, before: await read() };
}

const notesLeft = (dir: string) => fs.readdirSync(path.join(dir, 'work', 'notes')).length;

describe('a note that does not finish leaves the project as it was', () => {
  it('a provider error after a change and a download: nothing saved, and the picture is not offered again', async () => {
    const { dir, host, settingsDir, read, before } = await setup();
    host.engineAssets = true;
    const m = new ScriptedModel([
      { toolCalls: [call('fetch_image', { url: 'https://example.com/loaf.png', name: 'loaf' }), call('set_gap_cap', { seconds: 0.4 })] },
      new AIError('network', 'I could not reach the AI. Check your internet and try again.'),
    ]);
    await expect(createAI({ host, settingsDir, providerOverride: m }).applyNote(dir, 'slower, with a picture of my loaf', () => undefined))
      .rejects.toMatchObject({ code: 'network' });
    expect(await read()).toBe(before);
    expect(notesLeft(dir)).toBe(0);
    expect(fs.existsSync(path.join(dir, 'work', 'assets', 'loaf.png'))).toBe(true);

    let offered = '';
    const next = new ScriptedModel([
      { toolCalls: [call('list_library', { kind: 'images' })] },
      (req) => { offered = JSON.stringify(req.messages.at(-1)); return { toolCalls: [call('finish', { summary_for_user: 'Nothing to change.' })] }; },
    ]);
    await createAI({ host, settingsDir, providerOverride: next }).applyNote(dir, 'any pictures already?', () => undefined);
    expect(offered).toContain('projectAssets');
    expect(offered).not.toContain('loaf.png');
  });

  it('Stop during the final render: the half-made version is gone and the next note makes it cleanly', async () => {
    const { dir, host, settingsDir, read, before } = await setup();
    const ac = new AbortController();
    host.afterRenderFiles = ({ draft }) => {
      if (draft) return;
      ac.abort();       // the engine had already written versions/v1/export.mp4
      throw { code: 'CANCELLED', userMessage: 'Stopped.' };
    };
    const m = new ScriptedModel([
      { toolCalls: [call('set_gap_cap', { seconds: 0.4 })] },
      { toolCalls: [call('finish', { summary_for_user: 'I gave the pauses more room.' })] },
    ]);
    await expect(createAI({ host, settingsDir, providerOverride: m }).applyNote(dir, 'slower', () => undefined, ac.signal)).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(await read()).toBe(before);
    expect(fs.existsSync(path.join(dir, 'versions', 'v1'))).toBe(false);
    expect(notesLeft(dir)).toBe(0);

    host.afterRenderFiles = undefined;
    const again = new ScriptedModel([
      { toolCalls: [call('set_gap_cap', { seconds: 0.5 })] },
      { toolCalls: [call('finish', { summary_for_user: 'Even more room now.' })] },
    ]);
    const r = await createAI({ host, settingsDir, providerOverride: again }).applyNote(dir, 'even slower', () => undefined);
    expect(r.version).toBe(1);
    expect(await fsp.readFile(path.join(dir, 'versions', 'v1', 'notes.md'), 'utf8')).toBe('# v1\n\nNote: even slower\n\nEven more room now.\n');
  });

  it('a change made to project.json while the note runs is kept, and the note is not saved over it', async () => {
    const { dir, host, settingsDir, read } = await setup();
    const m = new ScriptedModel([
      { toolCalls: [call('set_gap_cap', { seconds: 0.4 })] },
      async () => {
        const p = JSON.parse(await read());
        await fsp.writeFile(path.join(dir, 'project.json'), JSON.stringify({ ...p, title: 'Renamed by hand' }, null, 2));
        return { toolCalls: [call('finish', { summary_for_user: 'I gave the pauses more room.' })] };
      },
    ]);
    await expect(createAI({ host, settingsDir, providerOverride: m }).applyNote(dir, 'slower', () => undefined)).rejects.toMatchObject({ code: 'project_changed' });
    const p = JSON.parse(await read());
    expect(p.title).toBe('Renamed by hand');
    expect(p.cut.gapCap).toBe(0.25);
    expect(fs.existsSync(path.join(dir, 'versions', 'v1'))).toBe(false);
  });

  it('a project with only a preview keeps that preview when a note fails at the final render', async () => {
    const { dir, host, settingsDir, read, before } = await setup();
    const preview = path.join(dir, 'versions', 'preview', 'draft.mp4');
    await fsp.mkdir(path.dirname(preview), { recursive: true });
    await fsp.writeFile(preview, 'the first preview');
    host.afterRenderFiles = ({ draft }) => { if (!draft) throw { code: 'RENDER_FAILED', userMessage: 'The video could not be made.' }; };
    const m = new ScriptedModel([
      { toolCalls: [call('set_gap_cap', { seconds: 0.4 })] },
      { toolCalls: [call('render_draft')] },
      { toolCalls: [call('finish', { summary_for_user: 'I gave the pauses more room.' })] },
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

describe('a note that changes nothing in the video', () => {
  it('"from now on..." alone renders nothing and goes back to the app as a question', async () => {
    const { root, dir, host, settingsDir, read, before } = await setup();
    const m = new ScriptedModel([
      { toolCalls: [call('add_style_rule', { rule: 'Keep music quieter under talking' })] },
      { toolCalls: [call('finish', { summary_for_user: 'Got it.' })] },
    ]);
    const r = await createAI({ host, settingsDir, providerOverride: m })
      .applyNote(dir, 'from now on keep music quieter', () => undefined, undefined, { saveStyleRules: false });
    expect(r.styleRulesAdded).toEqual(['Keep music quieter under talking.']);
    expect(host.calls.filter((c) => c.command === 'render')).toEqual([]);
    expect(await read()).toBe(before);
    expect(await new StyleStore(() => root).list()).toEqual([]);
  });
});

describe('a note that finishes is saved in one write', () => {
  it('the note, its reply and the rule to ask about are in project.json and its version, and My style waits for the app', async () => {
    const { root, dir, host, settingsDir, read } = await setup();
    const m = new ScriptedModel([
      { toolCalls: [call('set_gap_cap', { seconds: 0.4 }), call('add_style_rule', { rule: 'Leave a little more room between sentences' })] },
      { toolCalls: [call('finish', { summary_for_user: 'I gave the pauses more room.' })] },
    ]);
    const events: any[] = [];
    const r = await createAI({ host, settingsDir, providerOverride: m })
      .applyNote(dir, 'from now on leave more room', (e) => events.push(e), undefined, { id: 'job-1', saveStyleRules: false });
    const saved = await read();
    const note = JSON.parse(saved).notes.at(-1);
    expect(note).toMatchObject({ id: 'job-1', version: 1, reply: r.summary, styleRulesAdded: ['Leave a little more room between sentences.'] });
    expect(await fsp.readFile(path.join(dir, 'versions', 'v1', 'project.json'), 'utf8')).toBe(saved);
    expect(await new StyleStore(() => root).list()).toEqual([]);
    expect(events.filter((e) => e.type === 'render').at(-1)).toMatchObject({ draft: false, version: 1 });
    expect(notesLeft(dir)).toBe(0);
  });
});
