// "My style": durable user preferences, persisted in <Reel Studio root>/My style.json.
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { styleFile, writeFileAtomic } from './project';
import { CheckedRule, RuleCheck, parseCheck, ruleText } from './rules';

/** A rule the app applies itself, through the caption tool, when a new video is made. Only lowercase for now:
 * the caption tool and the engine schema agree on `lower`, but not on sentence case. */
export interface CaptionCaseRule { kind: 'caption-case'; case: 'lower' }
/** The video and version whose note the rule came from. */
export interface StyleSource { project: string; title: string; version: number }
/** "Remember this for next time?" for a typed rule. Saved only when the person says Yes to exactly this. */
export interface StyleProposal { id: string; text: string; payload: CaptionCaseRule; source: StyleSource }

export interface StyleRule {
  id: string; text: string; createdAt: string;
  /** listed in My style, but left out of what the AI reads and of new videos */
  paused?: boolean;
  payload?: CaptionCaseRule;
  /** the engine measures this on every render (rules.ts); the rule's words are ruleText(check) */
  check?: RuleCheck;
  source?: StyleSource;
  /** Every answer to a "Remember this?" question about this rule, the latest per question, numbered from the file's
   * `seq`. See settle(). */
  answers?: Record<string, StyleAnswer>;
  /** The number of the last change made to the rule directly: in My style, or by a note. Answers older than it no
   * longer count: the person (or their note) chose after them. */
  seq?: number;
  /** The state that last direct change left, which the rule falls back to when no newer Yes holds it on. "gone": the
   * rule exists only because a question was answered Yes. */
  held?: 'on' | 'paused' | 'gone';
}
export interface StyleAnswer { yes: boolean; seq: number; at: string }
/** What a note changed in My style, so a failed note can undo exactly that: StyleStore.undo(). */
export interface StyleChange { id: string; text: string; seq: number; was: 'gone' | 'paused' }
/** The active checked rules, and rules whose check this version can't read (saved by a newer Reel Studio):
 * those are named in every note's reply rather than skipped without a word. */
export interface StyleChecks { active: CheckedRule[]; unreadable: StyleRule[] }
/** `damaged`: the file name of a damaged My style.json kept next to this one when My style started over.
 * `forgotten`: questions whose rule was removed, so answering one again cannot bring it back. IDs only. */
export interface StyleFile { version: 1; rules: StyleRule[]; damaged?: string; forgotten?: string[]; seq?: number }
export type Approval = { status: 'saved' | 'exists'; rule: StyleRule } | { status: 'forgotten' };

export const LOWERCASE_CAPTIONS = 'Use lowercase captions.';
const isCaptionCase = (x: unknown): x is CaptionCaseRule => (x as CaptionCaseRule)?.kind === 'caption-case' && (x as CaptionCaseRule).case === 'lower';
/** The rule's answers. My style.json can be edited by hand: an entry that is not an answer is none. */
const answersOf = (r: StyleRule): [string, StyleAnswer][] =>
  Object.entries(r.answers && typeof r.answers === 'object' ? r.answers : {})
    .filter((e): e is [string, StyleAnswer] => typeof e[1]?.yes === 'boolean' && typeof e[1]?.seq === 'number');
/** The questions answered about this rule, Yes or No: removing the rule forgets them all. */
const answered = (r: StyleRule): string[] => answersOf(r).map(([q]) => q);
/** The next number in the file's sequence. Every answer and every direct change takes one. */
const next = (data: StyleFile): number => (data.seq = (typeof data.seq === 'number' ? data.seq : 0) + 1);
const stateOf = (r: StyleRule): 'on' | 'paused' => (r.paused ? 'paused' : 'on');

/** The one rule for a rule's state: on while some question's latest answer is a Yes newer than the last direct
 * change, otherwise what that change left. So answers can come in any order, a No only takes back its own Yes, and
 * nothing older than the person's last choice in My style (or their note's) can change the rule. Returns the rules
 * with `r` settled; a rule held only by answers that are now gone is removed. */
