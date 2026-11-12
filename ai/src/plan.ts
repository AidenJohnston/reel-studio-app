// The Plan document (project.json `plan`, docs/plan.md): the script (the AI's draft, the creator's rewrite,
// locked to shoot), its beats, the b-roll plan as a word-to-visual table, the music and the cover idea.
// The creator and the AI agree on it before the first edit. Everything here is data in, data out: the b-roll
// the plan builds is derived from it by `syncPlan`, so the same project.json and transcript always give the
// same b-roll.
import * as path from 'node:path';
import { AIError } from './types';
import {
  Broll, Project, Transcript, TREATMENTS, Treatment, WordAnchor, anchorProblem, anchorText, findPhrase,
  hasTranscript, loadProject, loadTranscript, saveProject, wordIndex,
} from './project';

export const PLAN_SOURCES = ['own-file', 'library', 'fetched', 'card', 'animation', 'screen-recording'] as const;
export type PlanSource = (typeof PLAN_SOURCES)[number];
export const ROW_STATUSES = ['proposed', 'approved', 'rejected'] as const;
export type RowStatus = (typeof ROW_STATUSES)[number];

export interface PlanScript {
  /** the AI's draft (writeScript), kept beside the rewrite so a UI can show a redline */
  draft: string | null;
  /** the creator's own rewrite; null until they rewrite it */
  rewrite: string | null;
  /** locked to shoot: the draft and the rewrite no longer change until it is unlocked */
  locked: boolean;
  lockedAt?: string;
  /** the draft's first spoken line, and its on-screen text (writeScript) */
  hook?: string;
  onScreenText?: string[];
}
/** One row of the script plan: `| # | Line | Visual | Sound |`. */
export interface PlanBeat { line: string; visual?: string; sound?: string }
/** One row of the b-roll plan: `| id | words | visual | source | status |`, plus what only project.json keeps. */
export interface PlanRow {
  id: string;
  /** the script words it goes over; `anchor` is the same words in the transcript, once there is one */
  words?: string;
  anchor?: WordAnchor;
  /** what is on screen, in one line (a card's text) */
  visual: string;
  source: PlanSource;
  /** the file, once known (Library/... or work/assets/...) */
  asset?: string | null;
  /** how it is shown; default from the source (DEFAULT_TREATMENT) */
  treatment?: Treatment;
  status: RowStatus;
  /** seconds it should stay up: a hint for choosing the words, which decide the real length */
  hold?: number;
  note?: string;
  /** the project.broll item this row built */
  broll?: string;
}
export interface Plan {
  script: PlanScript;
  beats: PlanBeat[];
  broll: PlanRow[];
  /** the music choice and the cover idea, one line each */
  music?: string;
  cover?: string;
  /** build proposed rows as if approved (an explicit setting; absent = only approved rows are built) */
  buildProposed?: boolean;
}

/** A change the creator makes (the app's plan IPC). The AI's own changes are `proposeRows` and `aiUpdateRow`. */
export type RowFields = Partial<Pick<PlanRow, 'words' | 'anchor' | 'visual' | 'source' | 'asset' | 'treatment' | 'hold' | 'note'>>;
export type PlanChange =
  /** `draft` takes writeScript's result as it is */
  | { kind: 'script'; draft?: string | ScriptDraft | null; rewrite?: string | null }
  | { kind: 'lock'; locked: boolean }
  | { kind: 'rowStatus'; id: string; status: RowStatus }
  /** id null adds a row; a row the creator writes is approved unless `status` says otherwise */
  | { kind: 'row'; id: string | null; row: RowFields; status?: RowStatus }
  | { kind: 'details'; beats?: PlanBeat[]; music?: string | null; cover?: string | null; buildProposed?: boolean }
  | { kind: 'import'; markdown: string };
export interface ScriptDraft { hook: string; script: string; onScreenText: string[] }

/** A change the plan refuses; its message is for the creator. */
export class PlanError extends AIError {
  constructor(message: string) { super('plan_invalid', message); this.name = 'PlanError'; }
}

const ROW_ID = /^p[0-9]+$/;
const BROLL_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const WORD_ID = /^w[0-9]+$/;
export const MAX_HOLD = 60;

export function emptyPlan(): Plan {
  return { script: { draft: null, rewrite: null, locked: false }, beats: [], broll: [] };
}

