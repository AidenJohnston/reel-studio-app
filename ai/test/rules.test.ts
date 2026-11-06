import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { createAI, loadProject } from '../src';
import { checkFromMeasured, parseCheck, ruleText } from '../src/rules';
import { FakeHost, ScriptedModel, call, makeProject, tmpDir } from './helpers';

const finish = (s = 'Done.') => ({ toolCalls: [call('finish', { summary_for_user: s })] });
const words = (n: number) => call('set_caption_style', { maxWords: n });
const TWO_WORDS = { kind: 'captions.maxWords', value: 2 } as const;

async function setup(opts: { finalRender?: boolean } = {}) {
  const { root, dir } = await makeProject();
  const host = new FakeHost(root);
  const settingsDir = tmpDir('settings ');
  const ai = (model: ScriptedModel | null = null) => createAI({ host, settingsDir, providerOverride: model ?? undefined, finalRender: opts.finalRender ?? true });
  // the stand-in for rule_checks.py's maxWords checker
  host.ruleFails = (r, p) => (r.check.kind === 'captions.maxWords' && p.captions.style.maxWords > r.check.value ? { text: 'one two three', words: 3 } : null);
  const finals = () => host.calls.filter((c) => c.command === 'render' && !c.args.includes('--draft'));
  return { root, dir, host, ai, finals };
}

const sent = (model: ScriptedModel) => model.requests.map((r) => JSON.stringify(r.messages));
/** The task a run started with. */
const task = (model: ScriptedModel, i: number) => (model.requests[i].messages[0] as any).content[0].text as string;
const versions = (dir: string) => fs.readdirSync(path.join(dir, 'versions')).filter((d) => /^v\d+$/.test(d));

describe('the rule schema', () => {
  it('accepts and refuses the same forms as the engine (engine/tests/rule_checks.json)', () => {
    const shared = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'engine', 'tests', 'rule_checks.json'), 'utf8'));
    for (const c of shared.valid) expect(parseCheck(c)).toEqual(c);
    for (const c of shared.invalid) expect(() => parseCheck(c), JSON.stringify(c)).toThrow();
  });

  it('a new rule takes its number from the finished reel, rounded so that reel meets it', () => {
    const m = { 'captions.maxWords': 2, 'captions.maxSize': 96.4, 'captions.minSize': 81.7, 'music.underVoiceDb': 23.8, 'broll.keepOut.face': 1, 'broll.keepOut.eyes': 0 };
    expect(checkFromMeasured('captions.maxWords', m)).toEqual({ kind: 'captions.maxWords', value: 2 });
    expect(checkFromMeasured('captions.maxSize', m)).toEqual({ kind: 'captions.maxSize', value: 97 });
    expect(checkFromMeasured('captions.minSize', m)).toEqual({ kind: 'captions.minSize', value: 81 });
    expect(checkFromMeasured('music.underVoiceDb', m)).toEqual({ kind: 'music.underVoiceDb', value: 23 });
    expect(checkFromMeasured('broll.keepOut.eyes', m)).toEqual({ kind: 'broll.keepOut', zone: 'eyes' });
    // nothing this reel can promise: a picture already on the face, no subtitles, a size no rule allows
    expect(checkFromMeasured('broll.keepOut.face', m)).toBeNull();
    expect(checkFromMeasured('captions.maxWords', { ...m, 'captions.maxWords': null })).toBeNull();
    expect(checkFromMeasured('captions.minSize', { ...m, 'captions.minSize': 64 })).toBeNull();
  });
});

describe('checked rules in My style', () => {
  it('saves only the words its check says, keeps one rule per kind, and new words make it a plain rule', async () => {
    const { ai } = await setup();
    await expect(ai().addStyleRule('Keep subtitles short.', undefined, TWO_WORDS)).rejects.toThrow(/does not match/);
    await expect(ai().addStyleRule('Whatever.', undefined, { kind: 'captions.color', value: 3 } as any)).rejects.toThrow(/unknown kind/);
    await ai().addStyleRule(ruleText(TWO_WORDS), undefined, TWO_WORDS);
    const three = { kind: 'captions.maxWords', value: 3 } as const;
    await ai().addStyleRule(ruleText(three), undefined, three);
    expect(await ai().styleRules()).toEqual([expect.objectContaining({ text: 'Show at most 3 words in a subtitle.', check: three })]);
    const [rule] = await ai().styleRules();
    await ai().updateStyleRule(rule.id, { text: 'Show at most 3 words in a subtitle, except in tutorials' });
    expect((await ai().styleRules())[0].check).toBeUndefined();
  });
});

