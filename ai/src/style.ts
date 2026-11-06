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

export interface StyleRule {
  id: string; text: string; createdAt: string;
  /** listed in My style, but left out of what the AI reads and of new videos */
  paused?: boolean;
  payload?: CaptionCaseRule;
  /** The engine measures this on every render (rules.ts); the rule's words are ruleText(check). */
  check?: RuleCheck;
  source?: StyleSource;
  /** Learned from another editor's export ("Learn from my past edits"): its file name. */
  imported?: { file: string };
  /** the question the person said Yes to */
  consent?: { proposal: string; at: string };
  /** When its words last changed. Pausing does not count, so a paused rule keeps its place in My style. */
  updatedAt?: string;
  /** Typed in by the person with Add a rule, not learned from a note or an export. */
  byYou?: true;
}
/** The active checked rules, and rules whose check this version can't read (saved by a newer Reel Studio):
 * those are named in every note's reply rather than skipped without a word. */
export interface StyleChecks { active: CheckedRule[]; unreadable: StyleRule[] }
/** `damaged`: the file name of a damaged My style.json kept next to this one when My style started over.
 * `forgotten`: questions whose rule was removed, so answering one again cannot bring it back, and the words of
 * removed rules and dismissed memories, which learning never proposes again: ids and normalized words, no notes. */
export interface StyleFile { version: 1; rules: StyleRule[]; damaged?: string; forgotten?: string[]; proposals?: MemoryProposal[] }

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
    | { kind: 'results'; reels: string[]; metric: string; change: number; n: number; evidence: string; trials: TrialLink[] };
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
export type Approval = { status: 'saved' | 'exists'; rule: StyleRule } | { status: 'forgotten' };

