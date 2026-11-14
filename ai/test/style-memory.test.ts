import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { StyleStore, captionCaseProposal } from '../src/style';
import { executeTool, newToolState, type ToolContext } from '../src';
import { FakeHost, makeProject } from './helpers';

const store = () => {
  const root = mkdtempSync(path.join(tmpdir(), 'rs-style-'));
  return new StyleStore(() => root);
};

describe('My style as short points', () => {
  it('fails if new words on a rule are not dated, or a pause dates it', async () => {
    const s = store();
    const { rule } = await s.add('Keep music quiet');
    expect(rule.updatedAt).toBeUndefined();
    const edited = await s.update(rule.id, { text: 'Keep music quieter' });
    expect(Date.parse(edited.updatedAt!)).toBeGreaterThanOrEqual(Date.parse(rule.createdAt));
    const paused = await s.update(rule.id, { paused: true });
    expect(paused.updatedAt).toBe(edited.updatedAt);
    expect((await s.list())[0].updatedAt).toBe(edited.updatedAt);
  });

  it('fails if a rule typed in by the person is not marked as theirs', async () => {
    const s = store();
    expect((await s.add('Big subtitles', { byYou: true })).rule.byYou).toBe(true);
    expect((await s.add('No emojis')).rule.byYou).toBeUndefined();
  });

  it('fails if a paused rule still reaches the editor or new reels', async () => {
    const s = store();
    expect(await s.answer(captionCaseProposal({ project: 'bread', title: 'Bread', version: 1 }), true)).toEqual({ status: 'saved' });
    const typed = (await s.list()).find((r) => r.payload)!;
    const { rule } = await s.add('Keep music quiet');
    await s.update(typed.id, { paused: true });
    await s.update(rule.id, { paused: true });
    expect(await s.asPromptText()).toBe('(none yet)');
    expect(await s.captionCase()).toBeNull();
  });
});

// PR #83's pause rule: asking for a paused rule again turns it back on, or the app says "Saved" for a rule it skips.
describe('asking again for a paused rule', () => {
  it('fails if saving the same words leaves the rule paused or adds a copy', async () => {
    const s = store();
    const { rule } = await s.add('Keep music quieter under talking.');
    await s.update(rule.id, { paused: true });
    const again = await s.add('keep music quieter under talking');
    expect(again).toMatchObject({ added: false, rule: { id: rule.id } });
    expect(await s.list()).toHaveLength(1);
    expect(await s.asPromptText()).toBe('- Keep music quieter under talking.');
  });

  it('fails if an "always" note for a paused rule is answered as already saved instead of asked again', async () => {
    const { root, dir } = await makeProject();
    const style = new StyleStore(() => root);
    const { rule } = await style.add('Keep music quieter under talking.');
    await style.update(rule.id, { paused: true });
    const ctx: ToolContext = {
      projectDir: dir, host: new FakeHost(root), style, emit: () => undefined, state: newToolState(), supportsImages: true,
      userNote: 'always keep the music quieter under talking', note: { id: 'n1', file: path.join(dir, 'note.json'), dir },
    };
    const r = await executeTool(ctx, 'add_style_rule', { rule: 'Keep music quieter under talking.' });
    expect(r.content).not.toMatch(/alreadySaved/);
    // asked as a suggestion, never listed as saved: the app takes a saved rule out of My style until the person says
    // Yes (app test style-consent-handoff). A Yes then leaves it paused: only My style turns it back on (StyleStore.answer)
    expect(ctx.state.styleSuggestions).toEqual(['Keep music quieter under talking.']);
    expect(ctx.state.styleRulesAdded).toEqual([]);
    expect(ctx.state.styleChanges).toEqual([]);
  });

  it('fails if a note that does not ask to remember brings a paused rule back', async () => {
    const { root, dir } = await makeProject();
    const style = new StyleStore(() => root);
    const { rule } = await style.add('Keep music quieter under talking.');
    await style.update(rule.id, { paused: true });
    const ctx: ToolContext = { projectDir: dir, host: new FakeHost(root), style, emit: () => undefined, state: newToolState(), supportsImages: true, userNote: 'music too loud here' };
    expect((await executeTool(ctx, 'add_style_rule', { rule: 'Keep music quieter under talking.' })).content).toMatch(/alreadySaved/);
    expect((await style.list())[0].paused).toBe(true);
  });
});