/** The script as it will be shot: the rewrite, else the draft. */
export function scriptText(plan: Plan): string {
  return plan.script.rewrite ?? plan.script.draft ?? '';
}

/** True when the plan has a b-roll table: then every b-roll in the video is one of its rows. */
export function plansBroll(p: Project): boolean {
  return !!p.plan?.broll.length;
}

// ---------------------------------------------------------------- validation

const isStr = (v: unknown): v is string => typeof v === 'string';
/** Same rule as the schema's relPath: no absolute, drive, UNC or '..' paths. */
const relPathOk = (v: string) => v.length > 0 && !/^[A-Za-z]:/.test(v) && !/^[\\/]/.test(v) && !/(^|[\\/])\.\.([\\/]|$)/.test(v) && !v.includes('\0');

/** Problems with a plan's shape (mirrors project.schema.json `plan`); empty = valid. */
export function planProblems(plan: unknown): string[] {
  const out: string[] = [];
  if (!plan || typeof plan !== 'object') return ['plan must be an object'];
  const q = plan as Record<string, any>;
  const s = q.script;
  if (!s || typeof s !== 'object') out.push('plan.script must be an object');
  else {
    for (const k of ['draft', 'rewrite']) if (s[k] !== null && !isStr(s[k])) out.push(`plan.script.${k} must be text or null`);
    if (typeof s.locked !== 'boolean') out.push('plan.script.locked must be true or false');
    if (s.onScreenText !== undefined && !(Array.isArray(s.onScreenText) && s.onScreenText.every(isStr))) out.push('plan.script.onScreenText must be a list of text');
  }
  if (!Array.isArray(q.beats)) out.push('plan.beats must be a list');
  else q.beats.forEach((b: any, i: number) => { if (!b || !isStr(b.line)) out.push(`plan.beats[${i}].line must be text`); });
  if (!Array.isArray(q.broll)) return [...out, 'plan.broll must be a list'];
  const ids = new Set<string>();
  q.broll.forEach((r: any, i: number) => {
    const at = `plan.broll[${i}]`;
    if (!r || typeof r !== 'object') { out.push(`${at} must be an object`); return; }
    if (!isStr(r.id) || !ROW_ID.test(r.id)) out.push(`${at}.id must look like p1`);
    else if (ids.has(r.id)) out.push(`duplicate plan row id ${r.id}`);
    else ids.add(r.id);
    if (!isStr(r.visual)) out.push(`${at}.visual must be text`);
    if (!PLAN_SOURCES.includes(r.source)) out.push(`${at}.source must be one of ${PLAN_SOURCES.join(', ')}`);
    if (!ROW_STATUSES.includes(r.status)) out.push(`${at}.status must be one of ${ROW_STATUSES.join(', ')}`);
    if (r.anchor !== undefined && !(r.anchor && WORD_ID.test(r.anchor.from) && WORD_ID.test(r.anchor.to))) out.push(`${at}.anchor needs from/to word ids`);
    if (r.asset !== undefined && r.asset !== null && !(isStr(r.asset) && relPathOk(r.asset))) out.push(`${at}.asset must be a path inside the project or the Library`);
    if (r.treatment !== undefined && !TREATMENTS.includes(r.treatment)) out.push(`${at}.treatment must be one of ${TREATMENTS.join(', ')}`);
    if (r.hold !== undefined && !(typeof r.hold === 'number' && r.hold >= 0 && r.hold <= MAX_HOLD)) out.push(`${at}.hold must be 0 to ${MAX_HOLD} seconds`);
    if (r.broll !== undefined && !(isStr(r.broll) && BROLL_ID.test(r.broll))) out.push(`${at}.broll must be a b-roll id`);
  });
  return out;
}

function checked(plan: Plan): Plan {
  const problems = planProblems(plan);
  if (problems.length) throw new PlanError(problems.join('; '));
  return plan;
}

// ---------------------------------------------------------------- the creator's changes

const clean = (s: string) => s.replace(/\r\n?/g, '\n').trim();
const copy = (plan: Plan | undefined): Plan => (plan ? structuredClone(plan) : emptyPlan());

export function nextRowId(plan: Plan): string {
  const n = Math.max(0, ...plan.broll.map((r) => Number(r.id.slice(1)) || 0));
  return `p${n + 1}`;
}

