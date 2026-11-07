// Reels from the person's whole footage archive (tracker raw-to-many-reels): the editor reads the footage index's
// lines across every indexed file (engine footage.py digest) and proposes reels, each a few line ranges from one or
// more files. One JSON-only call, checked here, asked once more with the problems when the check fails. Read-only:
// the app makes a reel from each pick, its cut the proposed spans as time-based clips (app main/archive-reels.ts).
import { waitWords } from './agent';
import { REEL_LIMIT, REEL_SECONDS } from './propose';
import type { Prompts } from './prompts';
import { extractJson } from './providers/cli';
import { cleanSummary } from './tools';
import { AIError, type AgentEvent, type ModelProvider } from './types';

export interface ArchiveLine { s: number; e: number; text: string }
export interface ArchiveFile {
  /** Library/... or Footage/<folder>/<file>, as engine footage digest names it */
  ref: string;
  name: string;
  duration: number;
  lines: ArchiveLine[];
}
export interface ArchiveRequest {
  files: ArchiveFile[];
  /** At most this many reels (REEL_LIMIT). */
  limit?: number;
}
/** One span of a file in play order: from the start of its first line to the end of its last. */
export interface ArchiveSpan { ref: string; t0: number; t1: number; said: string }
export interface ArchiveCandidate {
  id: string;
  title: string;
  /** the opening line's words: the first line of the first span */
  hook: string;
  why: string;
  spans: ArchiveSpan[];
  /** sum of the spans' lengths; a number in the reply is never read */
  seconds: number;
}
export interface ArchiveProposal { candidates: ArchiveCandidate[]; notes: string; attempts: number }

/** Files one reel may draw from. More is a montage, which the multi-clip edit does not shape well yet. */
export const FILES_PER_REEL = 3;
const TITLE_MAX = 60;
const WHY_MAX = 140;
const FINDING = 'Finding reels in your footage';
const RANGE = /^F(\d+):L(\d+)(?:-L(\d+))?$/;

/** The archive as the editor reads it: F1, F2… per file, L1, L2… per line, with times. */
export function formatArchive(req: ArchiveRequest): string {
  return req.files.map((f, i) => [
    `F${i + 1} "${f.name}" (${Math.round(f.duration)} s)`,
    ...f.lines.map((l, k) => `  L${k + 1} ${l.s.toFixed(1)}-${l.e.toFixed(1)} ${l.text.trim()}`),
  ].join('\n')).join('\n\n');
}

/**
 * The proposal in `j`, or what is wrong with it. A reel's `lines` are ranges like "F2:L3-L7" in play order; ranges
 * may not overlap within a reel or between reels. An empty list is a proposal: nothing stands on its own.
 */
