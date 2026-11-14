import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { createAI, loadProject } from '../src';
import { DEFAULT_CHECKS, RuleCheck, checkFromMeasured, failureText, isDefaultRule, parseCheck, ruleText, withDefaults } from '../src/rules';
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

/** The project saved as version `v`, with the rule report its render wrote (render.json), as a note finds it. */
async function savedAs(dir: string, v: number, ruleChecks: unknown, change: (p: any) => void = () => undefined) {
  const p = await loadProject(dir);
  change(p); p.version = v;
  await fsp.writeFile(path.join(dir, 'project.json'), JSON.stringify(p));
  await fsp.mkdir(path.join(dir, 'versions', `v${v}`), { recursive: true });
  await fsp.writeFile(path.join(dir, 'versions', `v${v}`, 'render.json'), JSON.stringify({ ruleChecks }));
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
    // the project starts at 3 words a subtitle: 4 is a change, and breaks the rule
    const model = new ScriptedModel([{ toolCalls: [words(4)] }, finish('Four words at a time now.'), { toolCalls: [words(2)] }, finish('Back to two.')]);
    const r = await ai(model).applyNote(dir, 'put four words in each subtitle', () => undefined);
    expect(finals()).toHaveLength(2);
    expect(host.rulesFiles.filter((f) => !f.draft).map((f) => f.stopOn.filter((id: string) => !isDefaultRule(id)).length)).toEqual([1, 0]);
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
    const r = await ai(new ScriptedModel([{ toolCalls: [words(4)] }, finish('Four words now.'), finish('Kept.'), finish('You asked for four words, so I kept them.')]))
      .applyNote(dir, 'put four words in each subtitle', () => undefined);
    expect((await loadProject(dir)).captions.style.maxWords).toBe(4);
    expect(r.version).toBe(1);
    expect(r.summary).toBe('You asked for four words, so I kept them. I couldn\'t meet your My style rule "Show at most 2 words in a subtitle": 1 subtitle shows too many words ("one two three" at 0:01). Tell me what to change, or pause the rule in My style.');
  });

  it('a rule already failing in the version the note starts from is named, never chased', async () => {
    const { dir, ai, host } = await setup();
    const rule = await ai().addStyleRule(ruleText(TWO_WORDS), undefined, TWO_WORDS);
    // Version 1 already shows four words: its render.json says so
    await ai(new ScriptedModel([{ toolCalls: [words(4)] }, finish('Four.'), finish('Kept.'), finish('Kept four.')])).applyNote(dir, 'four words', () => undefined);
    await fsp.writeFile(path.join(dir, 'versions', 'v1', 'render.json'), JSON.stringify({ ruleChecks: { failures: [{ id: rule.id }] } }));
    host.rulesFiles = [];
    const model = new ScriptedModel([{ toolCalls: [call('set_caption_style', { color: '#3366FF' })] }, finish('The subtitles are blue.')]);
    const r = await ai(model).applyNote(dir, 'make the subtitles blue', () => undefined);
    expect(model.requests).toHaveLength(2);
    expect(model.requests[0].system).toContain('Show at most 2 words in a subtitle. (this reel already broke it before this note');
    expect(host.rulesFiles.filter((f) => !f.draft).map((f) => f.stopOn)).toEqual([[]]);
    expect(r.summary).toMatch(/^The subtitles are blue\. I couldn't meet your My style rule "Show at most 2 words in a subtitle"/);
  });

  it('a rule the starting version was never measured against is left alone; one it was measured against still holds', async () => {
    const { dir, ai, host } = await setup();
    const size = { kind: 'captions.maxSize', value: 110 } as const;
    const sizeRule = await ai().addStyleRule(ruleText(size), undefined, size);
    // v4 was rendered with only the size rule; the words rule was saved after it, and v4 already breaks it
    await savedAs(dir, 4, { ok: true, checked: 1, checkedIds: [sizeRule.id], failures: [], measured: {} });
    await ai().addStyleRule(ruleText(TWO_WORDS), undefined, TWO_WORDS);
    host.ruleFails = (r, p) => r.check.kind === 'captions.maxWords' ? (p.captions.style.maxWords > r.check.value ? { text: 'one two three', words: 3 } : null)
      : r.check.kind === 'captions.maxSize' && p.captions.style.size > r.check.value ? { text: 'hello', px: p.captions.style.size } : null;
    const model = new ScriptedModel([
      { toolCalls: [call('set_caption_style', { color: '#3366FF', size: 130 })] }, finish('Blue and bigger.'),
      { toolCalls: [call('set_caption_style', { size: 110 })] }, finish('Blue, at your size.'),
    ]);
    await ai(model).applyNote(dir, 'make the captions blue and bigger', () => undefined);
    expect(model.requests[0].system).toContain('Show at most 2 words in a subtitle. (this reel was made before the app checked it');
    expect(host.rulesFiles.filter((f) => !f.draft)[0].stopOn).toEqual([sizeRule.id]);
    // the fix is about the size the note broke, never the words it didn't touch
    expect(task(model, 2)).toContain('"Keep subtitles at most 110 px tall."');
    expect(task(model, 2)).not.toContain('Show at most 2 words');
    expect((await loadProject(dir)).captions.style).toMatchObject({ maxWords: 3, size: 110 });
  });

  it('a note that changes nothing still names the rules the saved video breaks', async () => {
    const { dir, ai } = await setup();
    const rule = await ai().addStyleRule(ruleText(TWO_WORDS), undefined, TWO_WORDS);
    await savedAs(dir, 4, { ok: false, checked: 1, checkedIds: [rule.id], measured: {},
      failures: [{ id: rule.id, kind: 'captions.maxWords', count: 1, places: [{ t0: 1, t1: 2, text: 'one two three', words: 3 }] }] });
    const r = await ai(new ScriptedModel([finish('Nothing to change.')])).applyNote(dir, 'looks good, thanks', () => undefined);
    expect(r.summary).toBe('Nothing to change. (Your video didn\'t change, so there\'s no new version.) I couldn\'t meet your My style rule "Show at most 2 words in a subtitle": 1 subtitle shows too many words ("one two three" at 0:01). Tell me what to change, or pause the rule in My style.');
  });

  it('finish is refused once while the newest preview breaks a rule and nothing changed since', async () => {
    const { dir, ai } = await setup({ finalRender: false });
    await ai().addStyleRule(ruleText(TWO_WORDS), undefined, TWO_WORDS);
    const model = new ScriptedModel([{ toolCalls: [words(4)] }, { toolCalls: [call('render_draft', {})] }, finish(), { toolCalls: [words(2)] }, finish()]);
    await ai(model).applyNote(dir, 'four words per subtitle', () => undefined);
    expect(sent(model)[2]).toContain('myStyleRules');
    expect(sent(model)[3]).toContain('Not finished: the newest render breaks this rule');
    expect(model.requests).toHaveLength(5);
    expect((await loadProject(dir)).captions.style.maxWords).toBe(2);
  });

  it('a fast note that would break a rule goes to the AI instead', async () => {
    const { dir, ai, host } = await setup();
    const max = { kind: 'captions.maxSize', value: 105 } as const;
    await ai().addStyleRule(ruleText(max), undefined, max);
    host.ruleFails = (r, p) => (r.check.kind === 'captions.maxSize' && p.captions.style.size > r.check.value ? { text: 'hello', px: p.captions.style.size } : null);
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
    expect(host.rulesFiles.every((f) => f.rules.every((r: { id: string }) => isDefaultRule(r.id)))).toBe(true);
    // a note that changes nothing says so too
    const idle = await ai(new ScriptedModel([finish('Nothing to change.')])).applyNote(dir, 'looks good, thanks', () => undefined);
    expect(idle.summary).toMatch(/^Nothing to change\. \(Your video didn't change, so there's no new version\.\) I couldn't check your My style rule/);
  });

  it('a first edit measures the rules too, and fixes a reel that breaks one', async () => {
    const { dir, ai, host } = await setup();
    await ai().addStyleRule(ruleText(TWO_WORDS), undefined, TWO_WORDS);
    const post = call('write_post', { caption: 'Bread takes patience', hashtags: ['a', 'b', 'c', 'd', 'e'], keywords: [] });
    const r = await ai(new ScriptedModel([{ toolCalls: [words(4), post] }, finish('First cut.'), { toolCalls: [words(2)] }, finish('Two words at a time.')]))
      .firstEdit(dir, () => undefined);
    // a new video also stops on Reel Studio's defaults (it has nothing to keep): count the person's rule
    expect(host.rulesFiles.filter((f) => !f.draft).map((f) => f.stopOn.filter((id: string) => !isDefaultRule(id)).length)).toEqual([1, 0]);
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

describe("Reel Studio's default taste", () => {
  const SAME_SIZE = 'Reel Studio default: Show every subtitle at the same size.';
  /** The stand-in for rule_checks.py's uniformSize checker: captions over 120 px get shrunk to fit. */
  const shrinksBigCaptions = (r: { check: any }, p: any) =>
    r.check.kind === 'captions.uniformSize' && p.captions.style.size > 120 ? { text: 'extraordinarily', px: 98 } : null;

  it('adds every default the person has not set themselves, in words that say it is a default', () => {
    const all = withDefaults([]);
    expect(all.map((r) => r.check)).toEqual(DEFAULT_CHECKS);
    expect(all.every((r) => isDefaultRule(r.id) && r.text.startsWith('Reel Studio default: '))).toBe(true);
    const mine = { id: 'mine', text: ruleText(TWO_WORDS), check: TWO_WORDS };
    const withMine = withDefaults([mine]);
    expect(withMine[0]).toBe(mine);
    expect(withMine.filter((r) => r.check.kind === 'captions.maxWords')).toEqual([mine]);
    expect(withMine).toHaveLength(DEFAULT_CHECKS.length);
  });

  it('describes every default and where it fails, with the engine\'s places', () => {
    const place = { t0: 61, t1: 63.5, text: 'one two three', px: 88, lines: 2, item: 'b2', seconds: 1.2, asset: 'Library/images/a.png', zooms: 7, allowed: 4 };
    for (const c of DEFAULT_CHECKS) {
      expect(parseCheck(c)).toEqual(c);
      expect(ruleText(c)).toMatch(/^[A-Z].*\.$/);
      const why = failureText({ id: 'x', kind: c.kind, count: 1, places: [place] }, c);
      expect(why, c.kind).not.toMatch(/undefined|NaN/);
    }
    const why = (c: RuleCheck) => failureText({ id: 'x', kind: c.kind, count: 1, places: [place] }, c);
    expect(why({ kind: 'broll.cardHold', value: 2 })).toBe('1 card leaves too soon to read (b2, 1.2 s at 1:01)');
    expect(why({ kind: 'face.maxBare', value: 4 })).toBe('1 stretch shows only the face too long (1.2 s from 1:01)');
    expect(why({ kind: 'zooms.maxPerMinute', value: 6 })).toBe('the reel has 7 zooms; its length allows 4');
    expect(ruleText({ kind: 'broll.clipLength', min: 0.5, max: 1.5 })).toBe('Keep each video clip on screen 0.5 to 1.5 seconds.');
  });

  it('every AI edit sends the defaults with its renders, and a My style rule of the same kind replaces one', async () => {
    const { dir, ai, host } = await setup();
    const mine = await ai().addStyleRule(ruleText(TWO_WORDS), undefined, TWO_WORDS);
    await ai(new ScriptedModel([{ toolCalls: [words(2)] }, finish()])).applyNote(dir, 'two words per subtitle', () => undefined);
    const ids = host.rulesFiles[0].rules.map((r: { id: string }) => r.id);
    expect(ids).toEqual([mine.id, ...DEFAULT_CHECKS.filter((c) => c.kind !== 'captions.maxWords').map((c) => `default:${c.kind}`)]);
    // a new video meets them all: the final render stops on every one
    expect(host.rulesFiles[0].stopOn).toEqual(ids);
  });

  // cut-style.ts: clean holds the face 6 to 10 s, hyper fills the opening and zooms more
  it.each(['clean', 'hyper'])('an edit in the %s cut style is not measured against the pace defaults, only the others', async (preset) => {
    const { dir, ai, host } = await setup();
    const p = JSON.parse(await fsp.readFile(path.join(dir, 'project.json'), 'utf8'));
    await fsp.writeFile(path.join(dir, 'project.json'), JSON.stringify({ ...p, cutStyle: { preset, seed: 1 } }));
    await ai(new ScriptedModel([{ toolCalls: [words(2)] }, finish()])).applyNote(dir, 'two words per subtitle', () => undefined);
    const kinds = host.rulesFiles[0].rules.map((r: { check: RuleCheck }) => r.check.kind);
    expect(kinds).toEqual(DEFAULT_CHECKS.map((c) => c.kind).filter((k) => !['opening.calm', 'face.maxBare', 'zooms.maxPerMinute'].includes(k)));
  });

  it('a preview that breaks a default is fixed before finish', async () => {
    const { dir, ai, host } = await setup({ finalRender: false });
    host.ruleFails = shrinksBigCaptions;
    const model = new ScriptedModel([
      { toolCalls: [call('set_caption_style', { size: 140 })] }, { toolCalls: [call('render_draft')] }, finish(),
      // bigger than at the start, and small enough that no subtitle is shrunk: the note still changed the video
      { toolCalls: [call('set_caption_style', { size: 115 })] }, finish('Bigger, and every caption the same size.'),
    ]);
    const r = await ai(model).applyNote(dir, 'captions a bit bigger', () => undefined);
    expect(sent(model)[2]).toContain(SAME_SIZE);
    expect(sent(model)[3]).toContain('Not finished: the newest render breaks this rule');
    expect((await loadProject(dir)).captions.style.size).toBe(115);
    expect(r.summary).toBe('Bigger, and every caption the same size.');
  });

  it('a default the note asks against gives way, and the reply never calls it the person\'s rule', async () => {
    const { dir, ai, host } = await setup();
    host.ruleFails = shrinksBigCaptions;
    const model = new ScriptedModel([{ toolCalls: [call('set_caption_style', { size: 140 })] }, finish('Huge captions.'),
      finish('Kept.'), finish('You asked for huge captions, so I kept them.')]);
    const r = await ai(model).applyNote(dir, 'make the captions huge', () => undefined);
    expect(task(model, 2)).toContain(`"${SAME_SIZE}": 1 subtitle was shrunk to fit`);
    expect(task(model, 2)).toContain('A "Reel Studio default" also gives way to the user\'s My style rules');
    // the fix's summary replaces the first one, so it is handed what that one said
    expect(task(model, 2)).toContain('Your earlier summary was: "Huge captions."');
    expect((await loadProject(dir)).captions.style.size).toBe(140);
    expect(r.summary).toBe('You asked for huge captions, so I kept them.');
  });

  it('a version rendered before the defaults existed is not chased over them', async () => {
    const { dir, ai, host } = await setup();
    await savedAs(dir, 4, { ok: true, checked: 0, checkedIds: [], failures: [], measured: {} }, (p) => { p.captions.style.size = 140; });
    host.ruleFails = shrinksBigCaptions;
    const model = new ScriptedModel([{ toolCalls: [call('set_caption_style', { color: '#3366FF' })] }, finish('The captions are blue.')]);
    const r = await ai(model).applyNote(dir, 'make the captions blue', () => undefined);
    expect(model.requests).toHaveLength(2);
    expect(host.rulesFiles.at(-1).stopOn).toEqual([]);
    expect(r.summary).toBe('The captions are blue.');
  });
});
