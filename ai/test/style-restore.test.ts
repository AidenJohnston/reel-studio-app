import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { StyleStore, captionCaseProposal } from '../src/style';

describe('My style Undo', () => {
  it('fails if Undo of a remove does not bring back the same rule, in its place, with where it was learned', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'rs-style-'));
    const store = new StyleStore(() => root);
    await store.add('Always use big subtitles');
    const { rule } = await store.add('Keep music quiet', { source: { project: 'bread', title: 'Bread', version: 3, note: 'always keep music quiet' } });
    await store.add('No emojis');
    const before = await store.list();
    const gone = await store.remove(rule.id);
    expect(gone).toEqual({ rule, index: 1 });
    await store.restore(gone!.rule, gone!.index);
    expect(await store.list()).toEqual(before);
    await store.restore(gone!.rule, gone!.index);
    expect(await store.list()).toHaveLength(3);
  });

  it('fails if Undo of a removed typed rule leaves its question forgotten', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'rs-style-'));
    const store = new StyleStore(() => root);
    const p = captionCaseProposal({ project: 'bread', title: 'Bread', version: 1 });
    expect(await store.answer(p, true)).toEqual({ status: 'saved' });
    const [saved] = await store.list();
    const gone = await store.remove(saved.id);
    await store.restore(gone!.rule, gone!.index);
    // its question counts as answered for this same rule again, not as forgotten
    expect(await store.answer(p, true)).toEqual({ status: 'saved' });
    expect((await store.list()).map((r) => r.id)).toEqual([saved.id]);
  });
});
