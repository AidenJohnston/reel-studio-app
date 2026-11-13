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
/** Any "Remember this for next time?" question: a rule's words, with a typed `payload` or a measured `check`, or
 * neither (a sentence the AI reads). `id` is the question's own: the typed proposal's, or the chat message's. */
export interface StyleQuestion { id: string; text: string; payload?: CaptionCaseRule; source?: StyleSource; check?: RuleCheck }
/** What answering a question did, which the chat says: `saved` (the rule is new), `exists` (it was already there),
 * `paused` (it is in My style but paused: only My style turns it back on), `forgotten` (the person removed it, so it
 * stays with that video), `declined` (No). */
export type AnswerStatus = 'saved' | 'exists' | 'paused' | 'forgotten' | 'declined';
/** A question's recorded answer. It is written with the answer's effect on the rule, in one write, so the chat is a
 * view of it: a question with a recorded answer shows as answered, whatever happened to the chat. */
export interface QuestionAnswer { yes: boolean; status: AnswerStatus; at: string }

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
  /** Set only while the rule is on because of answers: what it falls back to when no Yes newer than `seq` holds it.
   * "gone": it exists only because a question was answered Yes. "paused": a failed note's change was taken back
   * while a later Yes held it on (undo()), or a file from before answers were numbered says a Yes turned it back on.
   * Any direct change clears it: the rule then simply is as the person left it. */
  held?: 'paused' | 'gone';
  /** Rules checking the same kind that a Yes replaced when it saved this one. If that Yes is taken back while it is
   * the only thing holding this rule, they come back. */
  replaced?: StyleRule[];
}
export interface StyleAnswer { yes: boolean; seq: number; at: string }
/** What a note changed in My style, so a failed note can undo exactly that: StyleStore.undo(). */
export interface StyleChange { id: string; text: string; seq: number; was: 'gone' | 'paused' }
/** The active checked rules, and rules whose check this version can't read (saved by a newer Reel Studio):
 * those are named in every note's reply rather than skipped without a word. */
export interface StyleChecks { active: CheckedRule[]; unreadable: StyleRule[] }
/** `damaged`: the file name of a damaged My style.json kept next to this one when My style started over.
 * `forgotten`: questions whose rule was removed, so answering one again cannot bring it back. IDs only. */
export interface StyleFile { version: 1; rules: StyleRule[]; damaged?: string; forgotten?: string[]; seq?: number; questions?: Record<string, QuestionAnswer> }

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

/** The one rule for answers: they matter only to a rule that is on because of them (`held`). It stays on while some
 * question's latest answer is a Yes newer than the last direct change, and otherwise falls back to `held`. So answers
 * can come in any order and a No takes back only its own Yes. A rule not held by answers is as the person left it:
 * no answer turns it on or off. Returns the rules with `r` settled; a rule that existed only because of answers, and
 * that none holds any more, is removed. */
function settle(rules: StyleRule[], r: StyleRule): StyleRule[] {
  if (!r.held) return rules;
  const since = typeof r.seq === 'number' ? r.seq : 0;
  if (answersOf(r).some(([, a]) => a.yes && a.seq > since)) { delete r.paused; return rules; }
  if (r.held === 'gone') {
    const rest = rules.filter((x) => x !== r);
    // a rule replaced comes back unless another rule has taken its place since
    const back = (r.replaced ?? []).filter((old) => !rest.some((x) => x.id === old.id || (old.check && x.check?.kind === old.check.kind)));
    return [...rest, ...back];
  }
  r.paused = true;
  delete r.held;
  return rules;
}
/** A file saved before answers were numbered keeps a rule's questions in `consent` ({proposal, at, also?,
 * resumed?}): the question whose Yes saved the rule, then later Yes answers, and in `resumed` those whose Yes turned
 * it back on from paused. Each becomes a numbered Yes answer, in that order. A paused rule was paused after them, in
 * My style, so it is simply paused. A rule still on is held by them: by all of them ("gone": the Yes saved it), or,
 * when a Yes turned it back on, by that Yes and later ones, falling back to paused (the pause came between). So a No
 * still takes back its own Yes, and removing the rule forgets them like any other answers. */
