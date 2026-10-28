import { describe, it, expect } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { StyleStore, createAI, executeTool, newToolState } from '../src';
import { FakeHost, ScriptedModel, call, makeProject, tmpDir } from './helpers';

describe('a damaged My style.json', () => {
  it('is kept as a numbered copy next to a fresh My style, which saves again', async () => {
    const root = tmpDir('style ');
    const ai = createAI({ host: new FakeHost(root), settingsDir: tmpDir('settings ') });
    const file = path.join(root, 'My style.json');
    const first = '{"version":1,"rules":[{"id":"a","text":"Keep music quieter under talk';
    await fsp.writeFile(file, first);

    expect(await ai.styleRules()).toEqual([]);
    expect(await fsp.readFile(path.join(root, 'My style.damaged.json'), 'utf8')).toBe(first);
    expect(await ai.styleWasDamaged()).toBe(true);
    await ai.addStyleRule('Keep music quieter under talking.');
    expect((await ai.styleRules()).map((r) => r.text)).toEqual(['Keep music quieter under talking.']);
    expect(await ai.styleWasDamaged()).toBe(true);

    // damaged again: the first copy stays as it was, and the second takes the next number
    const second = '{"rules":"not a list"}';
    await fsp.writeFile(file, second);
    expect(await ai.addStyleRule('Use big captions.')).toMatchObject({ text: 'Use big captions.' });
    expect(await fsp.readFile(path.join(root, 'My style.damaged.json'), 'utf8')).toBe(first);
    expect(await fsp.readFile(path.join(root, 'My style.damaged 2.json'), 'utf8')).toBe(second);

    // My style says the old file is kept next to it, so once that copy is gone it stops saying so
    await fsp.rm(path.join(root, 'My style.damaged 2.json'));
    expect(await ai.styleWasDamaged()).toBe(false);
  });
});

describe('editing and pausing a rule in My style', () => {
  it('the AI reads the new words, and a paused rule is left out until it is turned back on', async () => {
    const { root, dir } = await makeProject();
    const settingsDir = tmpDir('settings ');
    /** What the AI is told about My style on the next note. */
    const readByAI = async () => {
      const model = new ScriptedModel([{ toolCalls: [call('finish', { summary_for_user: 'Done.' })] }]);
      await createAI({ host: new FakeHost(root), settingsDir, providerOverride: model, finalRender: false }).applyNote(dir, 'x', () => undefined);
      return model.requests[0].system;
    };
    const ai = createAI({ host: new FakeHost(root), settingsDir });
    const rule = await ai.addStyleRule('Put a yellow box behind the captions.');

    await ai.updateStyleRule(rule.id, { text: 'put a big yellow box behind the captions' });
    expect((await ai.styleRules())[0]).toMatchObject({ id: rule.id, text: 'Put a big yellow box behind the captions.' });
    expect(await readByAI()).toContain('- Put a big yellow box behind the captions.');

    await ai.updateStyleRule(rule.id, { paused: true });
    expect((await ai.styleRules())[0]).toMatchObject({ id: rule.id, paused: true });
    expect(await readByAI()).not.toContain('yellow box');

    await ai.updateStyleRule(rule.id, { paused: false });
    expect(await readByAI()).toContain('- Put a big yellow box behind the captions.');
  });

  it('a missing rule gives the person a plain reason, not a code error', async () => {
    const ai = createAI({ host: new FakeHost(tmpDir('style ')), settingsDir: tmpDir('settings ') });
    await expect(ai.updateStyleRule('gone', { paused: true })).rejects.toEqual({ code: 'NOT_FOUND', userMessage: 'That rule is not in My style any more.' });
  });
});

describe('asking again for a rule paused in My style turns it back on', () => {
  it('when the words are saved again, as Yes to a suggestion does', async () => {
    const root = tmpDir('style ');
    const ai = createAI({ host: new FakeHost(root), settingsDir: tmpDir('settings ') });
    const rule = await ai.addStyleRule('Put a yellow box behind the captions.');
    await ai.updateStyleRule(rule.id, { paused: true });

    expect(await ai.addStyleRule('put a yellow box behind the captions')).toMatchObject({ id: rule.id });
    expect((await ai.styleRules())[0].paused).toBeUndefined();
    expect(await new StyleStore(() => root).asPromptText()).toBe('- Put a yellow box behind the captions.');
  });

  it('when the AI proposes it for a note that says "always"', async () => {
    const { root, dir } = await makeProject();
    const style = new StyleStore(() => root);
    const rule = (await style.add('Put a yellow box behind the captions.')).rule;
    await style.update(rule.id, { paused: true });
    const ctx = { projectDir: dir, host: new FakeHost(root), style, emit: () => undefined, state: newToolState(), supportsImages: true, userNote: 'always put a yellow box behind the captions' };

    expect((await executeTool(ctx, 'add_style_rule', { rule: 'Put a yellow box behind the captions.' })).isError).toBe(false);
    expect((await style.list())[0].paused).toBeUndefined();
    expect(await style.asPromptText()).toBe('- Put a yellow box behind the captions.');
    // the rule was there before this note, so undoing the note must not delete it
    expect(ctx.state.styleRuleIds).toEqual([]);
  });
});
