import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as api from '../src';
import { FakeHost, ScriptedModel, call, makeProject, makeTranscript, tmpDir } from './helpers';

const take = { cut: 'ours', captions: 'ours', music: 'ours', zooms: 'ours', broll: 'ours', sfx: 'ours', cover: 'ours' } as const;
const transcript = makeTranscript(['one two three four five six']);
const range = (from: number, to = from) => ({ from: `w${from}`, to: `w${to}` });
function pair() {
  const ours = api.withDefaults({ id: 'same', title: 'Ours', sources: [{ id: 's1', path: 'media/take.mp4' }] });
  ours.cut.keep = [range(0, 5)];
  ours.broll = [{ id: 'a', anchor: range(1), asset: null, treatment: 'text-pop', params: { text: 'ours' } }];
  ours.zooms = [{ anchor: range(2), scale: 1.1 }];
  ours.sfx = [{ at: { word: 'w3' }, sound: 'whoosh-quick', gainDb: -4 }];
  const theirs = structuredClone(ours);
  theirs.cut.gapCap = 0.5;
  theirs.sources[0].mirror = true;
  theirs.format.fps = 60;
  theirs.captions.style.color = '#FF0000';
  theirs.captions.corrections = [{ from: 'one', to: 'One!' }];
  theirs.music.level = 'quiet';
  theirs.music.automation = [{ fromWord: 'w1', toWord: 'w3', gainDb: -6 }];
  theirs.broll[0].params.text = 'theirs';
  theirs.zooms[0].scale = 1.2;
  theirs.sfx = [{ at: { word: 'w4' }, sound: 'pop', gainDb: -9 }];
  theirs.cover.text = 'Their cover';
  theirs.post.caption = 'Their post';
  return { ours, theirs };
}