function settle(rules: StyleRule[], r: StyleRule): StyleRule[] {
  const since = typeof r.seq === 'number' ? r.seq : 0;
  const state = answersOf(r).some(([, a]) => a.yes && a.seq > since) ? 'on' : (r.held ?? stateOf(r));
  if (state === 'gone') return rules.filter((x) => x !== r);
  if (state === 'paused') r.paused = true; else delete r.paused;
  return rules;
}
/** A file saved before answers were numbered keeps a rule's questions in `consent` ({proposal, at, also?}): the
 * question whose Yes saved the rule, then later Yes answers. Each becomes a numbered Yes answer, in that order. A
 * rule still on is held only by them (the Yes saved it), so a No can still take it back out; a paused one was paused
 * after them, in My style, so the pause stands. Removing the rule then forgets them like any other answers. */
function fromConsent(data: StyleFile): void {
  for (const r of data.rules as (StyleRule & { consent?: any })[]) {
    const c = r.consent;
    delete r.consent;
    if (!c || typeof c.proposal !== 'string' || r.answers) continue;
    const at = typeof c.at === 'string' ? c.at : r.createdAt;
    const asked = [c.proposal, ...(Array.isArray(c.also) ? c.also.filter((x: unknown): x is string => typeof x === 'string') : [])];
    r.answers = Object.fromEntries(asked.map((q) => [q, { yes: true, seq: next(data), at }]));
    if (r.paused) { r.held = 'paused'; r.seq = next(data); } else r.held = 'gone';
  }
}
/** A direct change to `r` (My style, or a note): it now holds the state it has, and older answers stop counting. */
function changedDirectly(data: StyleFile, r: StyleRule): number {
  r.seq = next(data);
  r.held = stateOf(r);
  return r.seq;
}

/** A stored check's words, or null when this version can't read the check. */
const checkedText = (c: unknown): string | null => { try { return ruleText(parseCheck(c)); } catch { return null; } };

const CAPTION_CASE_PROMPT = 'New videos start with lowercase captions (the app sets this). Use another case only when the note asks for it.';

export function captionCaseProposal(source: StyleSource): StyleProposal {
  return { id: randomUUID(), text: LOWERCASE_CAPTIONS, payload: { kind: 'caption-case', case: 'lower' }, source };
}

const normalize = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, '').replace(/\s+/g, ' ').trim();

/** A rule as it is shown and stored: one sentence, capitalised, ending in a full stop. */
export function cleanRuleText(text: string): string {
  let clean = String(text ?? '').replace(/\s*—\s*/g, ', ').replace(/\s+/g, ' ').trim();
  if (!clean) throw new Error('empty rule');
  if (!/[.!?]$/.test(clean)) clean += '.';
  return clean[0].toUpperCase() + clean.slice(1);
}

/** The user's note itself asks for a lasting habit ("always...", "from now on...", "remember...",
 * "in every video..."). Only then is a rule saved without asking; otherwise it is only proposed
 * (novice test: "I also saved this to My style" for a note that never asked was surprising). */
export function noteAsksToRemember(note: string | undefined): boolean {
  return !!note && /\b(always|never again|from now on|going forward|in (the )?future|remember|every (video|time|reel)|all (my|of my|future) (videos|reels)|for next time|next time)\b/i.test(note);
}

/** Every change reads, edits and writes the whole file, which every project shares. Reads and changes run one at a
 * time per file, across every StyleStore in this process: two saves at once used to drop one of them, within one
 * store (review finding 36) and between two. Windows paths that differ only in letter case are the same file. */
const queues = new Map<string, Promise<unknown>>();
const queueKey = (file: string) => (process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file));

/** Copies `file` to "<name>.damaged.json", or "<name>.damaged 2.json" and so on when that is taken. Never overwrites. */
async function keepDamagedCopy(file: string): Promise<string> {
  const stem = file.replace(/\.json$/i, '');
  for (let n = 1; ; n++) {
    const copy = `${stem}.damaged${n > 1 ? ` ${n}` : ''}.json`;
    try {
      await fsp.copyFile(file, copy, fs.constants.COPYFILE_EXCL);
      return copy;
    } catch (e: any) {
      if (e?.code !== 'EEXIST') throw e;
    }
  }
}