export const LOWERCASE_CAPTIONS = 'Use lowercase subtitles.';
/** The typed rule's words before the app said "subtitles": saved rules and questions still on screen may carry them. */
const OLD_LOWERCASE_TEXT = 'Use lowercase captions.';
const isCaptionCase = (x: unknown): x is CaptionCaseRule => (x as CaptionCaseRule)?.kind === 'caption-case' && (x as CaptionCaseRule).case === 'lower';

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
    return { ...rest, version: 1, rules, ...(forgotten.length ? { forgotten } : {}), ...(proposals ? { proposals } : {}) };
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
   * checking the same kind: "at most 2 words" and "at most 3 words" can't both hold. */
  async add(text: string, from?: Pick<StyleRule, 'source' | 'imported' | 'byYou'>, check?: RuleCheck): Promise<{ added: boolean; rule: StyleRule }> {
    if (check === undefined) return this.serial(() => this.addNow(text, from));
    const c = parseCheck(check);
    const words = ruleText(c);
    if (cleanRuleText(text) !== words) throw new Error('the question does not match the rule it would save');
    return this.serial(async () => {
      const data = await this.read();
      const same = data.rules.find((r) => normalize(r.text) === normalize(words));
      if (same && JSON.stringify(same.check) === JSON.stringify(c) && !same.paused) return { added: false, rule: same };
      const rule: StyleRule = {
        id: randomUUID(), text: words, createdAt: new Date().toISOString(), check: c,
        ...(from?.source ? { source: from.source } : {}), ...(from?.byYou ? { byYou: true as const } : {}),
      };
      const rest = data.rules.filter((r) => r.check?.kind !== c.kind && normalize(r.text) !== normalize(words));
      await this.write({ ...data, rules: [...rest, rule] });
      return { added: true, rule };
    });
  }

  /** Undo of a remove: the same rule back where it was, and its question no longer counts as forgotten. */
  async restore(rule: StyleRule, index: number): Promise<void> {
    return this.serial(async () => {
      const data = await this.read();
      if (data.rules.some((r) => r.id === rule.id)) return;
      const rules = [...data.rules];
      rules.splice(Math.max(0, Math.min(index, rules.length)), 0, rule);
      const forgotten = (data.forgotten ?? []).filter((id) => id !== rule.consent?.proposal && id !== normalize(rule.text));
      await this.write({ ...data, version: 1, rules, forgotten: forgotten.length ? forgotten : undefined });
    });
  }

  /** The saved rule equivalent to `text`, if any. */
  async find(text: string): Promise<StyleRule | undefined> {
    const n = normalize(cleanRuleText(text));
    return (await this.list()).find((r) => normalize(r.text) === n);
  }

  private async addNow(text: string, from?: Pick<StyleRule, 'source' | 'imported' | 'byYou'>): Promise<{ added: boolean; rule: StyleRule }> {
    const clean = cleanRuleText(text);
    const data = await this.read();
    const dup = data.rules.find((r) => normalize(r.text) === normalize(clean));
    if (dup) {
      if (dup.paused) {
        delete dup.paused;
        await this.write(data);
      }
      return { added: false, rule: dup };
    }
    const rule: StyleRule = {
      id: randomUUID(), text: clean, createdAt: new Date().toISOString(),
      ...(from?.source ? { source: from.source } : {}), ...(from?.imported ? { imported: from.imported } : {}),
      ...(from?.byYou ? { byYou: true as const } : {}),
    };
    await this.write({ ...data, rules: [...data.rules, rule] });
    return { added: true, rule };
  }

  /** The person said Yes to `p`: the rule and its consent are saved in one write. Answering the same question
   * again returns the same rule, and the question of a rule they removed cannot bring it back. */
  async approve(p: StyleProposal): Promise<Approval> {
    return this.serial(async () => {
      if (!p?.id || (p.text !== LOWERCASE_CAPTIONS && p.text !== OLD_LOWERCASE_TEXT) || !isCaptionCase(p.payload)) throw new Error('the question does not match the rule it would save');
      const data = await this.read();
      if (data.forgotten?.includes(p.id)) return { status: 'forgotten' };
      const same = data.rules.find((r) => r.consent?.proposal === p.id);
      // Edited to new words since the Yes, the rule is a sentence the AI reads, so "Saved" would promise lowercase
      // videos the app no longer makes.
      if (same) return { status: isCaptionCase(same.payload) ? 'saved' : 'exists', rule: same };
      const typed = data.rules.find((r) => isCaptionCase(r.payload));
      if (typed) return { status: 'exists', rule: typed };
      const at = new Date().toISOString();
      const fields = {
        text: LOWERCASE_CAPTIONS, payload: { kind: 'caption-case', case: 'lower' } as const,
        source: { project: String(p.source?.project ?? ''), title: String(p.source?.title ?? '').slice(0, 120), version: Number(p.source?.version) || 0 },
        consent: { proposal: p.id, at },
      };
      // The same words saved as a plain sentence give way to the typed rule. It gets a new ID: a running note
      // that saved that sentence removes it by ID if the note fails, and must not take the approved rule with it.
      const rule: StyleRule = { id: randomUUID(), createdAt: at, ...fields };
      const rest = data.rules.filter((r) => ![LOWERCASE_CAPTIONS, OLD_LOWERCASE_TEXT].some((t) => normalize(r.text) === normalize(t)));
      await this.write({ ...data, rules: [...rest, rule] });
      return { status: 'saved', rule };
    });
  }

  /** The person said No to `p`. If a Yes to it was saved before a crash cut off the reply, that rule goes,
   * and the question is remembered as answered so it cannot save again. */
  async decline(p: StyleProposal): Promise<void> {
    return this.serial(async () => {
      const data = await this.read();
      if (!data.rules.some((r) => r.consent?.proposal === p.id)) return;
      await this.write({ ...data, rules: data.rules.filter((r) => r.consent?.proposal !== p.id), forgotten: [...(data.forgotten ?? []), p.id] });
    });
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
      const asked = rule.consent?.proposal;
      const forget = [...(asked ? [asked] : []), ...(options.forget === false ? [] : [normalize(rule.text)])];
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

  /** `brokenBefore`: ids of checked rules the version being edited already broke. A note leaves those alone (editor.ts). */
  async asPromptText(brokenBefore?: Set<string>): Promise<string> {
    const rules = (await this.list()).filter((r) => !r.paused);
    const line = (r: StyleRule) => isCaptionCase(r.payload) ? CAPTION_CASE_PROMPT
      : checkedText(r.check) === null ? r.text
      : brokenBefore?.has(r.id) ? `${r.text} (this reel already broke it before this note: leave that alone unless the note is about it)`
      : `${r.text} (the app measures this on every render; a note can't finish while it fails)`;
    return rules.length ? rules.map((r) => `- ${line(r)}`).join('\n') : '(none yet)';
  }
}
