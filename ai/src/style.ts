// "My style": durable user preferences, persisted in <Reel Studio root>/My style.json.
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { styleFile, writeFileAtomic } from './project';
import { CheckedRule, RuleCheck, parseCheck, ruleText } from './rules';

/** A rule the app applies itself, through the caption tool, when a new video is made. Only lowercase for now:
 * the caption tool and the engine schema agree on `lower`, but not on sentence case. */
export interface CaptionCaseRule { kind: 'caption-case'; case: 'lower' }
/** The video and version whose note the rule came from, and the note's words. */
export interface StyleSource { project: string; title: string; version: number; note?: string }
/** "Remember this for next time?" for a typed rule. Saved only when the person says Yes to exactly this. */
export interface StyleProposal { id: string; text: string; payload: CaptionCaseRule; source: StyleSource }
/** Any "Remember this for next time?" question: a rule's words, with a typed `payload` or a measured `check`, or
 * neither (a sentence the AI reads). `id` is the question's own: the typed proposal's, or the chat message's.
 * `source`: the note and version it was learned from, kept with a rule the Yes saves. */
export interface StyleQuestion { id: string; text: string; payload?: CaptionCaseRule; source?: StyleSource; check?: RuleCheck }
/** What answering a question did, which the chat says: `saved` (the rule is new), `exists` (it was already there),
 * `paused` (it is in My style but paused: only My style turns it back on), `forgotten` (the person removed it, so it
 * stays with that reel), `declined` (No). */
export type AnswerStatus = 'saved' | 'exists' | 'paused' | 'forgotten' | 'declined';
/** A question's recorded answer. It is written with the answer's effect on the rule, in one write, so the chat is a
 * view of it: a question with a recorded answer shows as answered, whatever happened to the chat. */
export interface QuestionAnswer { yes: boolean; status: AnswerStatus; at: string }

export interface StyleRule {
  id: string; text: string; createdAt: string;
  /** listed in My style, but left out of what the AI reads and of new videos */
  paused?: boolean;
  payload?: CaptionCaseRule;
  /** The engine measures this on every render (rules.ts); the rule's words are ruleText(check). */
  check?: RuleCheck;
  source?: StyleSource;
  /** Learned from another editor's export ("Learn from my past edits"): its file name, and its editor when one
   * file was read. */
  imported?: { file: string; editor?: 'Final Cut Pro' | 'Premiere Pro' | 'DaVinci Resolve' | 'CapCut' | 'EDL' };
  /** Every answer to a "Remember this?" question about this rule, the latest per question, numbered from the file's
   * `seq`. See settle(). */
  answers?: Record<string, StyleAnswer>;
  /** The number of the last change made to the rule directly: in My style, or by an edit. Answers older than it no
   * longer count: the person (or their note) chose after them. */
  seq?: number;
  /** Set only while the rule is on because of answers: what it falls back to when no Yes newer than `seq` holds it.
   * "gone": it exists only because a question was answered Yes. "paused": an edit's change was taken back while a
   * later Yes held it on (undo()), or a file from before answers were numbered says a Yes turned it back on. Any
   * direct change clears it: the rule then simply is as the person left it. */
  held?: 'paused' | 'gone';
  /** Rules checking the same kind that a Yes replaced when it saved this one. If that Yes is taken back while it is
   * the only thing holding this rule, they come back. */
  replaced?: StyleRule[];
  /** When its words last changed. Pausing does not count, so a paused rule keeps its place in My style. */
  updatedAt?: string;
  /** Typed in by the person with Add a rule, not learned from a note or an export. */
  byYou?: true;
  /** Kept from a suggestion My style made from post results or the person's own hand edits: what it was read from. */
  learned?: { from: 'results' | 'edits'; evidence: string };
}
export interface StyleAnswer { yes: boolean; seq: number; at: string }
/** What an edit changed in My style while it ran, so a failed one can undo exactly that: StyleStore.undo(). */
export interface StyleChange { id: string; text: string; seq: number; was: 'gone' | 'paused' }
/** The active checked rules, and rules whose check this version can't read (saved by a newer Reel Studio):
 * those are named in every note's reply rather than skipped without a word. */
export interface StyleChecks { active: CheckedRule[]; unreadable: StyleRule[] }
/** `damaged`: the file name of a damaged My style.json kept next to this one when My style started over.
 * `forgotten`: questions whose rule was removed, so answering one again cannot bring it back, and the words of
 * removed rules and dismissed memories, which learning never proposes again: ids and normalized words, no notes. */
