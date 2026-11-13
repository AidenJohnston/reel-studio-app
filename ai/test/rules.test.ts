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
  // the stand-in for lint.py's maxWords checker
  host.lintRule = (r, p) => (r.check.kind === 'captions.maxWords' && p.captions.style.maxWords > r.check.value ? { text: 'one two three', words: 3 } : null);
  const renders = () => host.calls.filter((c) => c.command === 'render');
  return { root, dir, host, ai, renders };
}

/** The project saved as version `v`, with the lint report its render wrote (render.json), as a note finds it. */
async function savedAs(dir: string, v: number, lint: unknown, change: (p: any) => void = () => undefined) {
  const p = await loadProject(dir);
  change(p); p.version = v;
  await fsp.writeFile(path.join(dir, 'project.json'), JSON.stringify(p));
  await fsp.mkdir(path.join(dir, 'versions', `v${v}`), { recursive: true });
  await fsp.writeFile(path.join(dir, 'versions', `v${v}`, 'render.json'), JSON.stringify({ lint }));
}

const sent = (model: ScriptedModel) => model.requests.map((r) => JSON.stringify(r.messages));
/** The task a run started with. */
const task = (model: ScriptedModel, i: number) => (model.requests[i].messages[0] as any).content[0].text as string;

describe('the rule schema', () => {
  it('accepts and refuses the same forms as the engine (engine/tests/rule_checks.json)', () => {
    const shared = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'engine', 'tests', 'rule_checks.json'), 'utf8'));
    for (const c of shared.valid) expect(parseCheck(c)).toEqual(c);
    for (const c of shared.invalid) expect(() => parseCheck(c), JSON.stringify(c)).toThrow();
  });

  it('a new rule takes its number from the finished video, rounded so that video meets it', () => {
    const m = { 'captions.maxWords': 2, 'captions.maxSize': 96.4, 'captions.minSize': 81.7, 'music.underVoiceDb': 23.8, 'broll.keepOut.face': 1, 'broll.keepOut.eyes': 0 };
    expect(checkFromMeasured('captions.maxWords', m)).toEqual({ kind: 'captions.maxWords', value: 2 });
    expect(checkFromMeasured('captions.maxSize', m)).toEqual({ kind: 'captions.maxSize', value: 97 });
    expect(checkFromMeasured('captions.minSize', m)).toEqual({ kind: 'captions.minSize', value: 81 });
    expect(checkFromMeasured('music.underVoiceDb', m)).toEqual({ kind: 'music.underVoiceDb', value: 23 });
    expect(checkFromMeasured('broll.keepOut.eyes', m)).toEqual({ kind: 'broll.keepOut', zone: 'eyes' });
    // nothing this video can promise: a picture already on the face, no captions, a size no rule allows
    expect(checkFromMeasured('broll.keepOut.face', m)).toBeNull();
    expect(checkFromMeasured('captions.maxWords', { ...m, 'captions.maxWords': null })).toBeNull();
    expect(checkFromMeasured('captions.minSize', { ...m, 'captions.minSize': 64 })).toBeNull();
  });
});

describe('checked rules in My style', () => {
  it('saves only the words its check says, keeps one rule per kind, and a new wording makes it a plain rule', async () => {
    const { ai } = await setup();
    await expect(ai().addStyleRule('Keep captions short.', TWO_WORDS)).rejects.toThrow(/does not match/);
    await expect(ai().addStyleRule('Whatever.', { kind: 'captions.color', value: 3 } as any)).rejects.toThrow(/unknown kind/);
    await ai().addStyleRule(ruleText(TWO_WORDS), TWO_WORDS);
    const three = { kind: 'captions.maxWords', value: 3 } as const;
    await ai().addStyleRule(ruleText(three), three);
    expect(await ai().styleRules()).toEqual([expect.objectContaining({ text: 'Show at most 3 words in a caption.', check: three })]);
    const [rule] = await ai().styleRules();
    await ai().updateStyleRule(rule.id, { text: 'Show at most 3 words in a caption, except in tutorials' });
    expect((await ai().styleRules())[0].check).toBeUndefined();
  });
});