export class StyleStore {
  constructor(private readonly rootDir: () => string) {}

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const key = queueKey(this.file);
    const run = (queues.get(key) ?? Promise.resolve()).then(fn);
    const tail = run.catch(() => undefined);
    queues.set(key, tail);
    void tail.then(() => { if (queues.get(key) === tail) queues.delete(key); });
    return run;
  }

  get file(): string { return styleFile(this.rootDir()); }

  /** Runs inside serial(). No file is an empty My style. A file that is not My style (bad JSON, no rules list) is
   * kept as a copy next to it and My style starts over, so the person can save again. Any other read error, such as
   * no permission, throws, so no save replaces rules it could not read. Fields it doesn't know are kept. */
  private async read(): Promise<StyleFile> {
    let text: string;
    try { text = await fsp.readFile(this.file, 'utf8'); } catch (e: any) {
      if (e?.code === 'ENOENT') return { version: 1, rules: [] };
      throw e;
    }
    let data: any = null;
    try { data = JSON.parse(text.replace(/^\uFEFF/, '')); } catch { /* damaged: kept below */ }
    if (!Array.isArray(data?.rules)) {
      const fresh: StyleFile = { version: 1, rules: [], damaged: path.basename(await keepDamagedCopy(this.file)) };
      await this.write(fresh);
      return fresh;
    }
    const { forgotten: listed, ...rest } = data;
    const forgotten = Array.isArray(listed) ? listed.filter((x: unknown) => typeof x === 'string') : [];
    const out: StyleFile = { ...rest, version: 1, rules: data.rules.filter((r: any) => r && typeof r.text === 'string'), ...(forgotten.length ? { forgotten } : {}) };
    fromConsent(out);
    return out;
  }

  private async write(data: StyleFile): Promise<void> {
    await writeFileAtomic(this.file, JSON.stringify(data, null, 2) + '\n');
  }

  /** What edits and the My style screen use: nothing when the file can't be read. */
  async list(): Promise<StyleRule[]> {
    return (await this.serial(() => this.read()).catch(() => null))?.rules ?? [];
  }

  /** My style started over because its file was damaged, and the damaged copy is still next to it. */
  async wasDamaged(): Promise<boolean> {
    const data = await this.serial(() => this.read()).catch(() => null);
    return typeof data?.damaged === 'string' && fs.existsSync(path.join(path.dirname(this.file), path.basename(data.damaged)));
  }

  /** Adds a rule unless an equivalent one already exists. Every caller is the person asking for the rule (Yes to a
   * suggestion, or an "always..." note), so an equivalent paused rule is turned back on (PR #83 review, option A).
   * A checked rule's words must be its check's (the question showed them), and it replaces any rule checking
   * the same kind: two "at most N words" rules can't both hold.
   * `change`: what this call changed, decided in the same write, for a caller that may have to undo it (undo()). */
  async add(text: string, check?: RuleCheck): Promise<{ added: boolean; resumed: boolean; rule: StyleRule; change?: StyleChange }> {
    if (check === undefined) return this.serial(() => this.addNow(text));
    const c = parseCheck(check);
    if (cleanRuleText(text) !== ruleText(c)) throw new Error('the question does not match the rule it would save');
    return this.serial(async () => {
      const data = await this.read();
      const same = data.rules.find((r) => normalize(r.text) === normalize(ruleText(c)));
      if (same && same.check?.kind === c.kind && !same.paused) return { added: false, resumed: false, rule: same };
      const rule: StyleRule = { id: randomUUID(), text: ruleText(c), createdAt: new Date().toISOString(), check: c };
      const seq = changedDirectly(data, rule);
      const rest = data.rules.filter((r) => r.check?.kind !== c.kind && normalize(r.text) !== normalize(rule.text));
      await this.write({ ...data, rules: [...rest, rule] });
      return { added: true, resumed: false, rule, change: { id: rule.id, text: rule.text, seq, was: 'gone' } };
    });
  }

  /** The saved rule equivalent to `text`, if any. */
  async find(text: string): Promise<StyleRule | undefined> {
    const n = normalize(cleanRuleText(text));
    return (await this.list()).find((r) => normalize(r.text) === n);
  }

  private async addNow(text: string): Promise<{ added: boolean; resumed: boolean; rule: StyleRule; change?: StyleChange }> {
    const clean = cleanRuleText(text);
    const data = await this.read();
    const dup = data.rules.find((r) => normalize(r.text) === normalize(clean));
    if (dup) {
      if (!dup.paused) return { added: false, resumed: false, rule: dup };
      delete dup.paused;
      const seq = changedDirectly(data, dup);
      await this.write(data);
      return { added: false, resumed: true, rule: dup, change: { id: dup.id, text: dup.text, seq, was: 'paused' } };
    }
    const rule: StyleRule = { id: randomUUID(), text: clean, createdAt: new Date().toISOString() };
    const seq = changedDirectly(data, rule);
    await this.write({ ...data, rules: [...data.rules, rule] });
    return { added: true, resumed: false, rule, change: { id: rule.id, text: rule.text, seq, was: 'gone' } };
  }

  /** A failed note takes back its own change: the rule falls back to what it was before the note, unless the person
   * changed it directly since (their choice stands). A Yes given since still holds it on, by settle(). */
  async undo(c: StyleChange): Promise<void> {
    return this.serial(async () => {
      const data = await this.read();
      const rule = data.rules.find((r) => r.id === c.id);
      if (!rule) throw { code: 'NOT_FOUND', userMessage: 'That rule is not in My style any more.' };
      if (rule.seq !== c.seq) return;
      rule.held = c.was;
      await this.write({ ...data, rules: settle(data.rules, rule) });
    });
  }

  /** The person said Yes to `p`: the answer, and the rule when it is new, are saved in one write. Answering the
   * same question again returns the same rule, and the question of a rule they removed cannot bring it back. Yes is
   * the person asking for the rule, so a paused typed rule is turned back on (settle()) before "saved" promises it. */
  async approve(p: StyleProposal): Promise<Approval> {
    return this.serial(async () => {
      if (!p?.id || p.text !== LOWERCASE_CAPTIONS || !isCaptionCase(p.payload)) throw new Error('the question does not match the rule it would save');
      const data = await this.read();
      if (data.forgotten?.includes(p.id)) return { status: 'forgotten' };
      const at = new Date().toISOString();
      const same = data.rules.find((r) => answered(r).includes(p.id));
      // Edited to new words since the answer, the rule is a sentence the AI reads, so "Saved" would promise lowercase
      // videos the app no longer makes.
      if (same && !isCaptionCase(same.payload)) return { status: 'exists', rule: same };
      let rules = data.rules;
      let rule = same ?? rules.find((r) => isCaptionCase(r.payload));
      const wasOn = !!rule && !rule.paused;
      if (!rule) {
        // The same words saved as a plain sentence give way to the typed rule. It gets a new ID: a running note
        // that saved that sentence undoes it by ID if the note fails, and must not take the approved rule with it.
        rule = { id: randomUUID(), text: LOWERCASE_CAPTIONS, createdAt: at, payload: { kind: 'caption-case', case: 'lower' },
          source: { project: String(p.source?.project ?? ''), title: String(p.source?.title ?? '').slice(0, 120), version: Number(p.source?.version) || 0 },
          held: 'gone' };
        rules = [...rules.filter((r) => normalize(r.text) !== normalize(LOWERCASE_CAPTIONS)), rule];
      }
      rule.held ??= stateOf(rule);
      rule.answers = { ...rule.answers, [p.id]: { yes: true, seq: next(data), at } };
      await this.write({ ...data, rules: settle(rules, rule) });
      return { status: same || !wasOn ? 'saved' : 'exists', rule };
    });
  }

  /** The person said No to `p`. If a Yes to it was saved before a crash cut off the reply, the No is now that
   * question's answer and takes the Yes back (settle() decides what that changes). A Yes after it, from buttons a
   * crash left behind, is the last answer again. */
  async decline(p: StyleProposal): Promise<void> {
    return this.serial(async () => {
      const data = await this.read();
      const rule = data.rules.find((r) => answered(r).includes(p.id));
      if (!rule) return;
      rule.answers = { ...rule.answers, [p.id]: { yes: false, seq: next(data), at: new Date().toISOString() } };
      await this.write({ ...data, rules: settle(data.rules, rule) });
    });
  }

  /** My style: the person changed a rule's words, or paused or resumed it. New words make a typed rule a plain
   * one: the app cannot apply "lowercase captions for tutorials" itself. */
  async update(id: string, patch: { text?: string; paused?: boolean }): Promise<StyleRule> {
    return this.serial(async () => {
      const data = await this.read();
      const rule = data.rules.find((r) => r.id === id);
      if (!rule) throw { code: 'NOT_FOUND', userMessage: 'That rule is not in My style any more.' };
      if (patch.text !== undefined) {
        rule.text = cleanRuleText(patch.text);
        if (rule.payload && rule.text !== LOWERCASE_CAPTIONS) delete rule.payload;
        // the same reasoning for a checked rule: "at most 2 words, except in tutorials" is not what is measured
        if (rule.check && rule.text !== checkedText(rule.check)) delete rule.check;
      }
      if (patch.paused === true) rule.paused = true;
      if (patch.paused === false) delete rule.paused;
      changedDirectly(data, rule);
      await this.write(data);
      return rule;
    });
  }

  async remove(id: string): Promise<void> {
    return this.serial(async () => {
      const data = await this.read();
      const rule = data.rules.find((r) => r.id === id);
      const asked = rule ? answered(rule) : [];
      await this.write({ ...data, rules: data.rules.filter((r) => r.id !== id), ...(asked.length ? { forgotten: [...(data.forgotten ?? []), ...asked] } : {}) });
    });
  }

  /** The caption case an active typed rule asks for. Only this checked value leaves the store. */
  async captionCase(): Promise<'lower' | null> {
    return (await this.list()).some((r) => !r.paused && isCaptionCase(r.payload)) ? 'lower' : null;
  }

  /** A typed lowercase rule is already in My style, paused or not. */
  async hasCaptionCase(): Promise<boolean> {
    return (await this.list()).some((r) => isCaptionCase(r.payload));
  }

  /** The checked rules every render in a note measures. A paused rule is not checked. */
  async checks(): Promise<StyleChecks> {
    const out: StyleChecks = { active: [], unreadable: [] };
    for (const r of await this.list()) {
      if (r.paused || r.check === undefined) continue;
      try { out.active.push({ id: r.id, text: r.text, check: parseCheck(r.check) }); } catch { out.unreadable.push(r); }
    }
    return out;
  }

  /** `start`: checked rules the version being edited already broke (`before`), or was never measured against
   * (`unknown`). A note leaves those alone (editor.ts). */
  async asPromptText(start?: { before: Set<string>; unknown: Set<string> }): Promise<string> {
    const rules = (await this.list()).filter((r) => !r.paused);
    const line = (r: StyleRule) => isCaptionCase(r.payload) ? CAPTION_CASE_PROMPT
      : checkedText(r.check) === null ? r.text
      : start?.before.has(r.id) ? `${r.text} (this video already broke it before this note: leave that alone unless the note is about it)`
      : start?.unknown.has(r.id) ? `${r.text} (this video was made before the app checked it: leave that alone unless the note is about it)`
      : `${r.text} (the app measures this on every render; a note can't finish while it fails)`;
    return rules.length ? rules.map((r) => `- ${line(r)}`).join('\n') : '(none yet)';
  }
}
