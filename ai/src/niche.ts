// The creator's niche (My style › Your niche): who their reels are for, what viewers get, the angles they make reels
// from and words they never want. The app saves it to <Reel Studio root>/My niche.json (app shared/niche.ts checks
// what it writes); the editor reads it on every reel through the prompts. nicheTurn is the short chat that drafts it.
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { AgentEvent, AIError, CompletionResponse, ModelProvider } from './types';
import { waitWords } from './agent';
import { Prompts } from './prompts';
import { StyleStore } from './style';
import { extractJson } from './providers/cli';
import { cleanSummary } from './tools';

export const NICHE_FILE = 'My niche.json';
/** Questions the editor may ask after "What do you make reels about?" before it proposes the niche. */
export const NICHE_QUESTIONS = 2;
const LINE_MAX = 160;
const ANGLE_MAX = 120;
const WORD_MAX = 40;
const STEP = 'Thinking about your niche';

export interface Niche { who: string; promise: string; angles: string[]; avoid: string[] }
export interface NicheTurn { from: 'you' | 'editor'; text: string; kind?: 'question' | 'niche' }
export interface NicheTurnInput { turns: NicheTurn[]; asked: number; niche: Niche | null }
export type NicheTurnResult = { kind: 'question'; text: string } | ({ kind: 'niche'; say: string } & Niche);

export function nicheFile(root: string): string { return path.join(root, NICHE_FILE); }

const line = (v: unknown, max: number): string => (typeof v === 'string' ? cleanSummary(v).replace(/\s+/g, ' ').trim().slice(0, max) : '');
const lines = (v: unknown, max: number): string[] => (Array.isArray(v) ? v.map((x) => line(x, max)).filter(Boolean) : []);

/** The saved niche, or null when there is none. A file the person broke by hand is read as no niche here: an edit
 * must not fail over it, and My style says it could not be read (app niche-ipc.ts). */
export async function readNiche(root: string): Promise<Niche | null> {
  let data: any;
  try {
    data = JSON.parse((await fsp.readFile(nicheFile(root), 'utf8')).replace(/^﻿/, ''));
  } catch {
    return null;
  }
  const n = data?.niche;
  const who = line(n?.who, LINE_MAX);
  const promise = line(n?.promise, LINE_MAX);
  if (!who || !promise) return null;
  return { who, promise, angles: lines(n?.angles, ANGLE_MAX).slice(0, 5), avoid: lines(n?.avoid, WORD_MAX).slice(0, 12) };
}

/** The prompt section every editor task carries ({{niche}}): empty when no niche is saved. */
export function nicheSection(n: Niche | null): string {
  if (!n) return '';
  const angles = n.angles.length ? `\nThe kinds of reels they make:\n${n.angles.map((a) => `- ${a}`).join('\n')}` : '';
  const avoid = n.avoid.length ? `\nWords they never want in a title, on-screen text, a caption line you write or the post: ${n.avoid.map((w) => `"${w}"`).join(', ')}.` : '';
  return `## The creator's niche (they saved this; it holds for every reel)\nTheir reels are for: ${n.who}\nWhat viewers get from them: ${n.promise}${angles}${avoid}\n`;
}

export async function nicheVars(root: string): Promise<{ niche: string }> {
  return { niche: nicheSection(await readNiche(root)) };
}

/** The model's reply to a niche turn, or null when the app can't use it: a question once the questions are spent, or a
 * niche short of who, what they get and 3 angles. Angles past 5 and words to avoid past 8 go. */
