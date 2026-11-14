import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createAI, OWNER_LOCK } from '../src';
import { call, FakeHost, firstVersion, makeProject, ScriptedModel, tmpDir } from './helpers';

const finish = { toolCalls: [call('finish', { summary_for_user: 'Done.' })] };
const change = () => new ScriptedModel([{ toolCalls: [call('set_gap_cap', { seconds: 0.5 })] }, finish]);
const json = async (file: string) => JSON.parse(await fs.readFile(file, 'utf8'));
const folder = async (dir: string) => Object.fromEntries(await Promise.all((await fs.readdir(dir)).map(async (f) => [f, await fs.readFile(path.join(dir, f), 'utf8')])));

async function setup() {
  const { root, dir } = await makeProject();
  await fs.writeFile(path.join(dir, 'media', 'take01.mp4'), 'source');
  const host = new FakeHost(root);
  await firstVersion(dir, host);
  const file = path.join(dir, 'project.json');
  const p = await json(file);
  for (const [size, gapCap] of [[90, 0.4], [150, 0.7]]) {
    p.captions.style.size = size;
    p.cut.gapCap = gapCap;
    await fs.writeFile(file, JSON.stringify(p));
    p.version = (await host.runEngine('render', ['--project', dir])).version;
  }
  p.title = 'Current title';
  p.notes = [{ version: 3, text: 'Earlier note', applied: [], at: p.createdAt }];
  p.handEdits = [{ version: 3, text: 'Earlier manual edit' }];
  await fs.writeFile(file, JSON.stringify(p));
  host.calls = [];
  const saved = await Promise.all([1, 2, 3].map((n) => folder(path.join(dir, 'versions', `v${n}`))));
  return { dir, host, file, saved, settingsDir: tmpDir('tree settings '), before: await fs.readFile(file, 'utf8') };
}