function row(plan: Plan, id: string): PlanRow {
  const r = plan.broll.find((x) => x.id === id);
  if (!r) throw new PlanError(`no plan row ${id}; rows: ${plan.broll.map((x) => x.id).join(', ') || 'none'}`);
  return r;
}

/** Split a script into beats: one per line, or one per sentence when it is a single paragraph. */
export function splitBeats(text: string): string[] {
  const lines = clean(text).split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length !== 1) return lines;
  return lines[0].split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
}

/** Beats for `text`, keeping the visual and sound of each beat whose line is unchanged. */
function beatsFor(text: string, old: PlanBeat[]): PlanBeat[] {
  const byLine = new Map(old.map((b) => [b.line, b]));
  return splitBeats(text).map((line) => byLine.get(line) ?? { line });
}

function setFields(r: PlanRow, f: RowFields): void {
  for (const k of ['words', 'visual', 'source', 'asset', 'treatment', 'hold', 'note'] as const) {
    if (f[k] !== undefined) (r as any)[k] = typeof f[k] === 'string' && k !== 'asset' ? clean(f[k] as string) : f[k];
  }
  if (f.anchor !== undefined) r.anchor = { from: f.anchor.from, to: f.anchor.to };
  // other words: the old anchor no longer says them (syncPlan finds them again)
  else if (f.words !== undefined) delete r.anchor;
}

type Details = Omit<Extract<PlanChange, { kind: 'details' }>, 'kind'>;

/** The beats, music, cover and buildProposed, in place; an empty music or cover line removes it. */
function setDetails(plan: Plan, d: Details): void {
  if (d.beats) plan.beats = d.beats.map((b) => ({ line: clean(b.line), ...(b.visual ? { visual: clean(b.visual) } : {}), ...(b.sound ? { sound: clean(b.sound) } : {}) }));
  if (d.music !== undefined) { if (d.music) plan.music = clean(d.music); else delete plan.music; }
  if (d.cover !== undefined) { if (d.cover) plan.cover = clean(d.cover); else delete plan.cover; }
  if (d.buildProposed !== undefined) { if (d.buildProposed) plan.buildProposed = true; else delete plan.buildProposed; }
}

/** The plan after one change. Pure: throws PlanError on a change it refuses. */
export function changePlan(plan: Plan | undefined, change: PlanChange, now: string): Plan {
  const next = copy(plan);
  switch (change.kind) {
    case 'script': {
      if (next.script.locked) throw new PlanError('The script is locked to shoot. Unlock it to change it.');
      if (change.draft !== undefined) {
        const d = change.draft;
        if (d && typeof d === 'object') {
          next.script.draft = clean(d.script);
          next.script.hook = clean(d.hook);
          next.script.onScreenText = d.onScreenText.map(clean);
        } else next.script.draft = d === null ? null : clean(d);
      }
      if (change.rewrite !== undefined) next.script.rewrite = change.rewrite === null ? null : clean(change.rewrite);
      break;
    }
    case 'lock':
      if (change.locked && !scriptText(next).trim()) throw new PlanError('There is no script to lock yet.');
      next.script.locked = change.locked;
      if (change.locked) {
        next.script.lockedAt = now;
        next.beats = beatsFor(scriptText(next), next.beats);
      } else delete next.script.lockedAt;
      break;
    case 'rowStatus':
      row(next, change.id).status = change.status;
      break;
    case 'row': {
      const r = change.id === null
        ? (() => {
          const fresh: PlanRow = { id: nextRowId(next), visual: '', source: 'card', status: change.status ?? 'approved' };
          next.broll.push(fresh);
          return fresh;
        })()
        : row(next, change.id);
      setFields(r, change.row);
      if (change.id !== null && change.status) r.status = change.status;
      if (!r.visual) throw new PlanError('Say what goes on screen for this row.');
      break;
    }
    case 'details':
      setDetails(next, change);
      break;
    case 'import':
      return fromMarkdown(change.markdown, next, now);
  }
  return checked(next);
}

/**
 * The project after the creator's change: the plan changed and, when there is a transcript, the b-roll it
 * builds brought in step (an approved row with its file goes in at once, a rejected one comes out).
 */
export function applyPlanChange(p: Project, t: Transcript | null, change: PlanChange, now: string): { project: Project; unbuilt: Unbuilt[] } {
  const project = structuredClone(p);
  project.plan = changePlan(p.plan, change, now);
  if (change.kind === 'row' && change.row.anchor && t) {
    const problem = anchorProblem(wordIndex(t), change.row.anchor);
    if (problem) throw new PlanError(`anchor: ${problem}`);
  }
  return { project, unbuilt: t ? syncPlan(project, t) : [] };
}

