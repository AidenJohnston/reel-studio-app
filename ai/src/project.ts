// project.json (schemaVersion 1) types + load/save/validate + word-anchor helpers.
// Mirrors docs/architecture.md section 3 and engine/reelengine/schema/project.schema.json. Optional fields
// only; unknown fields are preserved on save so the engine and the app can extend the file.
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import { CUT_STYLES, CutPreset } from './cut-style';

export interface Format { width: number; height: number; fps: number }
export interface Source {
  id: string; path: string; duration?: number; fps?: number; width?: number; height?: number; rotation?: number;
  /** the take is mirrored (front camera: on-screen text reads backwards); the engine flips the picture. Absent = false */
  mirror?: boolean;
  hasAudio?: boolean;
  capturedAt?: string;
  /** what the engine saw at import (mirror_detect.py) and, in `answer`, what the user then chose in the chat */
  mirrorCheck?: { verdict: string; answer?: 'flipped' | 'kept' | 'undone' };
  [k: string]: unknown;
}
export interface Join { transition: 'hard' | 'j' | 'l' | 'smash' | 'match' | 'flash' | 'action'; frames: number }
export const JOIN_TRANSITIONS = ['hard', 'j', 'l', 'smash', 'match', 'flash', 'action'] as const;
/** Joins whose cut the engine searches for, and refuses where it finds none (engine/reelengine/match.py). */
export const SEARCHED_JOINS: readonly string[] = ['match', 'action'];
export interface WordAnchor { from: string; to: string }
export interface CutRange extends WordAnchor { join?: Join }
/** A clip from any source, played whole (multi-source): source seconds, start included and end excluded. */
export interface ClipItem { clip: string; source: string; in: number; out: number }
export type CutItem = CutRange | ClipItem;
export interface Word { id: string; source: string; s: number; e: number; w: string; [k: string]: unknown }
export interface Transcript { words: Word[]; language?: string; [k: string]: unknown }

export interface CaptionStyle {
  preset?: string; font?: string; size?: number; maxWords?: number;
  case?: 'upper' | 'lower' | 'as-is' | 'title' | string; color?: string; outline?: number; outlineColor?: string; shadow?: number; box?: boolean; position?: number;
  [k: string]: unknown;
}
/** at: a fix the person made to that one word in the Subtitles list (engine captions.py apply_corrections). */
export interface CaptionCorrection { from: string; to: string; at?: string; through?: string }
/** vocabulary: names/jargon the user or the AI supplies; the engine respells sound-alikes to them after
 * transcription (engine/reelengine/vocab.py). */
export interface Captions { enabled: boolean; style: CaptionStyle; corrections: CaptionCorrection[]; hidden?: WordAnchor[]; vocabulary?: string[]; [k: string]: unknown }

export type MusicLevel = 'under-voice' | 'quiet' | 'loud-intro';
export interface MusicAutomation { fromWord: string; toWord: string; gainDb: number }
/** The song's beats, stored when it is chosen: whole frames of SONG time at fps, the song's length, and the
 * SHA-256 of the file they were measured on (engine beats.py ignores a grid measured on another file). */
export interface BeatGrid { fps: number; frames: number[]; seconds: number; sha256: string }
export const BEAT_KINDS = ['cuts', 'zooms', 'broll'] as const;
export type BeatKind = (typeof BEAT_KINDS)[number];
/** A line the music drops out for: gone just before `from`, back on the first beat after `to`. */
export interface MusicDrop { from: string; to: string }
/** The frozen copy of the Library song `track` names. It counts only while `track` still equals
 * music.track: the app switches songs by rewriting track and keeps every other field. */
export interface MusicFrozen { track: string; path: string }
export interface Music {
  enabled: boolean; track: string | null; startAt: number; level: MusicLevel | string;
  automation: MusicAutomation[]; fadeOut: number; frozen?: MusicFrozen;
  beats?: BeatGrid; onBeat?: BeatKind[]; drops?: MusicDrop[]; [k: string]: unknown;
}

export const TREATMENTS = [
  'card-above-head', 'full-frame', 'phone-card', 'side-card', 'text-pop', 'text-behind', 'post-wall', 'icon-wall', 'split-top',
  'animation', 'title-card', 'panel-card', 'logo-row', 'phone-row', 'circle-callout', 'wide-clip', 'receipt',
] as const;
/** Treatments that show params.items (several pictures) rather than one asset. */
export const ITEM_TREATMENTS: readonly string[] = ['post-wall', 'icon-wall', 'logo-row', 'phone-row'];
/** Treatments that can show words alone, with no picture. */
export const TEXT_TREATMENTS: readonly string[] = ['text-pop', 'text-behind', 'title-card', 'panel-card'];
export type Treatment = (typeof TREATMENTS)[number];

export interface BrollParams { tilt?: number | null; scale?: number | null; text?: string | null; [k: string]: unknown }
export interface Broll {
  id: string; anchor: WordAnchor; leadIn?: number; treatment: Treatment | string;
  asset: string | null; assets?: string[]; params: BrollParams; [k: string]: unknown;
}
export type ZoomKind = 'punch' | 'snap' | 'drift';
export interface Zoom { anchor: WordAnchor; scale?: number; kind?: ZoomKind; style?: 'snap'; accentGroup?: string; [k: string]: unknown }
/** A built-in sound effect (engine/reelengine/sfx) whose hit lands on one moment: a word's start, a b-roll's
 * appearance, or the cut into the kept range that starts with that word. */