describe('branch notes', () => {
  it.each(['model', 'fast'] as const)('%s note saves a child of the selected edit and preserves live history and saved versions', async (mode) => {
    const { dir, host, file, settingsDir, saved } = await setup();
    const ai = createAI({ host, settingsDir, providerOverride: change() });
    const result = await ai.applyNote(dir, mode === 'fast' ? 'smaller captions' : 'give pauses more room', () => undefined, undefined, { base: 2 });
    expect(result.version).toBe(4);
    const p = await json(file);
    expect(p.cut.gapCap).toBe(mode === 'fast' ? 0.4 : 0.5);
    expect(p.captions.style.size).toBe(mode === 'fast' ? 80 : 90);
    expect(p.title).toBe('Current title');
    expect(p.notes.map((n: { text: string }) => n.text)[0]).toBe('Earlier note');
    expect(p.handEdits).toEqual([{ version: 3, text: 'Earlier manual edit' }]);
    expect(await json(path.join(dir, 'versions/v4/version.json'))).toEqual({ parent: 2 });
    expect(await json(path.join(dir, 'versions/v4/project.json'))).toEqual(p);
    expect(await Promise.all([1, 2, 3].map((n) => folder(path.join(dir, 'versions', `v${n}`))))).toEqual(saved);
  });

  it('a failed branch final leaves no private edit or unpublished version', async () => {
    const { dir, host, file, settingsDir, before, saved } = await setup();
    host.afterRenderFiles = ({ draft }) => { if (!draft) throw { code: 'RENDER_FAILED' }; };
    await expect(createAI({ host, settingsDir, providerOverride: change() }).applyNote(dir, 'give pauses more room', () => undefined, undefined, { base: 2 }))
      .rejects.toMatchObject({ code: 'RENDER_FAILED' });
    expect(await fs.readFile(file, 'utf8')).toBe(before);
    expect(await fs.readdir(path.join(dir, 'work/notes'))).toEqual([]);
    expect((await fs.readdir(path.join(dir, 'versions'))).sort()).toEqual(['v1', 'v2', 'v3']);
    expect(await Promise.all([1, 2, 3].map((n) => folder(path.join(dir, 'versions', `v${n}`))))).toEqual(saved);
  });

  it('a branch final refuses a changed live file and removes only its unpublished attempt', async () => {
    const { dir, host, file, settingsDir } = await setup();
    host.afterRenderFiles = async ({ draft }) => {
      if (!draft) await fs.writeFile(file, JSON.stringify({ ...await json(file), title: 'Changed during render' }));
    };
    await expect(createAI({ host, settingsDir, providerOverride: change() }).applyNote(dir, 'give pauses more room', () => undefined, undefined, { base: 2 }))
      .rejects.toMatchObject({ code: 'project_changed' });
    expect(await json(file)).toMatchObject({ version: 3, title: 'Changed during render', cut: { gapCap: 0.7 } });
    expect((await fs.readdir(path.join(dir, 'versions'))).sort()).toEqual(['v1', 'v2', 'v3']);
  });

  it('concurrent latest and branch notes serialize with the app owner and keep their own parents', async () => {
    const { dir, host, file, settingsDir } = await setup();
    const owner = 'app-job';
    await fs.writeFile(path.join(dir, OWNER_LOCK), JSON.stringify({ token: owner }));
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((r) => { started = r; });
    const gate = new Promise<void>((r) => { release = r; });
    let finals = 0;
    host.afterRenderFiles = async ({ draft }) => {
      if (!draft && ++finals === 1) { started(); await gate; }
    };
    const ai = createAI({ host, settingsDir, providerOverride: new ScriptedModel([]) });
    const latest = ai.applyNote(dir, 'smaller captions', () => undefined, undefined, { owner });
    await entered;
    const branch = ai.applyNote(dir, 'smaller captions', () => undefined, undefined, { owner, base: 2 });
    try {
      expect((await json(path.join(dir, OWNER_LOCK))).token).toBe(owner);
      expect((await json(file)).version).toBe(3);
    } finally { release(); }
    expect((await Promise.all([latest, branch])).map((r) => r.version)).toEqual([4, 5]);
    expect((await json(path.join(dir, 'versions/v4/project.json'))).captions.style.size).toBe(128);
    expect((await json(file)).captions.style.size).toBe(80);
    expect(await json(path.join(dir, 'versions/v4/version.json'))).toEqual({ parent: 3 });
    expect(await json(path.join(dir, 'versions/v5/version.json'))).toEqual({ parent: 2 });
    expect(host.calls.filter((c) => c.command === 'render').every((c) => c.args.includes(owner))).toBe(true);
  });

  it('an explicit latest base uses its frozen edit, not unrendered live changes', async () => {
    const { dir, host, file, settingsDir } = await setup();
    const live = await json(file);
    live.captions.style.size = 110;
    await fs.writeFile(file, JSON.stringify(live));
    await createAI({ host, settingsDir, providerOverride: change() }).applyNote(dir, 'give pauses more room', () => undefined, undefined, { base: 3 });
    expect((await json(file)).captions.style.size).toBe(150);
  });

  it.each([0, 4, 1.5])('refuses invalid base %s before staging', async (base) => {
    const { dir, host, file, settingsDir, before } = await setup();
    await expect(createAI({ host, settingsDir, providerOverride: change() }).applyNote(dir, 'give pauses more room', () => undefined, undefined, { base }))
      .rejects.toMatchObject({ code: 'bad_note_base' });
    expect(await fs.readFile(file, 'utf8')).toBe(before);
    expect(await fs.readdir(path.join(dir, 'work/notes')).catch(() => [])).toEqual([]);
    expect(host.calls).toEqual([]);
  });

  it.each(['asset', 'anchor', 'hidden-caption anchor'] as const)('refuses a base with a missing %s before staging', async (missing) => {
    const { dir, host, file, settingsDir, before } = await setup();
    const snapshot = path.join(dir, 'versions/v2/project.json');
    const p = await json(snapshot);
    if (missing === 'asset') p.music.track = 'work/assets/deleted.mp3';
    else if (missing === 'anchor') p.cut.keep = [{ from: 'old-word', to: 'w56' }];
    else p.captions.hidden = [{ from: 'old-word', to: 'w56' }];
    await fs.writeFile(snapshot, JSON.stringify(p));
    await expect(createAI({ host, settingsDir, providerOverride: change() }).applyNote(dir, 'give pauses more room', () => undefined, undefined, { base: 2 }))
      .rejects.toMatchObject({ code: 'bad_note_base' });
    expect(await fs.readFile(file, 'utf8')).toBe(before);
    expect(host.calls).toEqual([]);
    expect(await fs.readdir(path.join(dir, 'work/notes')).catch(() => [])).toEqual([]);
  });
});