// ---------------------------------------------------------------- plan -> b-roll

/** How a row is shown when it does not say. */
export const DEFAULT_TREATMENT: Record<PlanSource, Treatment> = {
  'own-file': 'card-above-head', library: 'card-above-head', fetched: 'card-above-head',
  'screen-recording': 'phone-card', card: 'text-pop', animation: 'animation',
};
/** Why an approved row is not in the video yet. */
export interface Unbuilt { id: string; why: 'needs-file' | 'words-not-found' }

export function builds(plan: Plan, r: PlanRow): boolean {
  return r.status === 'approved' || (r.status === 'proposed' && plan.buildProposed === true);
}

function freeBrollId(p: Project, wanted: string): string {
  const taken = new Set(p.broll.map((b) => b.id));
  let id = wanted;
  for (let n = 1; taken.has(id); n++) id = `${wanted}-${n}`;
  return id;
}

/**
 * Brings project.broll in step with the plan, in place: each row that builds (approved, or proposed with
 * `buildProposed`) and has its words and file is one b-roll item; a row that does not build has none.
 * Rows anchor on transcript word ids the first time their words are found (kept words first). Items no
 * row built are left alone. Deterministic: rows in order, items updated in place or appended. Returns the
 * building rows still missing something.
 */
export function syncPlan(p: Project, t: Transcript): Unbuilt[] {
  const plan = p.plan;
  if (!plan) return [];
  const idx = wordIndex(t);
  const unbuilt: Unbuilt[] = [];
  for (const r of plan.broll) {
    if (r.anchor && anchorProblem(idx, r.anchor)) delete r.anchor;
    if (!r.anchor && r.words) {
      const found = findPhrase(t, r.words, p.cut.keep);
      if (found) r.anchor = found;
    }
    const at = r.broll ? p.broll.findIndex((b) => b.id === r.broll) : -1;
    const why: Unbuilt['why'] | null = !r.anchor ? 'words-not-found'
      : r.source !== 'card' && !r.asset ? 'needs-file' : null;
    if (!builds(plan, r) || why) {
      if (at >= 0) p.broll.splice(at, 1);
      delete r.broll;
      if (builds(plan, r) && why) unbuilt.push({ id: r.id, why });
      continue;
    }
    const anchor = { from: r.anchor!.from, to: r.anchor!.to };
    const treatment = r.treatment ?? DEFAULT_TREATMENT[r.source];
    const asset = r.asset ?? null;
    if (at >= 0) {
      // the look a note gave it (side, tilt, size) stays; a card always says the row's visual
      const cur = p.broll[at];
      p.broll[at] = { ...cur, anchor, treatment, asset, ...(r.source === 'card' ? { params: { ...cur.params, text: r.visual } } : {}) };
    } else {
      const id = freeBrollId(p, r.id);
      p.broll.push({ id, anchor, leadIn: 0.13, treatment, asset, params: r.source === 'card' ? { text: r.visual } : {} });
      r.broll = id;
    }
  }
  return unbuilt;
}

/** What a row's source is, from the b-roll item it records. */
function sourceOf(b: Broll): PlanSource {
  if (b.treatment === 'animation') return 'animation';
  if (!b.asset) return 'card';
  if (b.asset.startsWith('Library/')) return 'library';
  if (/^work[\\/]assets[\\/]attach-/.test(b.asset)) return 'own-file';
  return 'fetched';
}

/**
 * After a b-roll tool changed project.broll in a planned project (a note), the plan follows it, in place, so
 * nothing is in the video without a row: an item no row built becomes an approved row (the note asked for
 * it), a row's item that changed carries its words, file and look back to the row, and a row whose item was
 * removed is rejected.
 */
