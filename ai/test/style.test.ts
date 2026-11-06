import { describe, it, expect } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { AIError, StyleStore, createAI, executeTool, newToolState } from '../src';
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

  it('add() says it turned the rule back on only on the call that did, so a note undoes only its own change', async () => {
    const root = tmpDir('style ');
    const style = new StyleStore(() => root);
    const rule = (await style.add('Put a yellow box behind the captions.')).rule;
    await style.update(rule.id, { paused: true });
    expect(await style.add('put a yellow box behind the captions')).toMatchObject({ added: false, resumed: true, rule: { id: rule.id } });
    // turned on by someone else since: this call changed nothing
    expect(await style.add('put a yellow box behind the captions')).toMatchObject({ added: false, resumed: false });
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

  it('and a note that turned it back on, then failed, leaves it paused', async () => {
    const { root, dir } = await makeProject();
    const style = new StyleStore(() => root);
    const rule = (await style.add('Put a yellow box behind the captions.')).rule;
    await style.update(rule.id, { paused: true });
    const m = new ScriptedModel([
      { toolCalls: [call('add_style_rule', { rule: 'Put a yellow box behind the captions.' }), call('set_gap_cap', { seconds: 0.4 })] },
      new AIError('chatgpt_usage_limit', 'limit'),
    ]);
    const ai = createAI({ host: new FakeHost(root), settingsDir: tmpDir('settings '), providerOverride: m });

    await expect(ai.applyNote(dir, 'always put a yellow box behind the captions', () => undefined)).rejects.toMatchObject({ code: 'chatgpt_usage_limit' });
    expect(await style.list()).toEqual([expect.objectContaining({ id: rule.id, paused: true })]);
    expect(await style.asPromptText()).toBe('(none yet)');
  });

  it('and when My style cannot be put back after the note fails, the error says which rule to check', async () => {
    const { root, dir } = await makeProject();
    const style = new StyleStore(() => root);
    const rule = (await style.add('Put a yellow box behind the captions.')).rule;
    await style.update(rule.id, { paused: true });
    const m = new ScriptedModel([
      { toolCalls: [call('add_style_rule', { rule: 'Put a yellow box behind the captions.' }), call('set_gap_cap', { seconds: 0.4 })] },
      async () => {
        // a folder where My style.json goes: pausing the rule again fails the same way on every OS
        await fsp.rm(style.file);
        await fsp.mkdir(style.file);
        throw new AIError('chatgpt_usage_limit', 'You reached your ChatGPT limit.');
      },
    ]);
    const ai = createAI({ host: new FakeHost(root), settingsDir: tmpDir('settings '), providerOverride: m });

    await expect(ai.applyNote(dir, 'always put a yellow box behind the captions', () => undefined)).rejects.toMatchObject({
      code: 'chatgpt_usage_limit',
      userMessage: 'You reached your ChatGPT limit. I also couldn\'t undo its change to "Put a yellow box behind the captions." in My style, so please check it there.',
    });
  });

  it('and when the person presses Stop and My style cannot be put back, the stop still says which rule to check', async () => {
    const { root, dir } = await makeProject();
    const style = new StyleStore(() => root);
    const rule = (await style.add('Put a yellow box behind the captions.')).rule;
    await style.update(rule.id, { paused: true });
    const stop = new AbortController();
    const m = new ScriptedModel([
      { toolCalls: [call('add_style_rule', { rule: 'Put a yellow box behind the captions.' }), call('set_gap_cap', { seconds: 0.4 })] },
      async () => {
        await fsp.rm(style.file);
        await fsp.mkdir(style.file);
        stop.abort();
        return { toolCalls: [call('set_gap_cap', { seconds: 0.5 })] };
      },
    ]);
    const ai = createAI({ host: new FakeHost(root), settingsDir: tmpDir('settings '), providerOverride: m });

    // the app shows no error for Stop (app/src/main/jobs.ts), so this sentence is the only word the person gets
    const stopped = { code: 'cancelled', tellAfterStop: 'I stopped that note, but I couldn\'t undo its change to "Put a yellow box behind the captions." in My style, so please check it there.' };
    const err = await ai.applyNote(dir, 'always put a yellow box behind the captions', () => undefined, stop.signal).then(() => null, (e) => e);
    expect(err).toMatchObject(stopped);
    // and it survives being passed on as JSON (toJSON), as AI errors are
    expect(JSON.parse(JSON.stringify(err))).toMatchObject(stopped);
  });
});