export interface Sfx { at: { word: string } | { broll: string } | { cut: string }; sound: string; gainDb?: number }
export interface Cover { atSourceTime: number; source: string; text: string | null; [k: string]: unknown }
export interface Post { caption: string; hashtags: string[]; keywords: string[]; [k: string]: unknown }
/** One thing an edit changed (engine project.net_changes): `kind` is the project.json path. */
export interface EditFact { kind: string; field?: string; id?: string; before: unknown; after: unknown }
/** What the render that made a version changed since the version before it (docs/schema-changes.md). */
export interface EditReceipt { jobId: string | null; renderId: string; version: number; facts: EditFact[] }
export interface NoteEntry {
  /** the version this note made; absent for a note whose edit ended where it started (docs/schema-changes.md) */
  version?: number; text: string; applied: string[]; at: string;
  /** files the user attached to this note (`work/assets/attach-*`), 0.1.2 */
  attachments?: string[];
  /** the app's job id for this note, and what the app still has to tell the user once it is saved:
   * after a crash right after saving, the app finds the note here and finishes that (app store.ts) */
  id?: string;
  reply?: string;
  styleRulesAdded?: string[];
  styleSuggestions?: string[];
  receipt?: EditReceipt;
}

export interface CutStyle { preset: CutPreset; seed: number }

export interface Project {
  schemaVersion: 1;
  id: string; title: string; slug: string; createdAt: string; updatedAt: string; version: number;
  format: Format;
  cutStyle?: CutStyle;
  /** true: sound effects and picture starts land on the song's beats; false: never, even at the hyper pace; absent: the pace decides */
  beatAccents?: boolean;
  exposure?: number;
  sources: Source[];
  transcript: { file: string; language?: string };
  cut: { keep: CutItem[]; gapCap: number; minSaving?: number; [k: string]: unknown };
  captions: Captions;
  music: Music;
  broll: Broll[];
  zooms: Zoom[];
  /** absent = no sound effects */
  sfx?: Sfx[];
  /** reverbThrow: an echo tail on the last word (engine music.reverb_throw); absent = none */
  voice?: { reverbThrow?: boolean };
  cover: Cover;
  post: Post;
  notes: NoteEntry[];
  [k: string]: unknown;
}

export const PROJECT_FILE = 'project.json';

export class ProjectError extends Error {
  constructor(message: string, public readonly problems: string[] = []) { super(message); this.name = 'ProjectError'; }
}

/** Fill any missing sections with defaults (does not overwrite present values). */
export function withDefaults(p: Partial<Project>): Project {
  const now = new Date().toISOString();
  const sources = p.sources ?? [];
  return {
    ...p,
    schemaVersion: 1,
    id: p.id ?? randomUUID(),
    title: p.title ?? 'Untitled video',
    slug: p.slug ?? 'untitled-video',
    createdAt: p.createdAt ?? now,
    updatedAt: p.updatedAt ?? now,
    version: p.version ?? 0,
    format: p.format ?? { width: 1080, height: 1920, fps: 30 },
    sources,
    transcript: p.transcript ?? { file: 'work/transcript.json', language: 'en' },
    cut: { keep: [], gapCap: 0.25, minSaving: 0.08, ...(p.cut ?? {}) },
    captions: {
      enabled: true,
      corrections: [],
      ...(p.captions ?? {}),
      style: {
        // The proven default look; mirrors engine/reelengine/project.py DEFAULT_CAPTION_STYLE.
        preset: 'bold-lower', font: 'Montserrat SemiBold', size: 105, maxWords: 3,
        case: 'upper', color: '#FFFFFF', outline: 8, outlineColor: '#000000', shadow: 0, position: 0.75,
        ...(p.captions?.style ?? {}),
      },
    },
    music: {
      enabled: true, track: null, startAt: 0, level: 'under-voice', automation: [], fadeOut: 1.5, ...(p.music ?? {}),
    },
    broll: p.broll ?? [],
    zooms: p.zooms ?? [],
    cover: p.cover ?? { atSourceTime: 0, source: sources[0]?.id ?? 's1', text: null },
    post: { caption: '', hashtags: [], keywords: [], ...(p.post ?? {}) },
    notes: p.notes ?? [],
  } as Project;
}

/**
 * The lowest the centre of a caption can sit, as a fraction of the height, with its box still above Instagram's
 * caption and username (engine/reelengine/verify.py IG_BOTTOM_FRAC, the bottom 19%). The box is
 * captions.render_ass's for a cue wrapped to two lines, the most `fit` makes: twice the size plus the outline
 * (box padding for a box) top and bottom, scaled from 1080 wide, and a pixel more because the engine's cue
 * report rounds it. Which cues wrap is only known at render time, so every position assumes two lines.
 */
export function lowestCaptionPosition(format: Format, style: CaptionStyle): number {
  const outline = style.box ? Math.max(style.outline ?? 8, 18) : (style.outline ?? 8);
  const half = ((2 * (style.size ?? 105) + 2 * outline) * format.width) / 1080 / 2;
  return Math.floor(((0.81 * format.height - half - 1) / format.height) * 100) / 100;
}