describe('a note and the checked rules', () => {
  it('a finished reel that breaks a rule stops before its encode, gets one fix, and is made once', async () => {
    const { dir, ai, finals, host } = await setup();
    await ai().addStyleRule(ruleText(TWO_WORDS), undefined, TWO_WORDS);
    const model = new ScriptedModel([{ toolCalls: [words(3)] }, finish('Three words at a time now.'), { toolCalls: [words(2)] }, finish('Back to two.')]);
    const r = await ai(model).applyNote(dir, 'put three words in each subtitle', () => undefined);
    expect(finals()).toHaveLength(2);
    expect(host.rulesFiles.filter((f) => !f.draft).map((f) => f.stopOn.length)).toEqual([1, 0]);
    expect(task(model, 2)).toContain('"Show at most 2 words in a subtitle.": 1 subtitle shows too many words');
    expect((await loadProject(dir)).captions.style.maxWords).toBe(2);
    expect(r.version).toBe(1);
    expect(versions(dir)).toEqual(['v1']);
    // the fix undid part of the note: the reply is the fix's own account of the reel, not the first summary
    expect(r.summary).toBe('Back to two.');
  });

  it("a rule the fix could not meet: the note still commits, and the reply names the rule in the app's words", async () => {
    const { dir, ai } = await setup();
    await ai().addStyleRule(ruleText(TWO_WORDS), undefined, TWO_WORDS);
    // the fix run's first finish is refused once (nothing changed), the second stands
    const r = await ai(new ScriptedModel([{ toolCalls: [words(3)] }, finish('Three words now.'), finish('Kept.'), finish('You asked for three words, so I kept them.')]))
      .applyNote(dir, 'put three words in each subtitle', () => undefined);
    expect((await loadProject(dir)).captions.style.maxWords).toBe(3);
    expect(r.version).toBe(1);
    expect(r.summary).toBe('You asked for three words, so I kept them. I couldn\'t meet your My style rule "Show at most 2 words in a subtitle": 1 subtitle shows too many words ("one two three" at 0:01). Tell me what to change, or pause the rule in My style.');
  });

  it('a rule already failing in the version the note starts from is named, never chased', async () => {
    const { dir, ai, host } = await setup();
    const rule = await ai().addStyleRule(ruleText(TWO_WORDS), undefined, TWO_WORDS);
    // Version 1 already shows three words: its render.json says so
    await ai(new ScriptedModel([{ toolCalls: [words(3)] }, finish('Three.'), finish('Kept.'), finish('Kept three.')])).applyNote(dir, 'three words', () => undefined);
    await fsp.writeFile(path.join(dir, 'versions', 'v1', 'render.json'), JSON.stringify({ ruleChecks: { failures: [{ id: rule.id }] } }));
    host.rulesFiles = [];
    const model = new ScriptedModel([{ toolCalls: [call('set_caption_style', { color: '#3366FF' })] }, finish('The subtitles are blue.')]);
    const r = await ai(model).applyNote(dir, 'make the subtitles blue', () => undefined);
    expect(model.requests).toHaveLength(2);
    expect(model.requests[0].system).toContain('Show at most 2 words in a subtitle. (this reel already broke it before this note');
    expect(host.rulesFiles.filter((f) => !f.draft).map((f) => f.stopOn)).toEqual([[]]);
    expect(r.summary).toMatch(/^The subtitles are blue\. I couldn't meet your My style rule "Show at most 2 words in a subtitle"/);
  });

  it('finish is refused once while the newest preview breaks a rule and nothing changed since', async () => {
    const { dir, ai } = await setup({ finalRender: false });
    await ai().addStyleRule(ruleText(TWO_WORDS), undefined, TWO_WORDS);
    const model = new ScriptedModel([{ toolCalls: [words(4)] }, { toolCalls: [call('render_draft', {})] }, finish(), { toolCalls: [words(2)] }, finish()]);
    await ai(model).applyNote(dir, 'four words per subtitle', () => undefined);
    expect(sent(model)[2]).toContain('myStyleRules');
    expect(sent(model)[3]).toContain("Not finished: the newest render breaks the user's My style rule");
    expect(model.requests).toHaveLength(5);
    expect((await loadProject(dir)).captions.style.maxWords).toBe(2);
  });

  it('a fast note that would break a rule goes to the AI instead', async () => {
    const { dir, ai, host } = await setup();
    const max = { kind: 'captions.maxSize', value: 105 } as const;
    await ai().addStyleRule(ruleText(max), undefined, max);
    host.ruleFails = (r, p) => (p.captions.style.size > r.check.value ? { text: 'hello', px: p.captions.style.size } : null);
    const model = new ScriptedModel([finish('I kept the subtitles at your size.')]);
    const r = await ai(model).applyNote(dir, 'bigger subtitles', () => undefined);
    expect(r.fast).toBeUndefined();
    expect(model.requests.length).toBeGreaterThan(0);
    expect((await loadProject(dir)).captions.style.size).toBe(105);
  });

  it('a stored rule this version cannot check is named in the reply, and never sent to the engine', async () => {
    const { root, dir, ai, host } = await setup();
    await fsp.writeFile(path.join(root, 'My style.json'), JSON.stringify({ version: 1, rules: [
      { id: 'n', text: 'Keep subtitles in the top third.', createdAt: '2026-11-05T00:00:00.000Z', check: { kind: 'captions.band', band: 'top' } },
    ] }));
    const r = await ai(new ScriptedModel([{ toolCalls: [words(2)] }, finish('Done.')])).applyNote(dir, 'two words per subtitle', () => undefined);
    expect(r.summary).toBe('Done. I couldn\'t check your My style rule "Keep subtitles in the top third": it needs a newer version of Reel Studio.');
    expect(host.rulesFiles.length).toBeGreaterThan(0);
    expect(host.rulesFiles.every((f) => f.rules.length === 0)).toBe(true);
    // a note that changes nothing says so too
    const idle = await ai(new ScriptedModel([finish('Nothing to change.')])).applyNote(dir, 'looks good, thanks', () => undefined);
    expect(idle.summary).toMatch(/^Nothing to change\. I couldn't check your My style rule/);
  });

  it('a first edit measures the rules too, and fixes a reel that breaks one', async () => {
    const { dir, ai, host } = await setup();
    await ai().addStyleRule(ruleText(TWO_WORDS), undefined, TWO_WORDS);
    const post = call('write_post', { caption: 'Bread takes patience', hashtags: ['a', 'b', 'c', 'd', 'e'], keywords: [] });
    const r = await ai(new ScriptedModel([{ toolCalls: [words(4), post] }, finish('First cut.'), { toolCalls: [words(2)] }, finish('Two words at a time.')]))
      .firstEdit(dir, () => undefined);
    expect(host.rulesFiles.filter((f) => !f.draft).map((f) => f.stopOn.length)).toEqual([1, 0]);
    expect((await loadProject(dir)).captions.style.maxWords).toBe(2);
    expect(r.summary).toMatch(/^Two words at a time\./);
  });
});

describe('proposing a checked rule', () => {
  it("asks with the app's words and the finished reel's number, even when the note says always", async () => {
    const { dir, ai, host } = await setup();
    host.measured = () => ({ 'captions.maxWords': null, 'captions.maxSize': null, 'captions.minSize': null, 'music.underVoiceDb': 24.6, 'broll.keepOut.face': 0, 'broll.keepOut.eyes': 0 });
    const r = await ai(new ScriptedModel([
      { toolCalls: [call('set_caption_style', { size: 100 }), call('add_style_rule', { rule: 'Music should always be super quiet.', check: 'music.underVoiceDb' })] },
      finish(),
    ])).applyNote(dir, 'always keep the music quiet', () => undefined);
    expect(r.styleChecks).toEqual([{ text: 'Keep the music at least 24 dB under my voice.', check: { kind: 'music.underVoiceDb', value: 24 } }]);
    expect(r.styleSuggestions).toEqual([]);
    expect(r.styleRulesAdded).toEqual([]);
    expect(await ai().styleRules()).toEqual([]);
  });

  it('a kind the finished reel cannot measure is asked as plain words', async () => {
    const { dir, ai } = await setup();
    const r = await ai(new ScriptedModel([
      { toolCalls: [call('set_caption_style', { enabled: false }), call('add_style_rule', { rule: 'Keep subtitles short.', check: 'captions.maxWords' })] },
      finish(),
    ])).applyNote(dir, 'no subtitles, and keep them short next time', () => undefined);
    expect(r.styleChecks).toBeUndefined();
    expect(r.styleSuggestions).toEqual(['Keep subtitles short.']);
  });
});