describe('a note and the checked rules', () => {
  it('a finished video that breaks a rule stops before its encode, gets one fix, and is made once', async () => {
    const { dir, ai, renders, host } = await setup();
    await ai().addStyleRule(ruleText(TWO_WORDS), TWO_WORDS);
    const model = new ScriptedModel([{ toolCalls: [words(3)] }, finish('Three words at a time now.'), { toolCalls: [words(2)] }, finish('Back to two.')]);
    const r = await ai(model).applyNote(dir, 'put three words in each caption', () => undefined);
    const finals = renders().filter((c) => !c.args.includes('--draft'));
    expect(finals).toHaveLength(2);
    expect(host.rulesFiles.map((f) => f.stopOn.length)).toEqual([1, 0]);
    expect(task(model, 2)).toContain('"Show at most 2 words in a caption.": 1 caption shows too many words');
    expect((await loadProject(dir)).captions.style.maxWords).toBe(2);
    expect(r.version).toBe(1);
    expect(fs.readdirSync(path.join(dir, 'versions'))).toEqual(['v1']);
    // the fix undid part of the note: the reply is the fix's own account of the video, not the first summary
    expect(r.summary).toBe('Back to two.');
  });

  it('a rule the fix could not meet: the note still commits, and the reply names the rule in the app\'s words', async () => {
    const { dir, ai } = await setup();
    await ai().addStyleRule(ruleText(TWO_WORDS), TWO_WORDS);
    // the fix run's first finish is refused once (nothing changed), the second stands
    const r = await ai(new ScriptedModel([{ toolCalls: [words(3)] }, finish('Three words now.'), finish('Kept.'), finish('You asked for three words, so I kept them.')]))
      .applyNote(dir, 'put three words in each caption', () => undefined);
    expect((await loadProject(dir)).captions.style.maxWords).toBe(3);
    expect(r.summary).toBe('You asked for three words, so I kept them. I couldn\'t meet your My style rule "Show at most 2 words in a caption": 1 caption shows too many words ("one two three" at 0:01). Tell me what to change, or pause the rule in My style.');
  });

  it('a rule already failing in the version the note starts from is named, never chased', async () => {
    const { dir, ai, host } = await setup();
    const rule = await ai().addStyleRule(ruleText(TWO_WORDS), TWO_WORDS);
    const p = await loadProject(dir);
    p.captions.style.maxWords = 3; p.version = 4;
    await fsp.writeFile(path.join(dir, 'project.json'), JSON.stringify(p));
    await fsp.mkdir(path.join(dir, 'versions', 'v4'), { recursive: true });
    await fsp.writeFile(path.join(dir, 'versions', 'v4', 'render.json'), JSON.stringify({ lint: { failures: [{ id: rule.id }] } }));
    const model = new ScriptedModel([{ toolCalls: [call('set_caption_style', { color: '#3366FF' })] }, finish('The captions are blue.')]);
    const r = await ai(model).applyNote(dir, 'make the captions blue', () => undefined);
    expect(model.requests).toHaveLength(2);
    expect(model.requests[0].system).toContain('Show at most 2 words in a caption. (this video already broke it before this note');
    expect(host.rulesFiles.at(-1).stopOn).toEqual([]);
    expect(r.summary).toMatch(/^The captions are blue\. I couldn't meet your My style rule "Show at most 2 words in a caption"/);
  });

  it('a rule the starting version was never measured against is left alone; one it was measured against still holds', async () => {
    const { dir, ai, host } = await setup();
    const size = { kind: 'captions.maxSize', value: 110 } as const;
    const sizeRule = await ai().addStyleRule(ruleText(size), size);
    // v4 was rendered with only the size rule; the words rule was saved after it, and v4 already breaks it
    await savedAs(dir, 4, { ok: true, checked: 1, checkedIds: [sizeRule.id], failures: [], measured: {} });
    await ai().addStyleRule(ruleText(TWO_WORDS), TWO_WORDS);
    host.lintRule = (r, p) => r.check.kind === 'captions.maxWords' ? (p.captions.style.maxWords > r.check.value ? { text: 'one two three', words: 3 } : null)
      : p.captions.style.size > r.check.value ? { text: 'hello', px: p.captions.style.size } : null;
    const model = new ScriptedModel([
      { toolCalls: [call('set_caption_style', { color: '#3366FF', size: 130 })] }, finish('Blue and bigger.'),
      { toolCalls: [call('set_caption_style', { size: 110 })] }, finish('Blue, at your size.'),
    ]);
    await ai(model).applyNote(dir, 'make the captions blue and bigger', () => undefined);
    expect(model.requests[0].system).toContain('Show at most 2 words in a caption. (this video was made before the app checked it');
    expect(host.rulesFiles[0].stopOn).toEqual([sizeRule.id]);
    // the fix is about the size the note broke, never the words it didn't touch
    expect(task(model, 2)).toContain('"Keep captions at most 110 px tall."');
    expect(task(model, 2)).not.toContain('Show at most 2 words');
    expect((await loadProject(dir)).captions.style).toMatchObject({ maxWords: 3, size: 110 });
  });

  it('a note that changes nothing still names the rules the saved video breaks', async () => {
    const { dir, ai } = await setup();
    const rule = await ai().addStyleRule(ruleText(TWO_WORDS), TWO_WORDS);
    await savedAs(dir, 4, { ok: false, checked: 1, checkedIds: [rule.id], measured: {},
      failures: [{ id: rule.id, kind: 'captions.maxWords', count: 1, places: [{ t0: 1, t1: 2, text: 'one two three', words: 3 }] }] });
    const r = await ai(new ScriptedModel([finish('Nothing to change.')])).applyNote(dir, 'looks good, thanks', () => undefined);
    expect(r.summary).toBe('Nothing to change. I couldn\'t meet your My style rule "Show at most 2 words in a caption": 1 caption shows too many words ("one two three" at 0:01). Tell me what to change, or pause the rule in My style.');
  });

  it('finish is refused once while the newest preview breaks a rule and nothing changed since', async () => {
    const { dir, ai } = await setup({ finalRender: false });
    await ai().addStyleRule(ruleText(TWO_WORDS), TWO_WORDS);
    const model = new ScriptedModel([{ toolCalls: [words(4)] }, { toolCalls: [call('render_draft')] }, finish(), { toolCalls: [words(2)] }, finish()]);
    await ai(model).applyNote(dir, 'four words per caption', () => undefined);
    expect(sent(model)[2]).toContain('myStyleRules');
    expect(sent(model)[3]).toContain("Not finished: the newest render breaks the user's My style rule");
    expect(model.requests).toHaveLength(5);
    expect((await loadProject(dir)).captions.style.maxWords).toBe(2);
  });

  it('a fast note that would break a rule goes to the AI instead', async () => {
    const { dir, ai, host } = await setup();
    const max = { kind: 'captions.maxSize', value: 105 } as const;
    await ai().addStyleRule(ruleText(max), max);
    host.lintRule = (r, p) => (p.captions.style.size > r.check.value ? { text: 'hello', px: p.captions.style.size } : null);
    const model = new ScriptedModel([finish('I kept the captions at your size.')]);
    const r = await ai(model).applyNote(dir, 'bigger captions', () => undefined);
    expect(r.fast).toBeUndefined();
    expect(model.requests.length).toBeGreaterThan(0);
    expect((await loadProject(dir)).captions.style.size).toBe(105);
  });

  it('a stored rule this version cannot check is named in the reply, and never sent to the engine', async () => {
    const { root, dir, ai, host } = await setup();
    await fsp.writeFile(path.join(root, 'My style.json'), JSON.stringify({ version: 1, rules: [
      { id: 'n', text: 'Keep captions in the top third.', createdAt: '2026-11-05T00:00:00.000Z', check: { kind: 'captions.band', band: 'top' } },
    ] }));
    const r = await ai(new ScriptedModel([{ toolCalls: [words(2)] }, finish('Done.')])).applyNote(dir, 'two words per caption', () => undefined);
    expect(r.summary).toBe('Done. I couldn\'t check your My style rule "Keep captions in the top third": it needs a newer version of Reel Studio.');
    expect(host.rulesFiles.every((f) => f.rules.length === 0)).toBe(true);
    // a note that changes nothing says so too
    const idle = await ai(new ScriptedModel([finish('Nothing to change.')])).applyNote(dir, 'looks good, thanks', () => undefined);
    expect(idle.summary).toMatch(/^Nothing to change\. I couldn't check your My style rule/);
  });
});

describe('proposing a checked rule', () => {
  it('asks with the app\'s words and the finished video\'s number, even when the note says always', async () => {
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

  it('a kind the finished video cannot measure is asked as plain words', async () => {
    const { dir, ai } = await setup();
    const r = await ai(new ScriptedModel([
      { toolCalls: [call('set_caption_style', { enabled: false }), call('add_style_rule', { rule: 'Keep captions short.', check: 'captions.maxWords' })] },
      finish(),
    ])).applyNote(dir, 'no captions, and keep them short next time', () => undefined);
    expect(r.styleChecks).toBeUndefined();
    expect(r.styleSuggestions).toEqual(['Keep captions short.']);
  });
});