/** The plain-words warning when captions reach Instagram's caption and username, or null when they stay clear. */
export function captionsUnderInstagram(format: Format, style: CaptionStyle): string | null {
  const lowest = lowestCaptionPosition(format, style);
  const position = style.position ?? 0.75;
  if (position <= lowest) return null;
  return `At position ${position} and size ${style.size ?? 105}, a caption that wraps to two lines reaches under Instagram's caption and username, so it is partly hidden on Instagram. At this size, ${lowest} or higher stays clear.`;
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === 'string';

/** Structural validation. Returns a list of problems (empty = valid). Pass the transcript to check anchors. */
export function validateProject(p: unknown, transcript?: Transcript): string[] {
  const out: string[] = [];
  if (!p || typeof p !== 'object') return ['project is not an object'];
  const q = p as Record<string, any>;
  if (q.schemaVersion !== 1) out.push('schemaVersion must be 1');
  for (const k of ['id', 'title', 'slug']) if (!isStr(q[k])) out.push(`${k} must be a string`);
  if (q.cutStyle !== undefined) {
    if (!q.cutStyle || typeof q.cutStyle !== 'object' || !Object.prototype.hasOwnProperty.call(q.cutStyle, 'preset') || !Object.prototype.hasOwnProperty.call(q.cutStyle, 'seed')) out.push('cutStyle needs preset and seed');
    else if (typeof q.cutStyle.preset !== 'string' || !Object.prototype.hasOwnProperty.call(CUT_STYLES, q.cutStyle.preset)) out.push('cutStyle.preset must be clean, standard, hyper, or punchline');
    else if (!Number.isInteger(q.cutStyle.seed)) out.push('cutStyle.seed must be an integer');
  }
  if (q.beatAccents !== undefined && typeof q.beatAccents !== 'boolean') out.push('beatAccents must be true or false');
  if (!q.format || !isNum(q.format.width) || !isNum(q.format.height) || !isNum(q.format.fps)) out.push('format needs width/height/fps');
  // ffmpeg exposure accepts -3 to +3 stops, equivalent to these linear multipliers.
  if (q.exposure !== undefined && (!isNum(q.exposure) || q.exposure < 0.125 || q.exposure > 8)) out.push('exposure must be a number between 0.125 and 8');
  if (!Array.isArray(q.sources)) out.push('sources must be an array');
  if (!q.cut || !Array.isArray(q.cut.keep)) out.push('cut.keep must be an array');
  else if (!isNum(q.cut.gapCap) || q.cut.gapCap < 0) out.push('cut.gapCap must be a number >= 0');
  if (Array.isArray(q.cut?.keep)) q.cut.keep.forEach((a: any, i: number) => {
    const problem = joinProblem(a?.join, i, i > 0 ? q.cut.keep[i - 1] : undefined);
    if (problem) out.push(`cut.keep[${i}].join: ${problem}`);
  });
  if (!q.captions || typeof q.captions.enabled !== 'boolean') out.push('captions.enabled must be a boolean');
  if (q.captions?.hidden != null && !Array.isArray(q.captions.hidden)) out.push('captions.hidden must be an array');
  if (!q.music || typeof q.music.enabled !== 'boolean') out.push('music.enabled must be a boolean');
  if (!Array.isArray(q.broll)) out.push('broll must be an array');
  if (!Array.isArray(q.zooms)) out.push('zooms must be an array');
  if (q.post) {
    if (!Array.isArray(q.post.hashtags)) out.push('post.hashtags must be an array');
    else if (q.post.hashtags.length !== 0 && q.post.hashtags.length !== 5) out.push('post.hashtags must have exactly 5 entries');
  }
  if (transcript && out.length === 0) {
    const idx = wordIndex(transcript);
    const check = (a: any, where: string) => {
      const problem = anchorProblem(idx, a);
      if (problem) out.push(`${where}: ${problem}`);
    };
    const clipIds = new Set<string>();
    q.cut.keep.forEach((a: CutItem, i: number) => {
      if ('clip' in a) {
        const problem = clipProblem(q.sources, a);
        if (problem) out.push(`cut.keep[${i}]: ${problem}`);
        if (!/^c[0-9]+$/.test(a.clip) || clipIds.has(a.clip)) out.push(`cut.keep[${i}]: invalid or duplicate clip id`);
        clipIds.add(a.clip);
      } else check(a, `cut.keep[${i}]`);
    });
    q.broll.forEach((b: any, i: number) => check(b.anchor, `broll[${i}] (${b.id})`));
    q.zooms.forEach((z: any, i: number) => check(z.anchor, `zooms[${i}]`));
    (q.music?.automation ?? []).forEach((m: any, i: number) => check({ from: m.fromWord, to: m.toWord }, `music.automation[${i}]`));
    (q.music?.drops ?? []).forEach((d: any, i: number) => check(d, `music.drops[${i}]`));
    (q.sfx ?? []).forEach((e: any, i: number) => {
      const w = e.at?.word ?? e.at?.cut;
      if (w) check({ from: w, to: w }, `sfx[${i}]`);
    });
    (q.captions.hidden ?? []).forEach((a: any, i: number) => check(a, `captions.hidden[${i}]`));
    const ids = new Set<string>();
    for (const b of q.broll) { if (ids.has(b.id)) out.push(`duplicate broll id ${b.id}`); ids.add(b.id); }
  }
  return out;
}

// ---------------------------------------------------------------- files

/** Atomic write: temp file in the same folder, fsync, rename over the target (retries on Windows locks).
 * `beforeRename` runs right before every rename attempt; throwing from it leaves the target as it was. */
export async function writeFileAtomic(file: string, data: string | Buffer, mode?: number, beforeRename?: () => Promise<void>): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  const fh = await fsp.open(tmp, 'w', mode);
  try {
    await fh.writeFile(data);
    await fh.sync();
  } finally {
    await fh.close();
  }
  // About 7 s in all, the same as the app's renameWithRetry (app/src/main/store.ts). The old 0.9 s was too short for a
  // Windows tester's program holding My style.json open; how long antivirus or sync tools really hold a file is unmeasured.
  let lastErr: unknown;
  for (let attempt = 0; attempt <= 40; attempt++) {
    try {
      await beforeRename?.();
      await fsp.rename(tmp, file);
      return;
    } catch (err: any) {
      lastErr = err;
      if (attempt === 40 || !['EPERM', 'EBUSY', 'EACCES'].includes(err?.code)) break;
      await new Promise((r) => setTimeout(r, Math.min(250, 10 + attempt * 10)));
    }
  }
  await fsp.rm(tmp, { force: true });
  throw lastErr;
}