export interface StyleFile {
  version: 1; rules: StyleRule[]; damaged?: string; forgotten?: string[]; proposals?: MemoryProposal[];
  /** the last number given to an answer or a direct change (next()) */
  seq?: number;
  /** every question's recorded answer, by the question's id (answer()) */
  questions?: Record<string, QuestionAnswer>;
}

// ---- memories learned from post results (learning-loop: learn() in learning.ts drafts them, propose() keeps them)
export type MemoryKind = 'captions' | 'pacing' | 'music' | 'cuts' | 'look';
export interface TrialLink {
  project: string; parentVersion: number; version: number; parentPostId: string; postId: string;
  /** Relative to Projects, with the trials.json array index as a JSON pointer. */
  href: string;
}
export interface MemoryProposal {
  id: string; kind: MemoryKind; line: string; text: string; proposedAt: string;
  from: { kind: 'note'; project: string; title: string; version: number; note?: string }
    | { kind: 'results'; reels: string[]; metric: string; change: number; n: number; evidence: string; trials: TrialLink[] }
    /** The same change made by hand in several reels (the app's memory-loop.ts finds them). */
    | { kind: 'edits'; reels: string[]; n: number; evidence: string };
}
export type ProposalDraft = Omit<MemoryProposal, 'id' | 'proposedAt'>;
export type ProposalStatus = 'added' | 'duplicate' | 'forgotten' | 'full';

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function isTrialLink(value: unknown): value is TrialLink {
  return record(value) && typeof value.project === 'string' && Number.isSafeInteger(value.parentVersion)
    && Number.isSafeInteger(value.version) && typeof value.parentPostId === 'string' && typeof value.postId === 'string' && typeof value.href === 'string';
}
function isProposal(value: unknown): value is MemoryProposal {
  if (!record(value) || typeof value.id !== 'string' || typeof value.proposedAt !== 'string'
    || typeof value.text !== 'string' || typeof value.line !== 'string' || value.line.length > 60
    || typeof value.kind !== 'string' || !['captions', 'pacing', 'music', 'cuts', 'look'].includes(value.kind) || !record(value.from)) return false;
  const source = value.from;
  if (source.kind === 'edits') {
    return Array.isArray(source.reels) && source.reels.every((r) => typeof r === 'string')
      && typeof source.n === 'number' && Number.isSafeInteger(source.n) && source.n > 0 && typeof source.evidence === 'string';
  }
  return source.kind === 'note'
    ? typeof source.project === 'string' && typeof source.title === 'string' && typeof source.version === 'number'
      && (source.note === undefined || typeof source.note === 'string')
    : source.kind === 'results' && Array.isArray(source.reels) && source.reels.every((r) => typeof r === 'string')
      && typeof source.metric === 'string' && typeof source.change === 'number' && Number.isFinite(source.change)
      && typeof source.n === 'number' && Number.isSafeInteger(source.n) && source.n > 0
      && typeof source.evidence === 'string' && Array.isArray(source.trials) && source.trials.every(isTrialLink);
}
function proposalId(text: string): string {
  return 'proposal-' + createHash('sha256').update(text).digest('hex');
}
export const LOWERCASE_CAPTIONS = 'Use lowercase subtitles.';
/** The typed rule's words before the app said "subtitles": saved rules and questions still on screen may carry them. */
const OLD_LOWERCASE_TEXT = 'Use lowercase captions.';
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
/** A file saved before answers were numbered keeps a rule's questions in `consent` ({proposal, at, also?}): the
 * question whose Yes saved the rule, then later Yes answers. Each becomes a numbered Yes answer, in that order. A
 * paused rule was paused after them, in My style, so it is simply paused; one still on is held by them ("gone": the
 * Yes saved it). So a No still takes back its own Yes, and removing the rule forgets them like any other answers. */
function fromConsent(data: StyleFile): void {
  const ids = (x: unknown): string[] => (Array.isArray(x) ? x.filter((y): y is string => typeof y === 'string') : []);
  for (const r of data.rules as (StyleRule & { consent?: any })[]) {
    const c = r.consent;
    delete r.consent;
    if (!c || typeof c.proposal !== 'string' || r.answers) continue;
    const at = typeof c.at === 'string' ? c.at : r.createdAt;
    r.answers = {};
    for (const q of [c.proposal, ...ids(c.also)]) r.answers[q] = { yes: true, seq: next(data), at };
    if (!r.paused) r.held = 'gone';
  }
}
/** A direct change to `r` (My style, or an edit): the rule now simply is as it was left, and older answers stop
 * counting. */
function changedDirectly(data: StyleFile, r: StyleRule): number {
  r.seq = next(data);
  delete r.held;
  delete r.replaced;
  return r.seq;
}