export function checkArchiveProposal(j: unknown, req: ArchiveRequest): { proposal: Omit<ArchiveProposal, 'attempts'> } | { problems: string[] } {
  const limit = req.limit ?? REEL_LIMIT;
  const raw = (j as { candidates?: unknown })?.candidates;
  if (!Array.isArray(raw) || raw.length > limit || raw.some((c) => !c || typeof c !== 'object' || Array.isArray(c))) {
    return { problems: [`candidates must be a list of at most ${limit} reel objects`] };
  }
  const problems: string[] = [];
  const used = new Map<string, string>();   // "F2:L5" -> the reel that has it
  const titles = new Map<string, string>();
  const out: ArchiveCandidate[] = [];
  raw.forEach((c: Record<string, unknown>, i) => {
    const id = `r${i + 1}`;
    const before = problems.length;
    const title = typeof c.title === 'string' ? cleanSummary(c.title) : '';
    if (!title) problems.push(`${id}: title is missing`);
    else if (/[\r\n]/.test(title) || title.length > TITLE_MAX) problems.push(`${id}: title must be one line of at most ${TITLE_MAX} characters`);
    else if (titles.has(title.toLowerCase())) problems.push(`${id}: title is the same as ${titles.get(title.toLowerCase())}'s`);
    else titles.set(title.toLowerCase(), id);

    const ranges = Array.isArray(c.lines) ? c.lines : [];
    if (!ranges.length) problems.push(`${id}: lines has no ranges`);
    const spans: ArchiveSpan[] = [];
    const files = new Set<number>();
    ranges.forEach((r: unknown, k) => {
      const m = typeof r === 'string' ? RANGE.exec(r.trim()) : null;
      if (!m) return void problems.push(`${id}: lines[${k}] must look like "F2:L3-L7" or "F2:L3"`);
      const f = Number(m[1]) - 1, a = Number(m[2]) - 1, b = Number(m[3] ?? m[2]) - 1;
      const file = req.files[f];
      if (!file) return void problems.push(`${id}: lines[${k}] names F${f + 1}, which is not in the footage`);
      if (a < 0 || b >= file.lines.length || b < a) return void problems.push(`${id}: lines[${k}] (${r}) is not a range of F${f + 1}'s lines L1-L${file.lines.length}`);
      for (let n = a; n <= b; n++) {
        const key = `F${f + 1}:L${n + 1}`;
        if (used.has(key)) return void problems.push(`${id}: lines[${k}] uses ${key}, which ${used.get(key)} uses`);
      }
      for (let n = a; n <= b; n++) used.set(`F${f + 1}:L${n + 1}`, id);
      files.add(f);
      const said = file.lines.slice(a, b + 1).map((l) => l.text.trim()).join(' ');
      spans.push({ ref: file.ref, t0: file.lines[a].s, t1: file.lines[b].e, said });
    });
    if (files.size > FILES_PER_REEL) problems.push(`${id}: uses ${files.size} files; a reel draws from at most ${FILES_PER_REEL}`);
    const seconds = Math.round(spans.reduce((t, s) => t + (s.t1 - s.t0), 0) * 10) / 10;
    if (spans.length && problems.length === before && (seconds < REEL_SECONDS.min || seconds > REEL_SECONDS.max)) {
      problems.push(`${id}: plays for ${seconds.toFixed(1)} s; a reel plays for ${REEL_SECONDS.min} to ${REEL_SECONDS.max} s`);
    }
    const why = typeof c.why === 'string' ? cleanSummary(c.why) : '';
    if (!why) problems.push(`${id}: why is missing`);
    else if (why.length > WHY_MAX || /[\r\n]/.test(why) || /[.?!]["'”’)]*\s+\S/.test(why)) problems.push(`${id}: why must be one sentence of at most ${WHY_MAX} characters`);
    if (problems.length === before) {
      const first = req.files.find((f) => f.ref === spans[0].ref)!.lines.find((l) => l.s === spans[0].t0)!;
      out.push({ id, title, hook: first.text.trim(), why, spans, seconds });
    }
  });
  if (problems.length) return { problems };
  const notes = (j as { notes?: unknown }).notes;
  return { proposal: { candidates: out, notes: typeof notes === 'string' ? cleanSummary(notes) : '' } };
}

function describe(req: ArchiveRequest): string {
  return [
    formatArchive(req),
    `Propose at most ${req.limit ?? REEL_LIMIT} reels. Reply with ONLY the JSON object {"candidates": [{"title": string, "lines": ["F1:L2-L5", "F3:L1"], "why": string}], "notes": string}.`,
  ].join('\n\n');
}

/**
 * The reels the editor finds across the footage archive, best first. Throws AIError: no_ai, no_words, propose_failed.
 */
export async function proposeFromArchive(prompts: Prompts, provider: ModelProvider | null, req: ArchiveRequest, signal?: AbortSignal, onEvent?: (e: AgentEvent) => void): Promise<ArchiveProposal> {
  if (!provider) throw new AIError('no_ai', 'Connect an editor to find reels in your footage.');
  if (!req.files.some((f) => f.lines.length)) throw new AIError('no_words', "None of your footage has been listened to yet, so there are no reels to find in it.");
  const system = prompts.render('proposeArchive');
  const messages: any[] = [{ role: 'user', content: [{ type: 'text', text: describe(req) }] }];
  let problems: string[] = [];
  try {
    for (let attempt = 1; attempt <= 2; attempt++) {
      if (signal?.aborted) throw new AIError('cancelled', 'Stopped.');
      const wait = onEvent ? waitWords(provider, (message, waiting) => onEvent({ type: 'status', message, thinking: true, ...(waiting ? { waiting } : {}) }), FINDING) : null;
      let res;
      try {
        res = await provider.complete({ system, messages, tools: [], jsonOnly: true, signal, onWait: wait?.onWait });
      } finally {
        wait?.end();
      }
      const j = extractJson(res.text);
      const checked = j ? checkArchiveProposal(j, req) : { problems: ['reply was not the JSON object'] };
      if ('proposal' in checked) return { ...checked.proposal, attempts: attempt };
      problems = checked.problems;
      messages.push({ role: 'assistant', text: res.text, toolCalls: [], raw: res.raw });
      messages.push({ role: 'user', content: [{ type: 'text', text: `Problems (r1 is the first reel in your reply, r2 the second, and so on): ${problems.join('; ')}. Fix them and reply with ONLY the corrected JSON.` }] });
    }
  } finally {
    await provider.dispose?.();
  }
  throw new AIError('propose_failed', "I couldn't find reels in your footage this time.", { detail: problems.join('; ') });
}