export async function readJson<T = any>(file: string): Promise<T> {
  const text = await fsp.readFile(file, 'utf8');
  return JSON.parse(text.replace(/^﻿/, '')) as T;
}

/** `file`: another document of this project (a note's private copy); default project.json. */
export async function loadProject(projectDir: string, file = path.join(projectDir, PROJECT_FILE)): Promise<Project> {
  let raw: any;
  try { raw = await readJson(file); } catch (err: any) {
    throw new ProjectError(`Could not read ${file}: ${err?.message ?? err}`);
  }
  const p = withDefaults(raw);
  const problems = validateProject(p);
  if (problems.length) throw new ProjectError(`project.json is invalid: ${problems.join('; ')}`, problems);
  return p;
}

export async function saveProject(projectDir: string, p: Project, file = path.join(projectDir, PROJECT_FILE)): Promise<void> {
  await writeFileAtomic(file, projectBytes(p));
}

export function projectBytes(p: Project): string {
  const problems = validateProject(p);
  if (problems.length) throw new ProjectError(`Refusing to save invalid project: ${problems.join('; ')}`, problems);
  p.updatedAt = new Date().toISOString();
  return JSON.stringify(p, null, 2) + '\n';
}

/** Same video and same post: everything but the bookkeeping fields (engine project.edit_signature, plus `post`).
 * `series` is bookkeeping too: it groups reels on Home, and making more reels from a video sets it on a reel that
 * already has versions, which must not read as an edit. */
export function sameEdit(a: Project, b: Project): boolean {
  const edit = ({ updatedAt: _u, createdAt: _c, version: _v, notes: _n, series: _s, ...rest }: Project) => JSON.stringify(rest,
    (_k, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([x], [y]) => (x < y ? -1 : 1))) : v);
  return edit(a) === edit(b);
}

/** Always <project>/work/transcript.json: `transcript.file` is never joined. */
export function transcriptPath(projectDir: string, _p?: Project): string {
  return path.join(projectDir, 'work', 'transcript.json');
}

export async function loadTranscript(projectDir: string, p: Project): Promise<Transcript> {
  let t: Transcript;
  try { t = await readJson<Transcript>(transcriptPath(projectDir, p)); }
  catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT' && p.cut.keep.every((item) => 'clip' in item)) return { words: [] };
    throw err;
  }
  if (!t || !Array.isArray(t.words)) throw new ProjectError('transcript.json has no words array');
  return t;
}

export function hasTranscript(projectDir: string, p: Project): boolean {
  return fs.existsSync(transcriptPath(projectDir, p));
}

// ---------------------------------------------------------------- analysis (engine `analyze` output)

export interface RetakeCandidate extends WordAnchor { complete?: boolean; chosen?: boolean }
export interface RetakeGroup { id?: string; text?: string; candidates: RetakeCandidate[]; [k: string]: unknown }
export interface Pause { after?: string; before?: string; s?: number; e?: number; dur?: number; [k: string]: unknown }
export interface Analysis { retakes: RetakeGroup[]; pauses: Pause[]; defaultCut?: WordAnchor[]; dropped?: { from: string; to: string; reason?: string; text?: string }[]; [k: string]: unknown }

const ANALYSIS_FILES = ['work/analysis.json', 'work/analyze.json'];

/** Reads the engine's analyze output if present. Tolerant of naming (retakes / retakeGroups / retake_groups). */
export async function loadAnalysis(projectDir: string): Promise<Analysis | null> {
  for (const rel of ANALYSIS_FILES) {
    const file = path.join(projectDir, rel);
    if (fs.existsSync(file)) {
      try { return normalizeAnalysis(await readJson(file)); } catch { /* fall through */ }
    }
  }
  return null;
}

