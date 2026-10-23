import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import {
  loadProject, saveProject, validateProject, withDefaults, loadTranscript, findPhrase, anchorText, keptWords,
  approxOutputTimes, approxDuration, normalizeKeep, snapshotVersion, restoreVersion, listVersions, writeFileAtomic,
  loadAnalysis, normalizeAnalysis, nextBrollId,
} from '../src';
import { makeProject, makeTranscript, tmpDir } from './helpers';

describe('project API', () => {
  it('loads, validates and saves atomically in a path with spaces and unicode', async () => {
    const { dir } = await makeProject();
    expect(dir).toMatch(/ /);
    const p = await loadProject(dir);
    expect(p.schemaVersion).toBe(1);
    expect(p.captions.style.maxWords).toBe(3);
    p.title = 'Pão caseiro';
    await saveProject(dir, p);
    const again = await loadProject(dir);
    expect(again.title).toBe('Pão caseiro');
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('preserves unknown fields written by other components', async () => {
    const { dir } = await makeProject();
    const raw = JSON.parse(await fsp.readFile(path.join(dir, 'project.json'), 'utf8'));
    raw.engineExtra = { keep: 1 };
    await fsp.writeFile(path.join(dir, 'project.json'), JSON.stringify(raw));
    const p = await loadProject(dir);
    await saveProject(dir, p);
    expect(JSON.parse(await fsp.readFile(path.join(dir, 'project.json'), 'utf8')).engineExtra).toEqual({ keep: 1 });
  });

  it('rejects invalid projects and bad anchors', async () => {
    expect(validateProject({})).toContain('schemaVersion must be 1');
    const t = makeTranscript(['one two three']);
    const p = withDefaults({ title: 'x', slug: 'x' });
    p.cut.keep = [{ from: 'w2', to: 'w0' }];
    expect(validateProject(p, t).join()).toMatch(/backwards/);
    p.cut.keep = [{ from: 'w0', to: 'w99' }];
    expect(validateProject(p, t).join()).toMatch(/unknown word id w99/);
    p.cut.keep = [{ from: 'w0', to: 'w2' }];
    p.post.hashtags = ['#a'];
    expect(validateProject(p, t).join()).toMatch(/exactly 5/);
    await expect(saveProject(tmpDir(), p)).rejects.toThrow(/invalid/);
  });

  it('word anchor helpers', async () => {
    const { dir } = await makeProject();
    const p = await loadProject(dir);
    const t = await loadTranscript(dir, p);
    expect(anchorText(t, { from: 'w27', to: 'w34' })).toBe('I spent twenty bucks on a fancy flour');
    expect(findPhrase(t, 'Twenty bucks!')).toEqual({ from: 'w29', to: 'w30' });
    const keep = [{ from: 'w16', to: 'w26' }, { from: 'w27', to: 'w34' }];
    expect(keptWords(t, keep)).toHaveLength(19);
    const times = approxOutputTimes(t, keep, 0.1);
    expect(times.get('w16')!.s).toBe(0);
    expect(times.get('w27')!.s).toBeGreaterThan(times.get('w26')!.e);
    expect(times.get('w27')!.s - times.get('w26')!.e).toBeLessThanOrEqual(0.1001); // gap capped
    expect(approxDuration(t, keep, 0.1)).toBeGreaterThan(5);
    const n = normalizeKeep(t, [{ from: 'w0', to: 'w3' }, { from: 'w2', to: 'w5' }]);
    expect(n.problems.join()).toMatch(/repeats word/);
  });

  it('versions: snapshot never overwrites, restore keeps counter', async () => {
    const { dir } = await makeProject();
    const p = await loadProject(dir);
    p.version = 1;
    await saveProject(dir, p);
    await snapshotVersion(dir, p, 1, 'first');
    p.title = 'changed'; p.version = 2;
    await saveProject(dir, p);
    await snapshotVersion(dir, p, 1); // no overwrite
    expect(JSON.parse(await fsp.readFile(path.join(dir, 'versions', 'v1', 'project.json'), 'utf8')).title).toBe('Baking bread');
    expect(await listVersions(dir)).toEqual([1]);
    const r = await restoreVersion(dir, 1);
    expect(r.title).toBe('Baking bread');
    expect(r.version).toBe(2);
    expect(await fsp.readFile(path.join(dir, 'versions', 'v1', 'notes.md'), 'utf8')).toMatch(/first/);
  });

  it('analysis normalization tolerates naming variants', async () => {
    const a = normalizeAnalysis({ retake_groups: [{ takes: [{ start: 'w1', end: 'w2' }] }] });
    expect(a.retakes[0]).toMatchObject({ id: 'r1', candidates: [{ from: 'w1', to: 'w2' }] });
    const { dir } = await makeProject();
    expect((await loadAnalysis(dir))!.retakes).toHaveLength(1);
  });

  it('atomic write survives concurrent writers', async () => {
    const f = path.join(tmpDir(), 'x.json');
    await Promise.all(Array.from({ length: 20 }, (_, i) => writeFileAtomic(f, JSON.stringify({ i }))));
    expect(typeof JSON.parse(await fsp.readFile(f, 'utf8')).i).toBe('number');
  });

  it('broll ids are unique', () => {
    const p = withDefaults({});
    p.broll = [{ id: 'b2', anchor: { from: 'w0', to: 'w0' }, treatment: 'text-pop', asset: null, params: {} }];
    expect(nextBrollId(p)).toBe('b3');
  });

  it('a save waits out a Windows lock on project.json of a few seconds instead of giving up', async () => {
    const dir = tmpDir('atomic ');
    const file = path.join(dir, 'project.json');
    fs.writeFileSync(file, 'old');
    const lockedUntil = Date.now() + 2000;
    await writeFileAtomic(file, 'new', undefined, async () => {
      if (Date.now() < lockedUntil) throw Object.assign(new Error('locked'), { code: 'EPERM' });
    });
    expect(fs.readFileSync(file, 'utf8')).toBe('new');
  });
});
