import { afterEach, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { learn } from '../src/learning';
import { StyleStore } from '../src/style';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });

async function fixture(watches = [12000, 12000, 12000], reach = 1000, actions = 24) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'reel-learning-'));
  roots.push(root);
  const projects = path.join(root, 'Projects');
  for (const [i, watch] of watches.entries()) {
    const dir = path.join(projects, `reel-${i}`);
    for (const [version, exposure] of [[1, 1], [2, 1.08]]) {
      await fs.mkdir(path.join(dir, 'versions', `v${version}`), { recursive: true });
      await fs.writeFile(path.join(dir, 'versions', `v${version}`, 'project.json'), JSON.stringify({ exposure, version, cut: { keep: [] } }));
    }
    await fs.writeFile(path.join(dir, 'trials.json'), JSON.stringify([{ parent_version: 1, variable: 'brightness', from: 1, to: 1.08 }]));
    const outcome = (version: number, averageWatchTimeMs: number, saves: number) => ({
      version, accountId: '123', postId: `${i}${version}`, publishedAt: '2026-01-01T00:00:00Z',
      platform: 'instagram', apiVersion: 'v26.0', observedAt: '2026-01-02T00:00:00Z',
      metrics: { plays: reach, reach, likes: 50, comments: 5, saves, shares: 0, averageWatchTimeMs, totalWatchTimeMs: reach * averageWatchTimeMs, skipRatePercent: null }
    });
    await fs.writeFile(path.join(dir, 'outcomes.json'), JSON.stringify({ schemaVersion: 1, versions: {
      v1: { [`${i}1`]: outcome(1, 10000, 20) }, v2: { [`${i}2`]: outcome(2, watch, actions) }
    } }));
  }
  return { root, projects, style: new StyleStore(() => root) };
}

it('a clear win proposes a short rule with linked evidence, without applying it', async () => {
  const { projects, style } = await fixture();
  const proposals = await learn(projects);
  expect(proposals).toHaveLength(1);
  expect(proposals[0]).toMatchObject({ kind: 'look', line: 'Prefer 8% brighter exposure.', from: {
    kind: 'results', metric: 'averageWatchTimeMs', change: 0.2, n: 3,
    evidence: '3 of 3 trials, avg watch +20%, saves + shares/reach +20%'
  } });
  expect(proposals[0].line.length).toBeLessThanOrEqual(60);
  expect(proposals[0].from.kind).toBe('results');
  if (proposals[0].from.kind === 'results') {
    expect(proposals[0].from.trials).toHaveLength(3);
    expect(proposals[0].from.trials[0]).toMatchObject({ project: 'reel-0', parentVersion: 1, version: 2, parentPostId: '01', postId: '02', href: 'reel-0/trials.json#/0' });
  }
  expect(await style.list()).toEqual([]);
});

it('noise produces no proposal', async () => {
  expect(await learn((await fixture([10200, 10300, 10100])).projects)).toEqual([]);
});

it('low reach produces no proposal', async () => {
  expect(await learn((await fixture(undefined, 299)).projects)).toEqual([]);
});

it('conflicting trials produce no proposal', async () => {
  expect(await learn((await fixture([12500, 12500, 8000, 8000])).projects)).toEqual([]);
});

it('a forgotten rule is not proposed again after restart', async () => {
  const { root, projects, style } = await fixture();
  const [proposal] = await learn(projects);
  await style.propose(proposal);
  const saved = JSON.parse(await fs.readFile(path.join(root, 'My style.json'), 'utf8'));
  await style.dismiss(saved.proposals[0].id);
  expect(await learn(projects)).toEqual([]);
});

it('the same input gives the same output', async () => {
  const { projects } = await fixture();
  const first = await learn(projects);
  expect(first).toHaveLength(1);
  expect(await learn(projects)).toEqual(first);
});

it('a watch win with worse saves and shares per reach produces no proposal', async () => {
  expect(await learn((await fixture(undefined, 1000, 10)).projects)).toEqual([]);
});

it('an existing rule is not proposed again', async () => {
  const { projects, style } = await fixture();
  await style.add('PREFER 8% brighter exposure!');
  expect(await learn(projects)).toEqual([]);
});

it('a changed body invalidates the single-variable comparison', async () => {
  const { projects } = await fixture();
  const file = path.join(projects, 'reel-0', 'versions', 'v2', 'project.json');
  await fs.writeFile(file, JSON.stringify({ exposure: 1.08, version: 2, cut: { keep: [{ from: 'w1', to: 'w3' }] } }));
  expect(await learn(projects)).toEqual([]);
});