export function normalizeAnalysis(a: any): Analysis {
  const groups = a?.retakes ?? a?.retakeGroups ?? a?.retake_groups ?? [];
  const retakes: RetakeGroup[] = (Array.isArray(groups) ? groups : []).map((g: any, i: number) => ({
    ...g,
    id: g?.id ?? `r${i + 1}`,
    candidates: (g?.candidates ?? g?.takes ?? g?.ranges ?? []).map((c: any) => ({
      from: c.from ?? c.start, to: c.to ?? c.end,
      ...(typeof c.complete === 'boolean' ? { complete: c.complete } : {}),
      ...(typeof c.chosen === 'boolean' ? { chosen: c.chosen } : {}),
    })),
  }));
  const pauses: Pause[] = Array.isArray(a?.pauses) ? a.pauses : [];
  const dc = a?.defaultCut ?? a?.default_cut ?? a?.cut;
  const defaultCut = Array.isArray(dc) ? dc : Array.isArray(dc?.keep) ? dc.keep : undefined;
  const dropped = Array.isArray(dc?.dropped) ? dc.dropped : Array.isArray(a?.dropped) ? a.dropped : undefined;
  return { ...a, retakes, pauses, ...(defaultCut ? { defaultCut } : {}), ...(dropped ? { dropped } : {}) };
}

// ---------------------------------------------------------------- word anchors

export interface WordIndex { words: Word[]; byId: Map<string, number> }

const indexCache = new WeakMap<Transcript, WordIndex>();
export function wordIndex(t: Transcript): WordIndex {
  let idx = indexCache.get(t);
  if (!idx) {
    const byId = new Map<string, number>();
    t.words.forEach((w, i) => byId.set(w.id, i));
    idx = { words: t.words, byId };
    indexCache.set(t, idx);
  }
  return idx;
}

/** A gap longer than this ends a sentence; formatForPicking breaks its lines at the same gap. */
const SENTENCE_PAUSE = 0.6;

/**
 * Which words start and which end a sentence. A word ends one when its text ends in . ? or !, when the next word is
 * from another source or starts more than 0.6 s after it, or when it is the last word; the word after an end starts
 * one. `marked` is false when no word ends a sentence by punctuation, a pause or a change of source, the last word
 * included: then nothing tells sentences apart.
 */
export function sentenceEdges(t: Transcript): { starts: Set<string>; ends: Set<string>; marked: boolean } {
  const starts = new Set<string>();
  const ends = new Set<string>();
  let marked = false;
  t.words.forEach((w, i) => {
    const next = t.words[i + 1];
    if (i === 0 || ends.has(t.words[i - 1].id)) starts.add(w.id);
    const signal = /[.?!]["'”’)\]]*$/.test(String(w.w).trim()) || (!!next && (next.source !== w.source || next.s - w.e > SENTENCE_PAUSE));
    if (signal) marked = true;
    if (signal || !next) ends.add(w.id);
  });
  return { starts, ends, marked };
}

export function anchorProblem(idx: WordIndex, a: any): string | null {
  if (!a || !isStr(a.from) || !isStr(a.to)) return 'anchor needs from/to word ids';
  const i = idx.byId.get(a.from); const j = idx.byId.get(a.to);
  if (i === undefined) return `unknown word id ${a.from}`;
  if (j === undefined) return `unknown word id ${a.to}`;
  if (j < i) return `range ${a.from}..${a.to} is backwards`;
  return null;
}

/** Words covered by an inclusive anchor (transcript order). */
export function anchorWords(t: Transcript, a: CutItem): Word[] {
  if ('clip' in a) return t.words.filter((w) => w.source === a.source && w.s < a.out && w.e > a.in);
  const idx = wordIndex(t);
  const i = idx.byId.get(a.from); const j = idx.byId.get(a.to);
  if (i === undefined || j === undefined || j < i) return [];
  return idx.words.slice(i, j + 1);
}

export function anchorText(t: Transcript, a: CutItem): string {
  return anchorWords(t, a).map((w) => w.w.trim()).join(' ');
}

/** Kept words in output order. */
export function keptWords(t: Transcript, keep: CutItem[]): Word[] {
  return keep.flatMap((a) => anchorWords(t, a));
}

export function isKept(t: Transcript, keep: CutItem[], wordId: string): boolean {
  return keep.some((a) => anchorWords(t, a).some((w) => w.id === wordId));
}

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}' ]+/gu, '').trim();