describe('explicit version layers', () => {
  for (const layer of Object.keys(take) as (keyof typeof take)[]) {
    it.each(['ours', 'theirs'] as const)(`takes the entire ${layer} layer from %s`, (side) => {
      const versions = pair();
      const { edit } = api.mergeVersions({ ...versions, take: { ...take, [layer]: side } }, transcript);
      expect(edit[layer]).toEqual(versions[side][layer]);
      if (layer === 'cut') {
        expect(edit.sources).toEqual(versions[side].sources);
        expect(edit.format).toEqual(versions[side].format);
      }
      expect(edit.post).toEqual(versions.ours.post);
    });
  }

  it('captions use only kept words while retaining text correction rules and style', () => {
    const versions = pair();
    versions.ours.cut.keep = [range(4, 5), range(1, 2)];
    versions.theirs.captions.hidden = [range(0, 3), range(3)];
    versions.ours.sfx = [];
    const result = api.mergeVersions({ ...versions, take: { ...take, captions: 'theirs' } }, transcript);
    expect(api.keptWords(transcript, result.edit.cut.keep).map((w) => w.id)).toEqual(['w4', 'w5', 'w1', 'w2']);
    expect(result.edit.captions).toEqual({ ...versions.theirs.captions, hidden: [range(1, 2)] });
    expect(result.report).toEqual([
      'Adjusted caption hidden range 1 to the kept words w1 through w2.',
      'Dropped caption hidden range 2 because none of its words are kept.',
    ]);
  });

  it('drops b-roll when its start word was removed and reports the item', () => {
    const versions = pair();
    versions.ours.cut.keep = [range(2, 5)];
    const { edit, report } = api.mergeVersions({ ...versions, take: { ...take, broll: 'theirs' } }, transcript);
    expect(edit.broll).toEqual([]);
    expect(report).toContain('Dropped b-roll a because its start word w1 is not kept.');
  });

  it('splits zoom and music ranges around removed words and drops sound effects on a removed word', () => {
    const versions = pair();
    versions.ours.cut.keep = [range(0, 1), range(4, 5)];
    versions.theirs.zooms = [{ anchor: range(0, 5), scale: 1.2 }];
    versions.theirs.music.automation = [{ fromWord: 'w0', toWord: 'w5', gainDb: -6 }];
    versions.theirs.sfx = [{ at: { word: 'w3' }, sound: 'gone' }];
    const { edit, report } = api.mergeVersions({ ...versions, take: { ...take, zooms: 'theirs', music: 'theirs', sfx: 'theirs' } }, transcript);
    expect(edit.zooms).toEqual([{ anchor: range(0, 1), scale: 1.2 }, { anchor: range(4, 5), scale: 1.2 }]);
    expect(edit.music.automation).toEqual([{ fromWord: 'w0', toWord: 'w1', gainDb: -6 }, { fromWord: 'w4', toWord: 'w5', gainDb: -6 }]);
    expect(edit.sfx).toEqual([]);
    expect(report).toContain('Dropped sound effect 1 (gone) because its word w3 is not kept.');
    expect(report.filter((line) => line.startsWith('Adjusted'))).toHaveLength(2);
  });

  it('trims pictures at the first cut rather than moving their start; a sound stays on its kept word', () => {
    const versions = pair();
    versions.ours.cut.keep = [range(1, 2), range(4, 5)];
    versions.theirs.broll[0].anchor = range(1, 5);
    versions.theirs.sfx = [{ at: { word: 'w1' }, sound: 'ding' }, { at: { cut: 'w4' }, sound: 'whoosh-quick' }];
    const result = api.mergeVersions({ ...versions, take: { ...take, broll: 'theirs', sfx: 'theirs' } }, transcript);
    expect(result.edit.broll[0].anchor).toEqual(range(1, 2));
    expect(result.edit.sfx).toEqual([{ at: { word: 'w1' }, sound: 'ding' }, { at: { cut: 'w4' }, sound: 'whoosh-quick' }]);
    expect(result.report).toContain('Adjusted b-roll a to end at kept word w2.');
  });

  // #72's sound effects land on one moment, a picture's among them: one on a dropped picture goes with it
  it('drops a sound effect whose picture was dropped', () => {
    const versions = pair();
    versions.ours.cut.keep = [range(2, 5)];
    versions.theirs.sfx = [{ at: { broll: 'a' }, sound: 'pop' }];
    const { edit, report } = api.mergeVersions({ ...versions, take: { ...take, sfx: 'theirs' } }, transcript);
    expect(edit.broll).toEqual([]);
    expect(edit.sfx).toEqual([]);
    expect(report).toContain('Dropped sound effect 1 (pop) because its picture a is not kept.');
  });

  it('returns the same bytes for the same inputs and does not share mutable objects', () => {
    const input = { ...pair(), take };
    const before = JSON.stringify(input);
    const first = api.mergeVersions(input, transcript);
    const second = api.mergeVersions(input, transcript);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    first.edit.captions.style.color = '#000000';
    expect(JSON.stringify(input)).toBe(before);
    expect(second.edit.captions.style.color).not.toBe('#000000');
  });

  it('refuses missing choices and missing transcript anchors instead of guessing', () => {
    expect(() => api.mergeVersions({ ...pair(), take: { cut: 'ours' } as any }, transcript)).toThrow(/choose.*captions/i);
    const versions = pair();
    versions.theirs.broll[0].anchor = { from: 'missing', to: 'w2' };
    expect(() => api.mergeVersions({ ...versions, take: { ...take, broll: 'theirs' } }, transcript)).toThrow(/unknown word id missing/i);
  });
});

async function savedPair() {
  const { root, dir } = await makeProject({ lines: ['one two three four five six'] });
  const host = new FakeHost(root);
  await fs.writeFile(path.join(dir, 'media/take01.mp4'), 'source');
  const p = await api.loadProject(dir);
  p.cut.keep = [range(0, 5)];
  await api.saveProject(dir, p);
  await host.runEngine('render', ['--project', dir]);
  const next = await api.loadProject(dir);
  next.captions.style.color = '#FF0000';
  await api.saveProject(dir, next);
  await host.runEngine('render', ['--project', dir]);
  const live = await api.loadProject(dir);
  live.title = 'Live title';
  live.handEdits = { retained: true };
  await api.saveProject(dir, live);
  const before = await fs.readFile(path.join(dir, 'project.json'), 'utf8');
  const saved = await folders(dir);
  const ai = api.createAI({ host, settingsDir: tmpDir() });
  return { dir, host, ai, before, saved };
}
async function folders(dir: string) {
  const result: Record<string, string> = {};
  for (const n of [1, 2]) for (const file of await fs.readdir(path.join(dir, `versions/v${n}`))) {
    result[`${n}/${file}`] = (await fs.readFile(path.join(dir, `versions/v${n}`, file))).toString('base64');
  }
  return result;
}