function fromConsent(data: StyleFile): void {
  const ids = (x: unknown): string[] => (Array.isArray(x) ? x.filter((y): y is string => typeof y === 'string') : []);
  for (const r of data.rules as (StyleRule & { consent?: any })[]) {
    const c = r.consent;
    delete r.consent;
    if (!c || typeof c.proposal !== 'string' || r.answers) continue;
    const at = typeof c.at === 'string' ? c.at : r.createdAt;
    const resumed = new Set(ids(c.resumed));
    r.answers = {};
    for (const q of [c.proposal, ...ids(c.also)]) {
      // the pause that the first resumed Yes ended came just before it
      if (!r.paused && resumed.has(q) && r.held !== 'paused') { r.seq = next(data); r.held = 'paused'; }
      r.answers[q] = { yes: true, seq: next(data), at };
    }
    if (!r.paused) r.held ??= 'gone';
  }
}
/** A direct change to `r` (My style, or a note): the rule now simply is as it was left, and older answers stop
 * counting. */
function changedDirectly(data: StyleFile, r: StyleRule): number {
  r.seq = next(data);
  delete r.held;
  delete r.replaced;
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
   * changed it directly since (their choice stands). A Yes given since still holds it on, by settle(), until it is
   * taken back too. */
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

  /** The person answered question `q`. The answer and what it does to My style are written together, with the
   * question's record (answerOf), so no crash can leave a question half answered: the chat shows the record.
   * Yes saves the rule when it is new; a rule already there stays as it is, and a paused one stays paused (only My
   * style turns it back on), so no order of answers can turn a rule on or off behind the person's back. No takes back
   * only this question's own Yes (settle()). The question of a rule the person removed cannot bring it back. Answered
   * again (a stale window), the last answer wins, and the reply says what the rule is now. */
  async answer(q: StyleQuestion, yes: boolean): Promise<{ status: AnswerStatus }> {
    return this.serial(async () => {
      const typed = q.payload !== undefined;
      if (!q?.id || (typed && (q.text !== LOWERCASE_CAPTIONS || !isCaptionCase(q.payload)))) throw new Error('the question does not match the rule it would save');
      const check = q.check === undefined ? undefined : parseCheck(q.check);
      const text = check ? ruleText(check) : typed ? LOWERCASE_CAPTIONS : cleanRuleText(q.text);
      if (check && cleanRuleText(q.text) !== text) throw new Error('the question does not match the rule it would save');
      const data = await this.read();
      const at = new Date().toISOString();
      const done = (status: AnswerStatus, rules = data.rules) =>
        this.write({ ...data, rules, questions: { ...data.questions, [q.id]: { yes, status, at } } }).then(() => ({ status }));
      const asked = data.rules.find((r) => answered(r).includes(q.id));
      if (!yes) {
        if (!asked) return done('declined');
        asked.answers = { ...asked.answers, [q.id]: { yes: false, seq: next(data), at } };
        return done('declined', settle(data.rules, asked));
      }
      if (data.forgotten?.includes(q.id)) return done('forgotten');
      const say = (r: StyleRule) => { r.answers = { ...r.answers, [q.id]: { yes: true, seq: next(data), at } }; };
      // The rule this question is about, if My style has it: the one it answered before, or the same rule.
      const same = asked ?? data.rules.find((r) => typed ? isCaptionCase(r.payload)
        : check ? r.check?.kind === check.kind && r.text === text : !r.check && !r.payload && normalize(r.text) === normalize(text));
      if (same) {
        say(same);
        // Edited to new words since, the rule is not the one asked about: "saved" would promise what it no longer does.
        const edited = typed ? !isCaptionCase(same.payload) : !!check && same.text !== text;
        if (same.paused) delete same.held;
        return done(edited ? 'exists' : same.paused ? 'paused' : asked ? 'saved' : 'exists');
      }
      const rule: StyleRule = { id: randomUUID(), text, createdAt: at, held: 'gone',
        ...(typed ? { payload: { kind: 'caption-case', case: 'lower' } as const,
          source: { project: String(q.source?.project ?? ''), title: String(q.source?.title ?? '').slice(0, 120), version: Number(q.source?.version) || 0 } } : {}),
        ...(check ? { check } : {}) };
      say(rule);
      // My style keeps one rule per check kind, and the same words once (a plain sentence gives way to the typed or
      // checked rule). It gets a new ID: a running note that saved that sentence undoes it by ID if the note fails, and
      // must not take the approved rule with it.
      const gives = (r: StyleRule) => normalize(r.text) === normalize(text) || (!!check && r.check?.kind === check.kind);
      const replaced = data.rules.filter(gives);
      if (check && replaced.length) rule.replaced = replaced;
      return done('saved', [...data.rules.filter((r) => !gives(r)), rule]);
    });
  }

  /** The recorded answer to question `id`, or null when it has not been answered. */
  async answerOf(id: string): Promise<QuestionAnswer | null> {
    const data = await this.serial(() => this.read()).catch(() => null);
    const a = data?.questions?.[id];
    return a && typeof a.yes === 'boolean' && typeof a.status === 'string' ? a : null;
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