it('duplicate trial rows cannot supply independent agreement', async () => {
  const { projects } = await fixture([12000]);
  const file = path.join(projects, 'reel-0', 'trials.json');
  const [trial] = JSON.parse(await fs.readFile(file, 'utf8'));
  await fs.writeFile(file, JSON.stringify([trial, trial, trial]));
  expect(await learn(projects)).toEqual([]);
});

it('missing metrics and ambiguous posts supply no evidence', async () => {
  const { projects } = await fixture();
  for (const i of [0, 1]) {
    const file = path.join(projects, `reel-${i}`, 'outcomes.json');
    const data = JSON.parse(await fs.readFile(file, 'utf8'));
    if (i === 0) data.versions.v2['02'].metrics.averageWatchTimeMs = null;
    else data.versions.v2.extra = { ...data.versions.v2['12'], postId: 'extra' };
    await fs.writeFile(file, JSON.stringify(data));
  }
  expect(await learn(projects)).toEqual([]);
});

it('a complete secondary-metric loss vetoes otherwise agreeing wins', async () => {
  const { projects } = await fixture([12000, 12000, 12000, 12000]);
  const file = path.join(projects, 'reel-3', 'outcomes.json');
  const data = JSON.parse(await fs.readFile(file, 'utf8'));
  data.versions.v2['32'].metrics.saves = 0;
  await fs.writeFile(file, JSON.stringify(data));
  expect(await learn(projects)).toEqual([]);
});

// fails if a suggestion keeps waiting after its trials stop agreeing, so an opposite one could wait beside it
// (audit 05-results), or if a damaged trial file empties the list instead of stopping
it('takes back a waiting results suggestion the results no longer support, and nothing else', async () => {
  const { root, projects, style } = await fixture();
  const [brighter] = await learn(projects, style);
  await style.propose(brighter);
  await style.propose({ kind: 'captions', line: 'Use bigger subtitles', text: 'Use bigger subtitles.', from: { kind: 'edits', reels: ['a', 'b'], n: 2, evidence: 'by hand' } });
  // the brighter version is read again and did worse in one reel: no longer a habit worth suggesting
  const file = path.join(projects, 'reel-0', 'outcomes.json');
  const good = await fs.readFile(file, 'utf8');
  const data = JSON.parse(good);
  data.versions.v2['02'].metrics.averageWatchTimeMs = 8000;
  await fs.writeFile(file, '{ damaged');
  await expect(learn(projects, style)).rejects.toThrow();
  expect((await style.proposals()).map((p) => p.from.kind)).toEqual(['results', 'edits']);
  await fs.writeFile(file, JSON.stringify(data));
  expect(await learn(projects, style)).toEqual([]);
  expect((await style.proposals()).map((p) => p.text)).toEqual(['Use bigger subtitles.']);
  // its evidence back, it may be suggested again: withdrawing is not turning down
  await fs.writeFile(file, good);
  expect(await learn(projects, style)).toHaveLength(1);
  expect(JSON.parse(await fs.readFile(path.join(root, 'My style.json'), 'utf8')).forgotten ?? []).toEqual([]);
});

it('the CLI queues suggestions without a provider and repeats without rewriting memories', async () => {
  const { projects, root, style } = await fixture();
  const cli = path.resolve(__dirname, '../dist/cli.js');
  const run = async () => JSON.parse((await promisify(execFile)(process.execPath, [cli, 'learn', '--projects-root', projects])).stdout);
  expect(await run()).toMatchObject([{ status: 'added', proposal: { kind: 'look' } }]);
  const before = await fs.readFile(path.join(root, 'My style.json'), 'utf8');
  expect(await run()).toEqual([]);
  expect(await fs.readFile(path.join(root, 'My style.json'), 'utf8')).toBe(before);
  expect(await style.list()).toEqual([]);
});

it('opposing brightness preferences cannot both become suggestions', async () => {
  const { projects } = await fixture(Array(6).fill(12000));
  for (const i of [3, 4, 5]) {
    const dir = path.join(projects, `reel-${i}`);
    await fs.writeFile(path.join(dir, 'trials.json'), JSON.stringify([{ parent_version: 1, variable: 'brightness', from: 1, to: .92 }]));
    await fs.writeFile(path.join(dir, 'versions', 'v2', 'project.json'), JSON.stringify({ exposure: .92, version: 2, cut: { keep: [] } }));
  }
  expect(await learn(projects)).toEqual([]);
});