/** Mirrors captions.py's stitch_numbers, normalize_corrections and apply_corrections matching. */
export function captionCorrectionProblem(kept: readonly Word[], corrections: CaptionCorrection[], proposed: CaptionCorrection): string | null {
  const bare = (word: string) => word.trim().replace(/^["'(\[¿¡]+/, '').replace(/[.,!?;:"')\]…]+$/, '').toLowerCase();
  const words: { w: string; ids: string[]; fixed: boolean }[] = [];
  for (let i = 0; i < kept.length; i++) {
    const word = kept[i].w;
    const next = kept[i + 1]?.w;
    if (/^\$?\p{Decimal_Number}+$/u.test(word.trim()) && next && /^,\p{Decimal_Number}{3}/u.test(next.trim())) {
      words.push({ w: word.trim() + next.trim(), ids: [kept[i].id, kept[i + 1].id], fixed: false });
      i++;
    } else words.push({ w: word, ids: [kept[i].id], fixed: false });
  }
  const tokens = (text: string) => text.trim().split(/\s+/).filter(Boolean);
  const single = new Map<string, CaptionCorrection>();
  const spans: { correction: CaptionCorrection; from: string[]; to: string[] }[] = [];
  const at = new Map<string, CaptionCorrection>();
  const heard = new Map(kept.map((word) => [word.id, word.w]));
  const heardIds = [...heard.keys()];
  const heardWords = [...heard.values()];
  for (const correction of corrections) {
    const from = tokens(correction.from).map(bare);
    const to = tokens(correction.to);
    if (correction.at) {
      const i = heardIds.indexOf(correction.at), j = heardIds.indexOf(correction.through ?? correction.at);
      const now = tokens(heardWords.slice(i, j + 1).join(' ')).map(bare);
      if (i < 0 || j < 0 || (now.length === from.length && now.every((word, k) => word === from[k]))) {
        at.set(correction.at, correction);
      }
      continue;
    }
    if (!from.length) continue;
    if (from.length === 1 && to.length === 1) single.set(from[0], correction);
    else spans.push({ correction, from, to });
  }
  const remaining = words;
  const applied = new Set<string>();
  // Subtitle edits run first, merge their anchored span and protect it from global corrections.
  for (let i = 0; i < remaining.length; i++) {
    const prev = remaining[i - 1]?.ids ?? [];
    const fix = remaining[i].ids.map((id) => !prev.includes(id) ? at.get(id) : undefined).find(Boolean);
    if (!fix) continue;
    const through = fix.through ? remaining.findIndex((word, k) => k >= i && word.ids.includes(fix.through!)) : i;
    const count = (through < 0 ? i : through) - i + 1;
    const merged = remaining.slice(i, i + count);
    remaining.splice(i, count, { w: fix.to || merged.map((word) => word.w).join(' '),
      ids: [...new Set(merged.flatMap((word) => word.ids))], fixed: true });
    applied.add(fix.from);
  }
  for (let i = 0; i < remaining.length; i++) {
    for (const span of spans) {
      if (!span.from.every((word, k) => remaining[i + k] && !remaining[i + k].fixed && bare(remaining[i + k].w) === word)) continue;
      if (span.correction === proposed) return null;
      applied.add(span.correction.from);
      const ids = remaining.slice(i, i + span.from.length).flatMap((word) => word.ids);
      remaining.splice(i, span.from.length, ...span.to.map((w) => ({ w, ids, fixed: true })));
      i += Math.max(0, span.to.length - 1);
      break;
    }
  }
  for (const word of remaining) {
    if (word.fixed) continue;
    // Python's Unicode \w includes letters, numbers and underscore; punctuation stays in the tail.
    const core = /^[^\p{L}\p{N}_]*([\p{L}\p{N}_]+(?:['’][\p{L}\p{N}_]+)?)/u.exec(word.w)?.[1].toLowerCase();
    if (!core) continue;
    const correction = single.get(core) ?? single.get(core.split(/['’]/)[0]);
    if (correction === proposed) return null;
    if (correction) applied.add(correction.from);
  }
  return applied.size
    ? `correction "${proposed.from}" has no matches after existing corrections: ${[...applied].map((from) => `"${from}"`).join(', ')}; remove or change the conflicting correction first`
    : `phrase not found in the part of the video that is kept: "${proposed.from}"; check whether it was cut and restore that section first`;
}

/** Finds a phrase in the transcript (kept words first). Returns the inclusive anchor or null. */
export function findPhrase(t: Transcript, phrase: string, keep?: WordAnchor[]): WordAnchor | null {
  const target = norm(phrase).split(/\s+/).filter(Boolean);
  if (!target.length) return null;
  const search = (words: Word[]) => {
    for (let i = 0; i + target.length <= words.length; i++) {
      let ok = true;
      for (let k = 0; k < target.length; k++) if (norm(words[i + k].w) !== target[k]) { ok = false; break; }
      if (ok) return { from: words[i].id, to: words[i + target.length - 1].id };
    }
    return null;
  };
  return (keep && keep.length ? search(keptWords(t, keep)) : null) ?? search(t.words);
}

/**
 * Approximate output time of every kept word (seconds), using the same rule as the engine:
 * concatenate kept ranges, inter-word gaps capped at gapCap. The engine is authoritative;
 * this is used for planning (look_at_frames times, summaries) only.
 */
export function approxOutputTimes(t: Transcript, keep: CutItem[], gapCap: number): Map<string, { s: number; e: number }> {
  const out = new Map<string, { s: number; e: number }>();
  let clock = 0;
  let prev: Word | null = null;
  for (const a of keep) {
    if ('clip' in a) {
      for (const w of anchorWords(t, a)) {
        if (!out.has(w.id)) out.set(w.id, { s: round(clock + Math.max(0, w.s - a.in)), e: round(clock + Math.min(a.out, w.e) - a.in) });
      }
      clock += a.out - a.in;
      prev = null;
      continue;
    }
    const words = anchorWords(t, a);
    words.forEach((w, k) => {
      const contiguous = k > 0 && prev && prev.source === w.source;
      const gap = contiguous ? Math.min(Math.max(0, w.s - prev!.e), gapCap) : (prev ? Math.min(0.05, gapCap) : 0);
      const s = clock + gap;
      const e = s + Math.max(0.02, w.e - w.s);
      out.set(w.id, { s: round(s), e: round(e) });
      clock = e;
      prev = w;
    });
  }
  return out;
}

export function approxDuration(t: Transcript, keep: CutItem[], gapCap: number): number {
  let duration = 0;
  let words: WordAnchor[] = [];
  const flush = () => {
    let end = 0;
    for (const value of approxOutputTimes(t, words, gapCap).values()) end = Math.max(end, value.e);
    duration += end;
    words = [];
  };
  for (const item of keep) {
    if ('clip' in item) { flush(); duration += item.out - item.in; }
    else words.push(item);
  }
  flush();
  return round(duration);
}

const round = (x: number) => Math.round(x * 1000) / 1000;

/** `before`: the cut.keep item just before this range, when the caller has the whole cut. */
function joinProblem(join: unknown, index: number, before?: unknown): string | null {
  if (join === undefined) return null;
  if (index === 0) return 'not allowed on the first range';
  // a join bridges two spoken ranges; after a clip (multi-source) there is none, and the engine would play a hard cut
  if (before && typeof before === 'object' && 'clip' in before) return 'not allowed right after a clip';
  if (!join || typeof join !== 'object') return 'needs transition and frames';
  const j = join as Partial<Join>;
  // a match is valid here; whether its two sides line up is the engine's to say (engine/reelengine/match.py)
  if (!(JOIN_TRANSITIONS as readonly string[]).includes(j.transition ?? '')) return 'transition must be hard, j, l, smash, match, flash or action';
  if (!Number.isSafeInteger(j.frames) || j.frames! < 0) return 'frames must be a non-negative integer';
  return null;
}

// Python round() chooses the even frame at an exact half-frame, unlike Math.round().
function sourceFrame(seconds: number, fps: number): number {
  const frame = seconds * fps;
  const lower = Math.floor(frame);
  return frame - lower === 0.5 ? lower + lower % 2 : Math.round(frame);
}

/** Reject bounds the engine cannot turn into at least one source frame. */
export function clipProblem(sources: Source[], item: Pick<ClipItem, 'source' | 'in' | 'out'>): string | null {
  const source = sources.find((s) => s.id === item.source);
  if (!source) return `unknown source ${item.source}`;
  if (!Number.isFinite(source.duration) || !source.duration || !Number.isFinite(item.in) || !Number.isFinite(item.out)
      || item.in < 0 || item.out <= item.in || item.out > source.duration) return 'clip in/out must be inside the source and have positive length';
  const fps = source.fps || 30;
  const end = Math.min(sourceFrame(item.out, fps), Math.floor(source.duration * fps + 1e-6));
  if (end - sourceFrame(item.in, fps) < 1) return 'clip must contain at least one source frame';
  return null;
}

/**
 * `keep` with the words `back` added, each where it sits in the take: on the end of the range that stops just before
 * it, on the start of the one that begins just after it, or as a range of its own after the range holding the nearest
 * kept word before it. Nothing else changes: words around it that `keep` leaves out stay out, and other ranges keep
 * their order and joins. A word that bridges two ranges playing one after the other makes them one range. Clips are
 * left alone. Used by restore_from_version, so bringing a part back returns exactly its words (rebuilding the range
 * by hand with set_cut brought back the filler before it too).
 */
export function withWordsBack(t: Transcript, keep: CutItem[], back: string[]): CutItem[] {
  const idx = wordIndex(t);
  const out: CutItem[] = keep.map((a) => ({ ...a }));
  const kept = new Set(keptWords(t, out).map((w) => w.id));
  const rangeAt = (pred: (r: CutRange) => boolean) => out.findIndex((a) => !('clip' in a) && pred(a));
  const rangeHolding = (id: string) => out.findIndex((a) => anchorWords(t, a).some((x) => x.id === id));
  const order = back.map((id) => idx.byId.get(id)).filter((i): i is number => i !== undefined).sort((a, b) => a - b);
  for (const pos of order) {
    const w = idx.words[pos];
    if (kept.has(w.id)) continue;
    const prev = idx.words[pos - 1]?.source === w.source ? idx.words[pos - 1] : undefined;
    const next = idx.words[pos + 1]?.source === w.source ? idx.words[pos + 1] : undefined;
    const ends = prev ? rangeAt((r) => r.to === prev.id) : -1;
    const starts = next ? rangeAt((r) => r.from === next.id) : -1;
    if (ends >= 0) {
      (out[ends] as CutRange).to = w.id;
      if (starts === ends + 1) {
        (out[ends] as CutRange).to = (out[starts] as CutRange).to;
        out.splice(starts, 1);
      }
    } else if (starts >= 0) {
      (out[starts] as CutRange).from = w.id;
    } else {
      let at = -1;
      for (let i = pos - 1; i >= 0 && at < 0; i--) {
        if (idx.words[i].source === w.source && kept.has(idx.words[i].id)) at = rangeHolding(idx.words[i].id) + 1;
      }
      for (let i = pos + 1; i < idx.words.length && at < 0; i++) {
        if (idx.words[i].source === w.source && kept.has(idx.words[i].id)) at = rangeHolding(idx.words[i].id);
      }
      out.splice(at < 0 ? out.length : at, 0, { from: w.id, to: w.id });
    }
    kept.add(w.id);
  }
  return out;
}

/** Merge adjacent/overlapping ranges in transcript order is NOT done: keep is output order. Normalize = drop empties. */
export function normalizeKeep(t: Transcript, keep: CutRange[]): { keep: CutRange[]; problems: string[] } {
  const idx = wordIndex(t);
  const problems: string[] = [];
  const out: CutRange[] = [];
  keep.forEach((a, i) => {
    // Tool schemas use null for optional fields; persisted projects omit them.
    const join = a.join ?? undefined;
    const pr = anchorProblem(idx, a) ?? joinProblem(join, i);
    if (pr) problems.push(`keep[${i}]: ${pr}`);
    else out.push({ from: a.from, to: a.to, ...(join ? { join: { ...join } } : {}) });
  });
  // overlap check (same word kept twice plays twice; that is almost always a mistake)
  const seen = new Map<string, number>();
  out.forEach((a, i) => {
    for (const w of anchorWords(t, a)) {
      if (seen.has(w.id)) { problems.push(`keep[${i}] repeats word ${w.id} already in keep[${seen.get(w.id)}]`); break; }
      seen.set(w.id, i);
    }
  });
  return { keep: out, problems };
}

// ---------------------------------------------------------------- versions

export function versionDir(projectDir: string, n: number): string {
  return path.join(projectDir, 'versions', `v${n}`);
}

/** Saved versions: a `vN` folder counts only up to project.json's `version` (docs/versions.md). */
export async function listVersions(projectDir: string): Promise<number[]> {
  try {
    const { version } = await loadProject(projectDir);
    const names = await fsp.readdir(path.join(projectDir, 'versions'));
    return names.map((n) => /^v(\d+)$/.exec(n)).filter(Boolean).map((m) => Number(m![1])).filter((n) => n <= version).sort((a, b) => a - b);
  } catch { return []; }
}

/**
 * Version `n` and the versions it was made from, newest first, by each folder's version.json parent (a merge's first
 * parent). A folder without that file has parent n-1, and Version 1 none (docs/versions.md 8). On a branch this skips
 * the other branch's versions, which share the numbers in between. A version's parent is read only when the caller
 * asks for the next one, so damage further back than what it needs never stops it. A missing folder, or a
 * version.json that can't be read or names no earlier version, throws naming the version: guessing past it could land
 * on the other branch.
 */
export async function* versionLine(projectDir: string, n: number): AsyncGenerator<number> {
  let at: number | null = n;
  while (at !== null) {
    const dir = versionDir(projectDir, at);
    if (!fs.existsSync(dir)) throw new ProjectError(`Version ${at} is missing from the versions folder.`);
    yield at;
    let meta: unknown;
    try {
      meta = await readJson(path.join(dir, 'version.json'));
    } catch (e: any) {
      if (e?.code !== 'ENOENT') throw new ProjectError(`Version ${at}'s version.json could not be read: ${e?.message ?? e}`);
      at = at > 1 ? at - 1 : null;
      continue;
    }
    const parent = meta && typeof meta === 'object' ? (meta as { parent?: unknown }).parent : undefined;
    if (at === 1 ? parent !== null : !(typeof parent === 'number' && Number.isSafeInteger(parent) && parent >= 1 && parent < at)) {
      throw new ProjectError(`Version ${at}'s version.json names no earlier version as its parent (${JSON.stringify(parent ?? null)}).`);
    }
    at = parent as number | null;
  }
}

/** Snapshots project.json (+ optional notes.md text) into versions/vN/. Never overwrites an engine-written snapshot. */
export async function snapshotVersion(projectDir: string, p: Project, n: number, notesMd?: string): Promise<string> {
  const dir = versionDir(projectDir, n);
  await fsp.mkdir(dir, { recursive: true });
  const snap = path.join(dir, PROJECT_FILE);
  if (!fs.existsSync(snap)) await writeFileAtomic(snap, JSON.stringify(p, null, 2) + '\n');
  if (notesMd) await fsp.appendFile(path.join(dir, 'notes.md'), notesMd.endsWith('\n') ? notesMd : notesMd + '\n');
  return dir;
}

/** Restores versions/vN/project.json as the current project (keeps the newer version counter). */
export async function restoreVersion(projectDir: string, n: number): Promise<Project> {
  const cur = await loadProject(projectDir);
  if (n > cur.version) throw new ProjectError(`version ${n} was never saved (the project is at ${cur.version})`);
  const snap = withDefaults(await readJson(path.join(versionDir(projectDir, n), PROJECT_FILE)));
  snap.version = Math.max(cur.version, snap.version);
  await saveProject(projectDir, snap);
  return snap;
}

export function nextBrollId(p: Project): string {
  let n = p.broll.length + 1;
  const ids = new Set(p.broll.map((b) => b.id));
  while (ids.has(`b${n}`)) n++;
  return `b${n}`;
}

// ---------------------------------------------------------------- Reel Studio root

export const LIBRARY_FOLDERS = {
  raw: 'Raw takes', broll: 'B-roll', music: 'Music', images: 'Images', exports: 'Exports',
} as const;
export type LibraryKind = keyof typeof LIBRARY_FOLDERS;

export function styleFile(root: string): string { return path.join(root, 'My style.json'); }