/** A stored check's words, or null when this version can't read the check. */
const checkedText = (c: unknown): string | null => { try { return ruleText(parseCheck(c)); } catch { return null; } };

const CAPTION_CASE_PROMPT = 'New reels start with lowercase subtitles (the app sets this). Use another case only when the note asks for it.';

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
    // the typed rule's words were "Use lowercase captions." before the app said subtitles everywhere
    const rules = data.rules.filter((r: any) => r && typeof r.text === 'string')
      .map((r: any) => (r.text === OLD_LOWERCASE_TEXT && isCaptionCase(r.payload) ? { ...r, text: LOWERCASE_CAPTIONS } : r));
    const proposals = Array.isArray(rest.proposals) ? rest.proposals.filter(isProposal) : undefined;
    const out: StyleFile = { ...rest, version: 1, rules, ...(forgotten.length ? { forgotten } : {}), ...(proposals ? { proposals } : {}) };
    fromConsent(out);
    return out;
  }

  /** The file as learning reads it: never the recovery read() does. Learning runs with nobody there to see the
   * "started over" line, so a damaged file stops it and stays as it is (learning-loop). */
  private async readForLearning(): Promise<StyleFile> {
    let data: any = null;
    try { data = JSON.parse((await fsp.readFile(this.file, 'utf8')).replace(/^\uFEFF/, '')); } catch (e: any) {
      if (e?.code === 'ENOENT') return { version: 1, rules: [] };
    }
    if (!Array.isArray(data?.rules) || (data.proposals !== undefined && (!Array.isArray(data.proposals) || !data.proposals.every(isProposal)))) {
      throw new Error('The memory file could not be read. Restore it before saving memories.');
    }
    return this.read();
  }

  private proposalStatusIn(data: StyleFile, proposal: ProposalDraft): ProposalStatus | 'new' {
    const text = normalize(cleanRuleText(proposal.text));
    const id = proposalId(text);
    if (data.forgotten?.some((forgotten) => forgotten === id || normalize(forgotten) === text)) return 'forgotten';
    if (data.rules.some((r) => normalize(r.text) === text) || data.proposals?.some((p) => normalize(p.text) === text)) return 'duplicate';
    return (data.proposals?.length ?? 0) >= 3 ? 'full' : 'new';
  }

  /** Whether propose() would keep this draft: learn() skips the ones it would not. */
  async proposalStatus(proposal: ProposalDraft): Promise<ProposalStatus | 'new'> {
    return this.proposalStatusIn(await this.readForLearning(), proposal);
  }

  /** Keeps a memory learn() drafted from post results, at most three waiting; never a rule until the person adds it. */
  async propose(proposal: ProposalDraft): Promise<ProposalStatus> {
    return this.serial(async () => {
      const data = await this.readForLearning();
      const status = this.proposalStatusIn(data, proposal);
      if (status !== 'new') return status;
      const text = cleanRuleText(proposal.text);
      const saved = { ...proposal, text, id: proposalId(normalize(text)), proposedAt: new Date().toISOString() };
      if (!isProposal(saved)) throw new Error('Invalid memory proposal. Supply a kind, a short line and its evidence.');
      await this.write({ ...data, proposals: [...(data.proposals ?? []), saved] });
      return 'added';
    });
  }

  /**
   * Takes back waiting memories drafted from post results that `current`, the complete set results support now, no
   * longer contains: a trial read again went the other way, so the suggestion's evidence is gone (and with it the
   * chance of an opposite suggestion waiting beside it). Rules, memories from notes and hand edits, and the person's
   * refusals are untouched, and a withdrawn memory may be suggested again if its evidence comes back. Returns how many
   * were taken back; writes only when that is more than none.
   */
  async withdrawUnsupportedResults(current: ProposalDraft[]): Promise<number> {
    return this.serial(async () => {
      const data = await this.readForLearning();
      const supported = new Set(current.map((d) => normalize(cleanRuleText(d.text))));
      const proposals = (data.proposals ?? []).filter((p) => p.from.kind !== 'results' || supported.has(normalize(p.text)));
      const gone = (data.proposals?.length ?? 0) - proposals.length;
      if (gone) await this.write({ ...data, proposals });
      return gone;
    });
  }

  /** The memories waiting for the person, oldest first. Nothing when the file can't be read. */
  async proposals(): Promise<MemoryProposal[]> {
    return (await this.serial(() => this.read()).catch(() => null))?.proposals ?? [];
  }

  /** The person kept a waiting memory, with its words or theirs: it becomes a rule in the same write that takes it
   * off the list. An equivalent rule already there is kept instead (and turned back on). Null when it is gone. */
  async accept(id: string, words?: string): Promise<StyleRule | null> {
    return this.serial(async () => {
      const data = await this.readForLearning();
      const proposal = data.proposals?.find((p) => p.id === id);
      if (!proposal) return null;
      const text = cleanRuleText(words ?? proposal.text);
      const proposals = data.proposals!.filter((p) => p.id !== id);
      // kept in other words, its own words are neither a rule nor turned down: without this the next look
      // suggests them again
      const forgotten = normalize(text) === normalize(proposal.text) ? data.forgotten
        : [...new Set([...(data.forgotten ?? []), id, normalize(proposal.text)])];
      const dup = data.rules.find((r) => normalize(r.text) === normalize(text));
      if (dup) {
        delete dup.paused;
        changedDirectly(data, dup);
        await this.write({ ...data, proposals, ...(forgotten ? { forgotten } : {}) });
        return dup;
      }
      const from = proposal.from;
      const rule: StyleRule = {
        id: randomUUID(), text, createdAt: new Date().toISOString(),
        ...(from.kind === 'note'
          ? { source: { project: from.project, title: from.title, version: from.version, ...(from.note ? { note: from.note } : {}) } }
          : { learned: { from: from.kind, evidence: from.evidence } }),
      };
      changedDirectly(data, rule);
      await this.write({ ...data, rules: [...data.rules, rule], proposals, ...(forgotten ? { forgotten } : {}) });
      return rule;
    });
  }

  /** The person said no to a waiting memory: it, and the same words, are never proposed again. */
  async dismiss(id: string): Promise<void> {
    return this.serial(async () => {
      const data = await this.readForLearning();
      const proposal = data.proposals?.find((p) => p.id === id);
      if (!proposal) return;
      await this.write({ ...data, proposals: data.proposals?.filter((p) => p.id !== id),
        forgotten: [...new Set([...(data.forgotten ?? []), id, normalize(proposal.text)])] });
    });
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
   * suggestion, an "always..." note, a rule typed in My style or kept from an export), so an equivalent paused rule
   * is turned back on (PR #83 review, option A). `from`: where it was learned.
   * `check`: a checked rule. Its words must be its check's (the question showed them), and it replaces any rule
   * checking the same kind: "at most 2 words" and "at most 3 words" can't both hold.
   * `change`: what this call changed, decided in the same write, for a caller that may have to undo it (undo()). */
  async add(text: string, from?: Pick<StyleRule, 'source' | 'imported' | 'byYou'>, check?: RuleCheck): Promise<{ added: boolean; resumed: boolean; rule: StyleRule; change?: StyleChange }> {
    if (check === undefined) return this.serial(() => this.addNow(text, from));
    const c = parseCheck(check);
    const words = ruleText(c);
    if (cleanRuleText(text) !== words) throw new Error('the question does not match the rule it would save');
    return this.serial(async () => {
      const data = await this.read();
      const same = data.rules.find((r) => normalize(r.text) === normalize(words));
      if (same && JSON.stringify(same.check) === JSON.stringify(c) && !same.paused) return { added: false, resumed: false, rule: same };
      const rule: StyleRule = {
        id: randomUUID(), text: words, createdAt: new Date().toISOString(), check: c,
        ...(from?.source ? { source: from.source } : {}), ...(from?.byYou ? { byYou: true as const } : {}),
      };
      const seq = changedDirectly(data, rule);
      const rest = data.rules.filter((r) => r.check?.kind !== c.kind && normalize(r.text) !== normalize(words));
      await this.write({ ...data, rules: [...rest, rule] });
      return { added: true, resumed: false, rule, change: { id: rule.id, text: rule.text, seq, was: 'gone' } };
    });
  }

  /** Undo of a remove: the same rule back where it was, and its question no longer counts as forgotten. */
  async restore(rule: StyleRule, index: number): Promise<void> {
    return this.serial(async () => {
      const data = await this.read();
      if (data.rules.some((r) => r.id === rule.id)) return;
      const rules = [...data.rules];
      rules.splice(Math.max(0, Math.min(index, rules.length)), 0, rule);
      const asked = new Set(answersOf(rule).map(([q]) => q));
      const forgotten = (data.forgotten ?? []).filter((id) => !asked.has(id) && id !== normalize(rule.text));
      await this.write({ ...data, version: 1, rules, forgotten: forgotten.length ? forgotten : undefined });
    });
  }

  /** The saved rule equivalent to `text`, if any. */
  async find(text: string): Promise<StyleRule | undefined> {
    const n = normalize(cleanRuleText(text));
    return (await this.list()).find((r) => normalize(r.text) === n);
  }

  private async addNow(text: string, from?: Pick<StyleRule, 'source' | 'imported' | 'byYou'>): Promise<{ added: boolean; resumed: boolean; rule: StyleRule; change?: StyleChange }> {
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
    const rule: StyleRule = {
      id: randomUUID(), text: clean, createdAt: new Date().toISOString(),
      ...(from?.source ? { source: from.source } : {}), ...(from?.imported ? { imported: from.imported } : {}),
      ...(from?.byYou ? { byYou: true as const } : {}),
    };
    const seq = changedDirectly(data, rule);
    await this.write({ ...data, rules: [...data.rules, rule] });
    return { added: true, resumed: false, rule, change: { id: rule.id, text: rule.text, seq, was: 'gone' } };
  }

  /** A failed edit takes back its own change: the rule falls back to what it was before the edit, unless the person
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
      const typed = q?.payload !== undefined;
      if (!q?.id || (typed && ((q.text !== LOWERCASE_CAPTIONS && q.text !== OLD_LOWERCASE_TEXT) || !isCaptionCase(q.payload)))) throw new Error('the question does not match the rule it would save');
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
      const source = q.source ? { project: String(q.source.project ?? ''), title: String(q.source.title ?? '').slice(0, 120), version: Number(q.source.version) || 0,
        ...(typeof q.source.note === 'string' && q.source.note ? { note: q.source.note } : {}) } : undefined;
      const rule: StyleRule = { id: randomUUID(), text, createdAt: at, held: 'gone',
        ...(typed ? { payload: { kind: 'caption-case', case: 'lower' } as const } : {}),
        ...(source ? { source } : {}), ...(check ? { check } : {}) };
      say(rule);
      // My style keeps one rule per check kind, and the same words once (a plain sentence gives way to the typed or
      // checked rule). It gets a new ID: a running edit that saved that sentence undoes it by ID if it fails, and must
      // not take the approved rule with it.
      const gives = (r: StyleRule) => normalize(r.text) === normalize(text) || (typed && normalize(r.text) === normalize(OLD_LOWERCASE_TEXT))
        || (!!check && r.check?.kind === check.kind);
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
   * one: the app cannot apply "lowercase subtitles for tutorials" itself. */
  async update(id: string, patch: { text?: string; paused?: boolean }): Promise<StyleRule> {
    return this.serial(async () => {
      const data = await this.read();
      const rule = data.rules.find((r) => r.id === id);
      if (!rule) throw { code: 'NOT_FOUND', userMessage: 'That rule is not in My style any more.' };
      if (patch.text !== undefined) {
        rule.text = cleanRuleText(patch.text);
        rule.updatedAt = new Date().toISOString();
        if (rule.payload && rule.text !== LOWERCASE_CAPTIONS) delete rule.payload;
        // the same for a checked rule: "at most 2 words, except in tutorials" is not what is measured
        if (rule.check && rule.text !== checkedText(rule.check)) delete rule.check;
      }
      if (patch.paused === true) rule.paused = true;
      if (patch.paused === false) delete rule.paused;
      changedDirectly(data, rule);
      await this.write(data);
      return rule;
    });
  }

  /** Returns the removed rule and where it was, for Undo (restore); null when it was already gone. */
  /** `forget` (default true): its words are never proposed again by learning. False when the app takes back a rule
   * the AI saved on its own, which the person never refused. */
  async remove(id: string, options: { forget?: boolean } = {}): Promise<{ rule: StyleRule; index: number } | null> {
    return this.serial(async () => {
      const data = await this.read();
      const index = data.rules.findIndex((r) => r.id === id);
      if (index < 0) return null;
      const rule = data.rules[index];
      const forget = [...answered(rule), ...(options.forget === false ? [] : [normalize(rule.text)])];
      await this.write({ ...data, rules: data.rules.filter((r) => r.id !== id), ...(forget.length ? { forgotten: [...new Set([...(data.forgotten ?? []), ...forget])] } : {}) });
      return { rule, index };
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

  /** The checked rules every render in an AI edit measures. A paused rule is not checked. */
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
      : start?.before.has(r.id) ? `${r.text} (this reel already broke it before this note: leave that alone unless the note is about it)`
      : start?.unknown.has(r.id) ? `${r.text} (this reel was made before the app checked it: leave that alone unless the note is about it)`
      : `${r.text} (the app measures this on every render; a note can't finish while it fails)`;
    return rules.length ? rules.map((r) => `- ${line(r)}`).join('\n') : '(none yet)';
  }
}