it('saves a fresh merge without AI, with two parents, live history, and untouched old folders', async () => {
  const { dir, ai, saved } = await savedPair();
  const result = await ai.mergeVersions(dir, { ours: 2, theirs: 1, take }, () => undefined);
  expect(result.version).toBe(3);
  expect(result.report).toEqual([]);
  expect(result.edit).toMatchObject({ version: 3, title: 'Live title', handEdits: { retained: true }, captions: { style: { color: '#FF0000' } } });
  expect(JSON.parse(await fs.readFile(path.join(dir, 'versions/v3/version.json'), 'utf8'))).toEqual({ parent: 2, parents: [2, 1] });
  expect(await fs.readFile(path.join(dir, 'versions/v3/project.json'), 'utf8')).toBe(await fs.readFile(path.join(dir, 'project.json'), 'utf8'));
  expect(await folders(dir)).toEqual(saved);
});

it.each(['render', 'cancel', 'compare-and-swap'] as const)('leaves a failed merge unpublished after %s failure', async (failure) => {
  const { dir, host, ai, before, saved } = await savedPair();
  const stop = new AbortController();
  let expectedLive = before;
  host.afterRenderFiles = async ({ draft }) => {
    if (draft) return;
    if (failure === 'render') throw new Error('render failed');
    if (failure === 'cancel') stop.abort();
    if (failure === 'compare-and-swap') {
      expectedLive = JSON.stringify({ ...JSON.parse(before), title: 'Changed meanwhile' });
      await fs.writeFile(path.join(dir, 'project.json'), expectedLive);
    }
  };
  await expect(ai.mergeVersions(dir, { ours: 1, theirs: 2, take }, () => undefined, stop.signal)).rejects.toThrow();
  expect(await fs.readFile(path.join(dir, 'project.json'), 'utf8')).toBe(expectedLive);
  expect(await folders(dir)).toEqual(saved);
  expect(await fs.readdir(path.join(dir, 'versions'))).toEqual(['v1', 'v2']);
  expect(await fs.readdir(path.join(dir, 'work/notes'))).toEqual([]);
});

it('merge_versions stages the chosen layers in the note transaction and saves both parents', async () => {
  const { dir, host, saved } = await savedPair();
  const model = new ScriptedModel([
    { toolCalls: [call('merge_versions', { ours: 1, theirs: 2, take: { ...take, captions: 'theirs' } })] },
    { toolCalls: [call('finish', { summary_for_user: 'Combined your versions.' })] },
  ]);
  const result = await api.createAI({ host, settingsDir: tmpDir(), providerOverride: model }).applyNote(dir, 'Combine versions 1 and 2, using captions from 2.', () => undefined);
  expect(result.version).toBe(3);
  expect((await api.loadProject(dir)).captions.style.color).toBe('#FF0000');
  expect(JSON.parse(await fs.readFile(path.join(dir, 'versions/v3/version.json'), 'utf8'))).toEqual({ parent: 1, parents: [1, 2] });
  expect(await folders(dir)).toEqual(saved);
});