export function readNicheTurn(j: unknown, asked: number): NicheTurnResult | null {
  if (!j || typeof j !== 'object') return null;
  const o = j as Record<string, unknown>;
  const question = line(o.question, LINE_MAX);
  if (question) return asked < NICHE_QUESTIONS ? { kind: 'question', text: question } : null;
  const who = line(o.who, LINE_MAX);
  const promise = line(o.promise, LINE_MAX);
  const angles = lines(o.angles, ANGLE_MAX);
  if (!who || !promise || angles.length < 3) return null;
  return { kind: 'niche', say: line(o.say, LINE_MAX) || 'Here is a niche to start from.', who, promise, angles: angles.slice(0, 5), avoid: lines(o.avoid, WORD_MAX).slice(0, 8) };
}

function nicheForPrompt(n: Niche): string {
  return [`Who: ${n.who}`, `What they get: ${n.promise}`, `Angles:\n${n.angles.map((a) => `- ${a}`).join('\n')}`, `Avoid: ${n.avoid.join(', ') || '(none)'}`].join('\n');
}

/**
 * One turn of the niche chat in My style: the editor asks a short question (at most NICHE_QUESTIONS) or proposes the
 * whole niche. Nothing is saved here; the person saves the draft they want (app niche-ipc.ts).
 */
export async function nicheTurn(deps: { prompts: Prompts; style: StyleStore }, provider: ModelProvider | null, input: NicheTurnInput, onEvent: (e: AgentEvent) => void, signal?: AbortSignal): Promise<NicheTurnResult> {
  if (!provider) throw new AIError('no_ai', 'Connect an editor to find your niche together.');
  const last = input.turns[input.turns.length - 1];
  if (!last || last.from !== 'you') throw new AIError('niche_input', 'Say what your reels are about first.');
  const mustPropose = input.asked >= NICHE_QUESTIONS;
  const system = deps.prompts.render('niche', {
    asked: String(Math.min(input.asked, NICHE_QUESTIONS)),
    mustPropose: mustPropose ? 'No questions are left: propose the niche now.' : '',
    niche: input.niche ? nicheForPrompt(input.niche) : 'None yet.',
    styleRules: await deps.style.asPromptText(),
  });
  const messages: any[] = [];
  for (const t of input.turns) {
    const prev = messages[messages.length - 1];
    if (t.from === 'you') {
      if (prev?.role === 'user') prev.content[0].text += `\n\n${t.text}`;
      else messages.push({ role: 'user', content: [{ type: 'text', text: t.text }] });
    } else {
      const text = JSON.stringify(t.kind === 'niche' ? { say: t.text } : { question: t.text });
      if (prev?.role === 'assistant') prev.text = text;
      // the chat opens with the app's own question; the model's first message is always the creator's
      else if (messages.length) messages.push({ role: 'assistant', text, toolCalls: [] });
    }
  }
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (signal?.aborted) throw new AIError('cancelled', 'Stopped.');
      onEvent({ type: 'status', message: STEP, pct: 10, thinking: true });
      const wait = waitWords(provider, (message, waiting) => onEvent({ type: 'status', message, thinking: true, ...(waiting ? { waiting } : {}) }), STEP);
      let res: CompletionResponse;
      try {
        res = await provider.complete({ system, messages, tools: [], jsonOnly: true, signal, onWait: wait.onWait });
      } finally {
        wait.end();
      }
      if (signal?.aborted) throw new AIError('cancelled', 'Stopped.');
      const r = readNicheTurn(extractJson(res.text), input.asked);
      if (r) return r;
      messages.push({ role: 'assistant', text: res.text, toolCalls: [], raw: res.raw });
      messages.push({ role: 'user', content: [{ type: 'text', text: mustPropose
        ? 'No questions are left. Reply with ONLY the niche JSON: {"say": string, "who": string, "promise": string, "angles": [3 to 5], "avoid": [0 to 8]}.'
        : 'That could not be read. Reply with ONLY one JSON object: {"question": string}, or {"say": string, "who": string, "promise": string, "angles": [3 to 5], "avoid": [0 to 8]}.' }] });
    }
  } finally {
    await provider.dispose?.();
  }
  throw new AIError('niche_failed', 'I could not draft a niche from that this time. Try again.');
}