export function followBroll(p: Project, t: Transcript, note = 'Added for a note.'): void {
  const plan = p.plan;
  if (!plan?.broll.length) return;
  const items = new Map(p.broll.map((b) => [b.id, b]));
  const linked = new Set<string>();
  for (const r of plan.broll) {
    if (!r.broll) continue;
    const b = items.get(r.broll);
    if (!b) { r.status = 'rejected'; delete r.broll; continue; }
    linked.add(b.id);
    if (!r.anchor || r.anchor.from !== b.anchor.from || r.anchor.to !== b.anchor.to) {
      r.anchor = { from: b.anchor.from, to: b.anchor.to };
      r.words = anchorText(t, b.anchor);
    }
    if ((b.asset ?? null) !== (r.asset ?? null)) r.asset = b.asset ?? null;
    if (b.treatment !== (r.treatment ?? DEFAULT_TREATMENT[r.source])) r.treatment = b.treatment as Treatment;
    if (r.source === 'card' && typeof b.params?.text === 'string') r.visual = b.params.text;
  }
  for (const b of p.broll) {
    if (linked.has(b.id)) continue;
    const text = typeof b.params?.text === 'string' ? b.params.text : null;
    plan.broll.push({
      id: nextRowId(plan), words: anchorText(t, b.anchor), anchor: { from: b.anchor.from, to: b.anchor.to },
      visual: text ?? (b.asset ? path.basename(b.asset) : b.treatment), source: sourceOf(b), asset: b.asset ?? null,
      treatment: b.treatment as Treatment, status: 'approved', note, broll: b.id,
    });
  }
}

// ---------------------------------------------------------------- the AI's changes

export interface ProposedRow { words: string; anchor?: WordAnchor; visual: string; source: PlanSource; asset?: string; treatment?: Treatment; hold?: number; note?: string }
export interface Proposal { beats?: PlanBeat[]; broll: ProposedRow[]; music?: string; cover?: string }

/**
 * The AI's proposal, in place: its earlier proposed rows (and anything they built) are replaced by the new
 * ones, while rows the creator approved or rejected stay as they are. New rows are proposed, never approved.
 */
export function proposeRows(p: Project, proposal: Proposal): void {
  const plan = copy(p.plan);
  const dropped = new Set(plan.broll.filter((r) => r.status === 'proposed' && r.broll).map((r) => r.broll!));
  p.broll = p.broll.filter((b) => !dropped.has(b.id));
  plan.broll = plan.broll.filter((r) => r.status !== 'proposed');
  for (const r of proposal.broll) {
    const fresh: PlanRow = { id: nextRowId(plan), visual: '', source: r.source, status: 'proposed' };
    setFields(fresh, r);
    plan.broll.push(fresh);
  }
  // no beats proposed: the ones there are (a locked script's) stay
  setDetails(plan, { ...(proposal.beats?.length ? { beats: proposal.beats } : {}), music: proposal.music, cover: proposal.cover });
  p.plan = checked(plan);
}

/**
 * The AI's change to one row, in place. A new row (no id) is proposed for the creator to approve. On a row
 * the creator approved the AI only supplies what building it needs (words in the transcript, the file, the
 * look); what it shows was approved as it is, and approval is never the AI's to give.
 */
export function aiUpdateRow(p: Project, id: string | null, f: RowFields): string {
  const plan = copy(p.plan);
  if (id === null) {
    const fresh: PlanRow = { id: nextRowId(plan), visual: '', source: f.source ?? 'card', status: 'proposed' };
    setFields(fresh, f);
    if (!fresh.visual) throw new PlanError('a new row needs visual');
    plan.broll.push(fresh);
    p.plan = checked(plan);
    return fresh.id;
  }
  const r = row(plan, id);
  if (r.status !== 'proposed') {
    const fixed = (['words', 'visual', 'source'] as const).filter((k) => f[k] !== undefined && f[k] !== r[k]);
    if (fixed.length) throw new PlanError(`${id} is ${r.status} by the creator as it is: its ${fixed.join(' and ')} cannot change. Give only anchor, asset, treatment or note.`);
  }
  setFields(r, f);
  p.plan = checked(plan);
  return id;
}

// ---------------------------------------------------------------- the first edit

export interface PlannedEdit {
  /** the plan has a b-roll table: the edit builds only its rows */
  planned: boolean;
  /** appended to the first edit's task */
  task: string;
  /** appended to the first edit's summary */
  summaryTail: string;
}

const quoteRow = (r: PlanRow) => `${r.id} "${r.words ?? ''}": ${r.visual} (${r.source}${r.asset ? `, ${r.asset}` : ''}${r.hold ? `, about ${r.hold} s` : ''})`;

/**
 * Before the first edit: places the plan's building rows as b-roll (saved to project.json) and says what
 * the AI still has to do. Without a b-roll table the first edit is unchanged. Nothing approved (and no
 * `buildProposed`): the edit gets no b-roll and its summary asks the creator to approve rows.
 */
