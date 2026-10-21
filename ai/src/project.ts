// project.json (schemaVersion 1) types + load/save/validate + word-anchor helpers.
// Mirrors docs/architecture.md section 3 and engine/reelengine/schema/project.schema.json. Optional fields
// only; unknown fields are preserved on save so the engine and the app can extend the file.
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

export interface Format { width: number; height: number; fps: number }
export interface Source {
  id: string; path: string; duration?: number; fps?: number; width?: number; height?: number; rotation?: number;
  [k: string]: unknown;
}
export interface WordAnchor { from: string; to: string }
export interface Word { id: string; source: string; s: number; e: number; w: string; [k: string]: unknown }
export interface Transcript { words: Word[]; language?: string; [k: string]: unknown }

export interface CaptionStyle {
  preset?: string; font?: string; size?: number; maxWords?: number;
  case?: 'upper' | 'lower' | 'as-is' | 'title' | string; color?: string; outline?: number; outlineColor?: string; shadow?: number; box?: boolean; position?: number;
  [k: string]: unknown;
}
export interface CaptionCorrection { from: string; to: string }
/** vocabulary: names/jargon the user or the AI supplies; the engine respells sound-alikes to them after
 * transcription (engine/reelengine/vocab.py). */
export interface Captions { enabled: boolean; style: CaptionStyle; corrections: CaptionCorrection[]; vocabulary?: string[]; [k: string]: unknown }

export type MusicLevel = 'under-voice' | 'quiet' | 'loud-intro';
export interface MusicAutomation { fromWord: string; toWord: string; gainDb: number }
export interface Music {
  enabled: boolean; track: string | null; startAt: number; level: MusicLevel | string;
  automation: MusicAutomation[]; fadeOut: number; [k: string]: unknown;
}

export const TREATMENTS = [
  'card-above-head', 'full-frame', 'phone-card', 'side-card', 'text-pop', 'post-wall', 'icon-wall', 'split-top',
  'animation',
] as const;
export type Treatment = (typeof TREATMENTS)[number];

export interface BrollParams { tilt?: number | null; scale?: number | null; text?: string | null; [k: string]: unknown }
export interface Broll {
  id: string; anchor: WordAnchor; leadIn?: number; treatment: Treatment | string;
  asset: string | null; assets?: string[]; params: BrollParams; [k: string]: unknown;
}
export interface Zoom { anchor: WordAnchor; scale: number; [k: string]: unknown }
export interface Cover { atSourceTime: number; source: string; text: string | null; [k: string]: unknown }
export interface Post { caption: string; hashtags: string[]; keywords: string[]; [k: string]: unknown }
export interface NoteEntry {
  version: number; text: string; applied: string[]; at: string;
  /** files the user attached to this note (`work/assets/attach-*`), 0.1.2 */
  attachments?: string[];
}

export interface Project {
  schemaVersion: 1;
  id: string; title: string; slug: string; createdAt: string; updatedAt: string; version: number;
  format: Format;
  sources: Source[];
  transcript: { file: string; language?: string };
  cut: { keep: WordAnchor[]; gapCap: number; minSaving?: number; [k: string]: unknown };
  captions: Captions;
  music: Music;
  broll: Broll[];
  zooms: Zoom[];
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

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === 'string';

/** Structural validation. Returns a list of problems (empty = valid). Pass the transcript to check anchors. */
export function validateProject(p: unknown, transcript?: Transcript): string[] {
  const out: string[] = [];
  if (!p || typeof p !== 'object') return ['project is not an object'];
  const q = p as Record<string, any>;
  if (q.schemaVersion !== 1) out.push('schemaVersion must be 1');
  for (const k of ['id', 'title', 'slug']) if (!isStr(q[k])) out.push(`${k} must be a string`);
  if (!q.format || !isNum(q.format.width) || !isNum(q.format.height) || !isNum(q.format.fps)) out.push('format needs width/height/fps');
  if (!Array.isArray(q.sources)) out.push('sources must be an array');
  if (!q.cut || !Array.isArray(q.cut.keep)) out.push('cut.keep must be an array');
  else if (!isNum(q.cut.gapCap) || q.cut.gapCap < 0) out.push('cut.gapCap must be a number >= 0');
  if (!q.captions || typeof q.captions.enabled !== 'boolean') out.push('captions.enabled must be a boolean');
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
    q.cut.keep.forEach((a: any, i: number) => check(a, `cut.keep[${i}]`));
    q.broll.forEach((b: any, i: number) => check(b.anchor, `broll[${i}] (${b.id})`));
    q.zooms.forEach((z: any, i: number) => check(z.anchor, `zooms[${i}]`));
    (q.music?.automation ?? []).forEach((m: any, i: number) => check({ from: m.fromWord, to: m.toWord }, `music.automation[${i}]`));
    const ids = new Set<string>();
    for (const b of q.broll) { if (ids.has(b.id)) out.push(`duplicate broll id ${b.id}`); ids.add(b.id); }
  }
  return out;
}

// ---------------------------------------------------------------- files

/** Atomic write: temp file in the same folder, fsync, rename over the target (retries on Windows locks). */
export async function writeFileAtomic(file: string, data: string | Buffer, mode?: number): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  const fh = await fsp.open(tmp, 'w', mode);
  try {
    await fh.writeFile(data);
    await fh.sync();
  } finally {
    await fh.close();
  }
  let lastErr: unknown;
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      await fsp.rename(tmp, file);
      return;
    } catch (err: any) {
      lastErr = err;
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(err?.code)) break;
      await new Promise((r) => setTimeout(r, 25 * (attempt + 1)));
    }
  }
  await fsp.rm(tmp, { force: true });
  throw lastErr;
}

