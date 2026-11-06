import { afterEach, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { StyleStore, type ProposalDraft } from '../src/style';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });
async function store() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'reel-proposals-'));
  roots.push(root);
  return { root, style: new StyleStore(() => root), read: async () => JSON.parse(await fs.readFile(path.join(root, 'My style.json'), 'utf8')) };
}
const draft = (text = 'Prefer brighter exposure.'): ProposalDraft => ({
  kind: 'look', line: text, text, from: { kind: 'results', reels: ['reel'], metric: 'averageWatchTimeMs', change: .2, n: 3, evidence: '3 of 3 trials, avg watch +20%', trials: [] }
});

it('proposals are pending, bounded, and deduplicated across concurrent calls', async () => {
  const { style, read } = await store();
  expect(await Promise.all([style.propose(draft()), style.propose(draft())])).toEqual(['added', 'duplicate']);
  expect(await style.list()).toEqual([]);
  expect(await style.asPromptText()).toBe('(none yet)');
  expect(await style.propose(draft('Second.'))).toBe('added');
  expect(await style.propose(draft('Third.'))).toBe('added');
  expect(await style.propose(draft('Fourth.'))).toBe('full');
  expect((await read()).proposals).toHaveLength(3);
});

it('ordinary rule writes preserve proposals and forgotten texts', async () => {
  const { style, read } = await store();
  await style.propose(draft());
  const id = (await read()).proposals[0].id;
  await style.dismiss(id);
  await style.propose(draft('Other suggestion.'));
  const { rule } = await style.add('An unrelated preference.');
  await style.remove(rule.id);
  expect((await read()).proposals).toHaveLength(1);
  expect(await style.propose(draft('PREFER brighter exposure!'))).toBe('forgotten');
  expect(await style.propose(draft('AN UNRELATED preference!'))).toBe('forgotten');
});

it('legacy forgotten proposal ids suppress the same rule', async () => {
  const { root, style, read } = await store();
  await style.propose(draft());
  const id = (await read()).proposals[0].id;
  await fs.writeFile(path.join(root, 'My style.json'), JSON.stringify({ version: 1, rules: [], forgotten: [id] }));
  expect(await style.propose(draft())).toBe('forgotten');
});

it('malformed memory data fails without overwriting the file', async () => {
  const { root, style } = await store();
  const file = path.join(root, 'My style.json');
  await fs.writeFile(file, '{broken');
  await expect(style.propose(draft())).rejects.toThrow('memory');
  expect(await fs.readFile(file, 'utf8')).toBe('{broken');
});

it('an internal rollback does not count as the user forgetting a rule', async () => {
  const { style } = await store();
  const { rule } = await style.add(draft().text);
  await style.remove(rule.id, { forget: false });
  expect(await style.propose(draft())).toBe('added');
});

// My style's Undo (restore) brings the rule back as if it was never removed: learning may suggest its words again
it('a rule removed and then put back by Undo is not forgotten', async () => {
  const { style } = await store();
  const { rule } = await style.add(draft().text);
  const gone = await style.remove(rule.id);
  await style.restore(gone!.rule, gone!.index);
  await style.remove(rule.id, { forget: false });
  expect(await style.propose(draft())).toBe('added');
});

it('fails if keeping a suggestion leaves it waiting, drops its evidence, or ignores the words the person typed', async () => {
  const { style, read } = await store();
  const edits: ProposalDraft = { kind: 'captions', line: 'Use bigger subtitles', text: 'Use bigger subtitles.', from: { kind: 'edits', reels: ['a', 'b'], n: 2, evidence: 'You made the subtitles bigger by hand in 2 reels.' } };
  expect(await style.propose(edits)).toBe('added');
  expect(await style.propose(draft())).toBe('added');
  const [byHand, byResults] = await style.proposals();
  expect(await style.accept(byHand.id, 'use big subtitles, around 126 px')).toMatchObject({ text: 'Use big subtitles, around 126 px.', learned: { from: 'edits', evidence: 'You made the subtitles bigger by hand in 2 reels.' } });
  expect(await style.accept(byResults.id)).toMatchObject({ text: 'Prefer brighter exposure.', learned: { from: 'results', evidence: '3 of 3 trials, avg watch +20%' } });
  expect((await read()).proposals).toEqual([]);
  expect((await style.list()).map((r) => r.text)).toEqual(['Use big subtitles, around 126 px.', 'Prefer brighter exposure.']);
  // kept once: a second Keep (a double click) finds nothing to keep
  expect(await style.accept(byHand.id)).toBeNull();
  expect(await style.list()).toHaveLength(2);
});

it('fails if an edits suggestion with no evidence or reels is stored', async () => {
  const { style } = await store();
  const bad = { kind: 'captions', line: 'Bigger', text: 'Bigger.', from: { kind: 'edits', reels: 'a', n: 2, evidence: 'x' } } as unknown as ProposalDraft;
  await expect(style.propose(bad)).rejects.toThrow(/Invalid memory proposal/);
});

it('fails if a suggestion kept in other words is suggested again', async () => {
  const { style } = await store();
  const edits: ProposalDraft = { kind: 'captions', line: 'Use bigger subtitles', text: 'Use bigger subtitles.', from: { kind: 'edits', reels: ['a', 'b'], n: 2, evidence: 'By hand in 2 reels.' } };
  await style.propose(edits);
  const [p] = await style.proposals();
  await style.accept(p.id, 'Use big subtitles, about 126 px');
  // the next look drafts the same habit from the same hand edits
  expect(await style.propose(edits)).toBe('forgotten');
  // kept in its own words, it is a rule, so the same draft is a duplicate
  await style.propose(draft());
  const [q] = await style.proposals();
  await style.accept(q.id);
  expect(await style.propose(draft())).toBe('duplicate');
});