export async function prepareFirstEdit(projectDir: string): Promise<PlannedEdit> {
  const none: PlannedEdit = { planned: false, task: '', summaryTail: '' };
  const p = await loadProject(projectDir);
  const plan = p.plan;
  if (!plan || !hasTranscript(projectDir, p)) return none;
  const lines: string[] = [];
  if (plan.music) lines.push(`- Music the creator chose: ${plan.music}. Pick the song that fits it (list_library, choose_music).`);
  if (plan.cover) lines.push(`- Cover idea: ${plan.cover}. Pick the cover frame and its text to match it.`);
  if (!plan.broll.length) return lines.length ? { ...none, task: `\n\n## The creator's plan\n${lines.join('\n')}` } : none;
  const t = await loadTranscript(projectDir, p);
  const before = JSON.stringify(p);
  const unbuilt = syncPlan(p, t);
  if (JSON.stringify(p) !== before) await saveProject(projectDir, p);
  const placed = plan.broll.filter((r) => r.broll);
  const needFile = unbuilt.filter((u) => u.why === 'needs-file').map((u) => row(plan, u.id));
  const notFound = unbuilt.filter((u) => u.why === 'words-not-found').map((u) => row(plan, u.id));
  const waiting = plan.broll.filter((r) => !builds(plan, r) && r.status === 'proposed').length;
  lines.unshift(
    '- The b-roll is planned: only the plan\'s rows go in the video, so skip the hook-title and b-roll steps above except for what is listed here. add_broll and remove_broll are not available; update_broll may still adjust how a placed row looks (a hook-title card: params.style "label").',
    placed.length ? `- Already placed: ${placed.map(quoteRow).join('; ')}.` : '- No row is placed yet.',
  );
  if (needFile.length) lines.push(`- Rows that still need a file: ${needFile.map(quoteRow).join('; ')}. For each, find a file that shows exactly that (list_library, search_images then fetch_image, capture_website, or make_animation for an animation row), then update_plan_row with its id and the asset. If nothing fits, leave it and say so.`);
  if (notFound.length) lines.push(`- Rows whose words are not in the transcript: ${notFound.map(quoteRow).join('; ')}. If the speaker says it in other words, update_plan_row with its id and that anchor; if not, leave it.`);
  if (waiting) lines.push(`- ${waiting} more row${waiting === 1 ? ' is' : 's are'} waiting for the creator's approval: do not build ${waiting === 1 ? 'it' : 'them'}. You may propose a missing visual with update_plan_row (id null); it waits for approval too.`);
  const approved = plan.broll.some((r) => builds(plan, r));
  return {
    planned: true,
    task: `\n\n## The creator's plan\n${lines.join('\n')}`,
    summaryTail: approved ? '' : ' I left the pictures out: no row of your b-roll plan is approved yet. Approve the ones you want and they go in.',
  };
}

// ---------------------------------------------------------------- markdown

const SOURCE_WORDS: Record<PlanSource, string> = {
  'own-file': 'own file', library: 'library', fetched: 'fetched', card: 'card', animation: 'animation', 'screen-recording': 'screen recording',
};
const LOCKED_LINE = 'Locked to shoot.';
const BUILD_PROPOSED_LINE = 'Proposed rows are built too.';