export async function readJson<T = any>(file: string): Promise<T> {
  const text = await fsp.readFile(file, 'utf8');
  return JSON.parse(text.replace(/^﻿/, '')) as T;
}

export async function loadProject(projectDir: string): Promise<Project> {
  const file = path.join(projectDir, PROJECT_FILE);
  let raw: any;
  try { raw = await readJson(file); } catch (err: any) {
    throw new ProjectError(`Could not read ${file}: ${err?.message ?? err}`);
  }
  const p = withDefaults(raw);
  const problems = validateProject(p);
  if (problems.length) throw new ProjectError(`project.json is invalid: ${problems.join('; ')}`, problems);
  return p;
}

export async function saveProject(projectDir: string, p: Project): Promise<void> {
  const problems = validateProject(p);
  if (problems.length) throw new ProjectError(`Refusing to save invalid project: ${problems.join('; ')}`, problems);
  p.updatedAt = new Date().toISOString();
  await writeFileAtomic(path.join(projectDir, PROJECT_FILE), JSON.stringify(p, null, 2) + '\n');
}

/** Always <project>/work/transcript.json: `transcript.file` is never joined. */
export function transcriptPath(projectDir: string, _p?: Project): string {
  return path.join(projectDir, 'work', 'transcript.json');
}

export async function loadTranscript(projectDir: string, p: Project): Promise<Transcript> {
  const t = await readJson<Transcript>(transcriptPath(projectDir, p));
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

export function anchorProblem(idx: WordIndex, a: any): string | null {
  if (!a || !isStr(a.from) || !isStr(a.to)) return 'anchor needs from/to word ids';
  const i = idx.byId.get(a.from); const j = idx.byId.get(a.to);
  if (i === undefined) return `unknown word id ${a.from}`;
  if (j === undefined) return `unknown word id ${a.to}`;
  if (j < i) return `range ${a.from}..${a.to} is backwards`;
  return null;
}

/** Words covered by an inclusive anchor (transcript order). */
export function anchorWords(t: Transcript, a: WordAnchor): Word[] {
  const idx = wordIndex(t);
  const i = idx.byId.get(a.from); const j = idx.byId.get(a.to);
  if (i === undefined || j === undefined || j < i) return [];
  return idx.words.slice(i, j + 1);
}

export function anchorText(t: Transcript, a: WordAnchor): string {
  return anchorWords(t, a).map((w) => w.w.trim()).join(' ');
}

/** Kept words in output order. */
export function keptWords(t: Transcript, keep: WordAnchor[]): Word[] {
  return keep.flatMap((a) => anchorWords(t, a));
}

export function isKept(t: Transcript, keep: WordAnchor[], wordId: string): boolean {
  return keep.some((a) => anchorWords(t, a).some((w) => w.id === wordId));
}

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}' ]+/gu, '').trim();

/** Match the tokens seen by captions.py: stitch_numbers, then apply_corrections' _bare. */
export function hasCaptionPhrase(t: Transcript, phrase: string): boolean {
  const bare = (word: string) => word.trim().replace(/^["'(\[¿¡]+/, '').replace(/[.,!?;:"')\]…]+$/, '').toLowerCase();
  const words: string[] = [];
  for (let i = 0; i < t.words.length; i++) {
    const word = t.words[i].w.trim();
    const next = t.words[i + 1]?.w.trim();
    if (/^\$?[0-9]+$/.test(word) && next && /^,[0-9]{3}/.test(next)) {
      words.push(bare(word + next));
      i++;
    } else words.push(bare(word));
  }
  const target = phrase.trim().split(/\s+/).map(bare);
  return !!phrase.trim() && words.some((_word, i) => target.every((word, k) => words[i + k] === word));
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
export function approxOutputTimes(t: Transcript, keep: WordAnchor[], gapCap: number): Map<string, { s: number; e: number }> {
  const out = new Map<string, { s: number; e: number }>();
  let clock = 0;
  let prev: Word | null = null;
  for (const a of keep) {
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

export function approxDuration(t: Transcript, keep: WordAnchor[], gapCap: number): number {
  let d = 0;
  for (const v of approxOutputTimes(t, keep, gapCap).values()) d = Math.max(d, v.e);
  return round(d);
}

const round = (x: number) => Math.round(x * 1000) / 1000;

/** Merge adjacent/overlapping ranges in transcript order is NOT done: keep is output order. Normalize = drop empties. */
export function normalizeKeep(t: Transcript, keep: WordAnchor[]): { keep: WordAnchor[]; problems: string[] } {
  const idx = wordIndex(t);
  const problems: string[] = [];
  const out: WordAnchor[] = [];
  keep.forEach((a, i) => {
    const pr = anchorProblem(idx, a);
    if (pr) problems.push(`keep[${i}]: ${pr}`);
    else out.push({ from: a.from, to: a.to });
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

export async function listVersions(projectDir: string): Promise<number[]> {
  try {
    const names = await fsp.readdir(path.join(projectDir, 'versions'));
    return names.map((n) => /^v(\d+)$/.exec(n)).filter(Boolean).map((m) => Number(m![1])).sort((a, b) => a - b);
  } catch { return []; }
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
  const snap = withDefaults(await readJson(path.join(versionDir(projectDir, n), PROJECT_FILE)));
  const cur = await loadProject(projectDir).catch(() => null);
  if (cur) snap.version = Math.max(cur.version, snap.version);
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