it('splits continuous overlays at a source change even when word ids are adjacent', () => {
  const versions = pair();
  const t = structuredClone(transcript);
  t.words.slice(3).forEach((w) => { w.source = 's2'; });
  versions.ours.sources.push({ id: 's2', path: 'media/second.mp4' });
  versions.ours.captions.hidden = [range(1, 4)];
  versions.ours.music.automation = [{ fromWord: 'w1', toWord: 'w4', gainDb: -6 }];
  versions.ours.zooms = [{ anchor: range(1, 4), scale: 1.2 }];
  versions.ours.broll[0].anchor = range(1, 4);
  versions.ours.sfx = [{ at: { word: 'w1' }, sound: 'boundary' }];
  const { edit, report } = api.mergeVersions({ ...versions, take }, t);
  expect(edit.broll[0].anchor).toEqual(range(1, 2));
  expect(edit.sfx).toEqual([{ at: { word: 'w1' }, sound: 'boundary' }]);
  expect(report).toContain('Adjusted b-roll a to end at kept word w2.');
  expect(edit.captions.hidden).toEqual([range(1, 2), range(3, 4)]);
  expect(edit.zooms.map((z) => z.anchor)).toEqual([range(1, 2), range(3, 4)]);
  expect(edit.music.automation).toEqual([{ fromWord: 'w1', toWord: 'w2', gainDb: -6 }, { fromWord: 'w3', toWord: 'w4', gainDb: -6 }]);
});

it.each(['command', 'note'])('leaves scratch and the unpublished attempt for recovery when a merge engine is stuck via %s', async (route) => {
  const { dir, host, ai, before, saved } = await savedPair();
  host.afterRenderFiles = () => { throw Object.assign(new Error('still running'), { code: 'ENGINE_STUCK' }); };
  const model = new ScriptedModel([{ toolCalls: [call('merge_versions', { ours: 1, theirs: 2, take })] }, { toolCalls: [call('finish', { summary_for_user: 'Combined.' })] }]);
  const operation = route === 'command'
    ? ai.mergeVersions(dir, { ours: 1, theirs: 2, take }, () => undefined, undefined, { id: 'stuck-merge' })
    : api.createAI({ host, settingsDir: tmpDir(), providerOverride: model }).applyNote(dir, 'Combine versions.', () => undefined, undefined, { id: 'stuck-merge' });
  await expect(operation).rejects.toMatchObject({ code: 'ENGINE_STUCK' });
  expect(await fs.readFile(path.join(dir, 'project.json'), 'utf8')).toBe(before);
  expect(await folders(dir)).toEqual(saved);
  await expect(fs.access(path.join(dir, 'work/notes/stuck-merge/edit.json'))).resolves.toBeUndefined();
  await expect(fs.access(path.join(dir, 'versions/v3/export.mp4'))).resolves.toBeUndefined();
});

it('refuses unknown layer keys even when their names occur on Object.prototype', () => {
  expect(() => api.mergeVersions({ ...pair(), take: { ...take, constructor: 'ours' } as any }, transcript)).toThrow(/Unknown merge layer constructor/);
});

it.each([null, { ours: 1, theirs: 2, take: { cut: 'ours' } }])('returns a specific user-facing error for an incomplete merge request %j', async (request) => {
  const { dir, ai, before } = await savedPair();
  await expect(ai.mergeVersions(dir, request as any, () => undefined)).rejects.toMatchObject({
    code: 'bad_merge', userMessage: expect.stringMatching(/choose/i),
  });
  expect(await fs.readFile(path.join(dir, 'project.json'), 'utf8')).toBe(before);
});

describe('which layers two versions differ in', () => {
  it('names each changed layer once, and nothing for a change outside the layers (the post caption)', () => {
    const { ours, theirs } = pair();
    expect(api.differingLayers(ours, theirs)).toEqual(['cut', 'captions', 'music', 'zooms', 'broll', 'sfx', 'cover']);
    const music = structuredClone(ours);
    music.music.level = 'quiet';
    music.post.caption = 'Only the post changed besides the music';
    expect(api.differingLayers(ours, music)).toEqual(['music']);
    const post = structuredClone(ours);
    post.post.caption = 'Different words for the post';
    expect(api.differingLayers(ours, post)).toEqual([]);
  });

  it('a mirrored source counts as a change of the cut, which owns the sources', () => {
    const { ours } = pair();
    const mirrored = structuredClone(ours);
    mirrored.sources[0].mirror = true;
    expect(api.differingLayers(ours, mirrored)).toEqual(['cut']);
  });
});