const cell = (s: string | undefined) => (s ?? '').replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\n/g, '<br>');
const uncell = (s: string) => s.trim().replace(/<br\s*\/?>/gi, '\n').replace(/\\([\\|])/g, '$1');
/** A text block's lines starting with '#' would read as headings: escaped as '\#'. */
const block = (s: string) => s.split('\n').map((l) => (/^\\*#/.test(l) ? `\\${l}` : l)).join('\n');
const unblock = (s: string) => s.split('\n').map((l) => (/^\\+#/.test(l) ? l.slice(1) : l)).join('\n').trim();

/**
 * The plan as markdown: the script, the script plan (`| # | Line | Visual | Sound |`), the b-roll plan
 * (`| id | words | visual | source | status |`), the music and the cover. What the tables have no column for
 * (anchors, files, holds, notes) stays in project.json; `fromMarkdown` onto the same plan keeps it.
 */
export function toMarkdown(plan: Plan): string {
  const out: string[] = ['# Plan', '', '## Script', ''];
  const s = plan.script;
  if (s.locked) out.push(LOCKED_LINE, '');
  if (s.hook) out.push('### Hook', '', block(s.hook), '');
  if (s.draft !== null) out.push('### Draft', '', block(s.draft), '');
  if (s.rewrite !== null) out.push('### Rewrite', '', block(s.rewrite), '');
  if (s.onScreenText?.length) out.push('### On-screen text', '', ...s.onScreenText.map((x) => `- ${x.replace(/\n/g, ' ')}`), '');
  out.push('## Beats', '', '| # | Line | Visual | Sound |', '|---|---|---|---|');
  plan.beats.forEach((b, i) => out.push(`| ${i + 1} | ${cell(b.line)} | ${cell(b.visual)} | ${cell(b.sound)} |`));
  out.push('', '## B-roll', '');
  if (plan.buildProposed) out.push(BUILD_PROPOSED_LINE, '');
  out.push('| id | words | visual | source | status |', '|---|---|---|---|---|');
  for (const r of plan.broll) out.push(`| ${r.id} | ${cell(r.words)} | ${cell(r.visual)} | ${SOURCE_WORDS[r.source]} | ${r.status} |`);
  out.push('');
  if (plan.music) out.push('## Music', '', block(plan.music), '');
  if (plan.cover) out.push('## Cover', '', block(plan.cover), '');
  return out.join('\n');
}

/** Sections by heading (`## X` and, inside Script, `### X`), case-insensitive. */
function sections(md: string, level: '##' | '###'): Map<string, string> {
  const out = new Map<string, string>();
  let name: string | null = null; let buf: string[] = [];
  const flush = () => { if (name !== null) out.set(name, buf.join('\n')); };
  for (const line of md.replace(/\r\n?/g, '\n').split('\n')) {
    const m = new RegExp(`^${level} +(.+?)\\s*$`).exec(line);
    if (m) { flush(); name = m[1].toLowerCase(); buf = []; } else buf.push(line);
  }
  flush();
  return out;
}

/** The rows of the first markdown table in `text`, as {column name: cell}. */
function table(text: string): Record<string, string>[] {
  const rows = text.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('|'));
  if (!rows.length) return [];
  const split = (l: string) => l.replace(/^\|/, '').replace(/(?<!\\)\|$/, '').split(/(?<!\\)\|/).map(uncell);
  const head = split(rows[0]).map((h) => h.toLowerCase());
  return rows.slice(1).filter((l) => !/^\|[\s:|-]+\|?$/.test(l)).map((l) => {
    const cells = split(l);
    return Object.fromEntries(head.map((h, i) => [h, cells[i] ?? '']));
  });
}

const word = (s: string) => s.trim().toLowerCase().replace(/[\s_]+/g, '-');
function parseSource(s: string, at: string): PlanSource {
  const w = word(s);
  const found = PLAN_SOURCES.find((x) => x === w) ?? (w === 'own' || w === 'file' ? 'own-file' : w === 'screen' ? 'screen-recording' : undefined);
  if (!found) throw new PlanError(`${at}: source "${s}" is not one of ${Object.values(SOURCE_WORDS).join(', ')}`);
  return found;
}
function parseStatus(s: string, at: string): RowStatus {
  const w = word(s) || 'proposed';
  if (!ROW_STATUSES.includes(w as RowStatus)) throw new PlanError(`${at}: status "${s}" is not one of ${ROW_STATUSES.join(', ')}`);
  return w as RowStatus;
}

/**
 * A plan read from markdown (`toMarkdown`'s format; a table written elsewhere works too, by its column names).
 * Read onto `base`: rows keep what the table has no column for, a row whose words changed is anchored again,
 * and a base row missing from the table is rejected, never deleted. Sections the markdown leaves out stay as
 * in `base`. A locked script cannot be changed by an import, only locked or unlocked.
 */
export function fromMarkdown(md: string, base: Plan = emptyPlan(), now = new Date().toISOString()): Plan {
  const plan = copy(base);
  const top = sections(md, '##');
  const script = top.get('script');
  if (script !== undefined) {
    const sub = sections(script, '###');
    const locked = script.split('\n').some((l) => l.trim() === LOCKED_LINE);
    const next: PlanScript = {
      draft: sub.has('draft') ? unblock(sub.get('draft')!) : null,
      rewrite: sub.has('rewrite') ? unblock(sub.get('rewrite')!) : null,
      locked,
      ...(sub.has('hook') ? { hook: unblock(sub.get('hook')!) } : {}),
      ...(sub.has('on-screen text') ? { onScreenText: sub.get('on-screen text')!.split('\n').map((l) => /^\s*[-*]\s+(.*)$/.exec(l)?.[1]?.trim()).filter((x): x is string => !!x) } : {}),
    };
    const textOf = (s: PlanScript) => JSON.stringify([s.draft, s.rewrite, s.hook ?? null, s.onScreenText ?? []]);
    if (base.script.locked && textOf(next) !== textOf(base.script)) throw new PlanError('The script is locked to shoot. Unlock it before importing a different script.');
    if (locked) next.lockedAt = base.script.locked ? base.script.lockedAt : now;
    plan.script = next;
  }
  const beats = top.get('beats');
  if (beats !== undefined) {
    plan.beats = table(beats).filter((b) => (b.line ?? '').trim()).map((b) => ({
      line: b.line, ...(b.visual ? { visual: b.visual } : {}), ...(b.sound ? { sound: b.sound } : {}),
    }));
  }
  const broll = top.get('b-roll');
  if (broll !== undefined) {
    if (broll.split('\n').some((l) => l.trim() === BUILD_PROPOSED_LINE)) plan.buildProposed = true; else delete plan.buildProposed;
    const old = new Map(base.broll.map((r) => [r.id, r]));
    const rows: PlanRow[] = [];
    table(broll).forEach((c, i) => {
      const at = `b-roll row ${i + 1}`;
      if (!(c.visual ?? '').trim()) throw new PlanError(`${at}: say what goes on screen (the visual column)`);
      const raw = (c.id ?? '').trim();
      const id = ROW_ID.test(raw) ? raw : /^[0-9]+$/.test(raw) ? `p${raw}` : '';
      if (raw && !id) throw new PlanError(`${at}: id "${raw}" must look like p1`);
      const prev = id ? old.get(id) : undefined;
      const r: PlanRow = prev ? { ...prev } : { id, visual: '', source: 'card', status: 'proposed' };
      const words = (c.words ?? '').trim();
      if (words !== (prev?.words ?? '')) { if (words) r.words = words; else delete r.words; delete r.anchor; }
      r.visual = c.visual;
      r.source = parseSource(c.source ?? '', at);
      r.status = parseStatus(c.status ?? '', at);
      rows.push(r);
    });
    // rows with no id get the next free ones, after every id the table and the base use
    const used = { ...plan, broll: [...base.broll, ...rows.filter((r) => r.id)] };
    for (const r of rows) if (!r.id) { r.id = nextRowId(used); used.broll.push(r); }
    const seen = new Set(rows.map((r) => r.id));
    for (const r of base.broll) if (!seen.has(r.id)) rows.push({ ...r, status: 'rejected' });
    plan.broll = rows;
  }
  for (const [key, field] of [['music', 'music'], ['cover', 'cover']] as const) {
    if (!top.has(key)) continue;
    const text = unblock(top.get(key)!);
    if (text) plan[field] = text; else delete plan[field];
  }
  return checked(plan);
}

// ---------------------------------------------------------------- on disk (the app's plan IPC)

export interface PlanView {
  plan: Plan | null;
  /** the building rows not in the video yet, and why */
  unbuilt: Unbuilt[];
}

/** The plan as saved, and which of its approved rows are not in the video yet. Reads only. */
export async function readPlan(projectDir: string): Promise<PlanView> {
  const p = await loadProject(projectDir);
  if (!p.plan) return { plan: null, unbuilt: [] };
  const t = hasTranscript(projectDir, p) ? await loadTranscript(projectDir, p) : null;
  return { plan: p.plan, unbuilt: t ? syncPlan(structuredClone(p), t) : [] };
}

/** Saves the creator's change (applyPlanChange) to project.json. The caller is the project's only writer
 * meanwhile (the app runs it as a held edit). */
export async function updatePlan(projectDir: string, change: PlanChange, now = new Date().toISOString()): Promise<PlanView> {
  const p = await loadProject(projectDir);
  const t = hasTranscript(projectDir, p) ? await loadTranscript(projectDir, p) : null;
  const { project, unbuilt } = applyPlanChange(p, t, change, now);
  await saveProject(projectDir, project);
  return { plan: project.plan!, unbuilt };
}
