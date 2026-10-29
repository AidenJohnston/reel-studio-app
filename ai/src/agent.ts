// The provider-neutral agent loop: model -> tool calls -> results -> model ... until `finish`.
import { AgentEvent, AIError, ChatMessage, ImagePart, ModelProvider, TokenUsage, ToolCall, ToolResultMsg } from './types';
import { discardAssetCandidates, executeTool, toolSchemas, ToolContext } from './tools';

const STAGE: Record<string, { message: string; pct: number }> = {
  get_project: { message: 'Reading your video', pct: 8 },
  get_transcript: { message: 'Reading your video', pct: 10 },
  set_cut: { message: 'Picking your best takes', pct: 25 },
  set_gap_cap: { message: 'Tightening the pauses', pct: 28 },
  set_caption_style: { message: 'Adding captions', pct: 33 },
  add_caption_correction: { message: 'Adding captions', pct: 35 },
  list_library: { message: 'Looking through your library', pct: 40 },
  choose_music: { message: 'Adding music', pct: 45 },
  set_music_automation: { message: 'Adding music', pct: 48 },
  resolve_asset: { message: 'Choosing pictures', pct: 55 },
  search_images: { message: 'Adding pictures', pct: 55 },
  fetch_image: { message: 'Adding pictures', pct: 57 },
  make_animation: { message: 'Making an animation', pct: 58 },
  add_broll: { message: 'Adding pictures', pct: 60 },
  update_broll: { message: 'Adjusting pictures', pct: 62 },
  remove_broll: { message: 'Adjusting pictures', pct: 62 },
  set_zoom: { message: 'Adding zooms', pct: 66 },
  set_mirror: { message: 'Flipping your video', pct: 67 },
  cover_candidates: { message: 'Choosing a cover', pct: 69 },
  set_cover: { message: 'Choosing a cover', pct: 70 },
  write_post: { message: 'Writing your caption', pct: 75 },
  add_style_rule: { message: 'Saving your style', pct: 76 },
  render_draft: { message: 'Making a preview', pct: 82 },
  look_at_frames: { message: 'Checking how it looks', pct: 88 },
  finish: { message: 'Almost done', pct: 92 },
};

export interface RunAgentOptions {
  provider: ModelProvider;
  system: string;
  task: string;
  ctx: ToolContext;
  onEvent: (e: AgentEvent) => void;
  signal?: AbortSignal;
  maxSteps?: number;
  /** Restrict the toolset (default: all). */
  tools?: string[];
  /** ms delays between retries of temporary provider failures */
  retryDelays?: number[];
  /** Cumulative token brake for ONE run. Default DEFAULT_TOKEN_BUDGET. */
  tokenBudget?: number;
  /** Read-only tools to run BEFORE the first model turn; their results go into the task message,
   * so the model does not spend a whole turn (5-10 s on a CLI provider) asking for them. */
  preload?: string[];
  /** replies in a row without a usable tool call before the run stops (default MAX_CONSECUTIVE_MISSES) */
  maxMisses?: number;
  /** tool calls of the parallel-safe kind run at most this many at once (default PARALLEL_LIMIT) */
  parallel?: number;
  /** images that go WITH the task in the first user message (a note's attached files, one still each) */
  taskImages?: ImagePart[];
}

/** Runs the read-only `preload` tools and returns the text appended to the task. */
export async function preloadText(ctx: ToolContext, names: string[]): Promise<string> {
  if (!names.length) return '';
  const parts: string[] = [];
  for (const name of names) {
    const r = await executeTool(ctx, name, {});
    if (!r.isError) parts.push(`### result of ${name}\n${r.content}`);
  }
  if (!parts.length) return '';
  const many = names.length > 1;
  return `\n\n## Already loaded for you\n${names.join(' and ')} ${many ? 'were' : 'was'} already called; the results are below. `
    + `Do not call ${many ? 'them' : 'it'} again unless you changed something and need a fresh copy. Start with the next step.\n\n${parts.join('\n\n')}`;
}

export interface RunAgentResult { finished: string | null; steps: number; messages: ChatMessage[]; tokens: number; stoppedBy: 'finish' | 'steps' | 'no_tools' | null }

/** ~2M effective tokens per edit: far above a normal first edit (~150-400k with caching), low enough
 * that a looping model cannot quietly burn a user's key or plan. */
export const DEFAULT_TOKEN_BUDGET = 2_000_000;

/** What one step costs against the budget. Cache reads are billed at about a tenth of input. When
 * a provider reports nothing (CLI providers), estimate from what was sent: ~4 characters a token. */
export function effectiveTokens(u: TokenUsage | undefined, sentChars: number): number {
  const known = (u?.input ?? 0) + (u?.output ?? 0) + (u?.cacheWrite ?? 0) + Math.ceil((u?.cacheRead ?? 0) / 10);
  return known > 0 ? known : Math.ceil(sentChars / 4);
}

/** Keeps only the newest tool images; older ones are replaced by a note (saves tokens). */
export function pruneImages(messages: ChatMessage[]): ChatMessage[] {
  let seen = false;
  const out = [...messages];
  for (let i = out.length - 1; i >= 0; i--) {
    const m = out[i];
    if (m.role !== 'tool' || !m.results.some((r) => r.images?.length)) continue;
    if (!seen) { seen = true; continue; }
    out[i] = { role: 'tool', results: m.results.map((r) => r.images?.length ? { ...r, images: undefined, content: `${r.content}\n(earlier images removed)` } : r) };
  }
  return out;
}

/** What the AI is doing while we wait for its answer, in plain words (never a frozen screen). */
export function thinkingMessage(messages: ChatMessage[]): string {
  const last = [...messages].reverse().find((m) => m.role === 'tool');
  const names = last && last.role === 'tool' ? last.results.map((r) => r.name) : [];
  if (!names.length) return 'Watching your video and planning the edit';
  if (names.includes('look_at_frames')) return 'Checking the preview frame by frame';
  if (names.includes('render_draft')) return 'Looking over the preview';
  if (names.some((n) => n === 'search_images' || n === 'fetch_image' || n === 'resolve_asset' || n === 'list_library')) return 'Choosing pictures and music';
  if (names.some((n) => n === 'set_cut' || n === 'set_gap_cap')) return 'Planning captions, music and pictures';
  return 'Deciding what to do next';
}

export const MAX_CONSECUTIVE_MISSES = 4;
export const PARALLEL_LIMIT = 4;

const KEEP_GOING = 'Keep going: act only through the tools. When everything is done, call finish with your summary for the user.';
const FORMAT_CORRECTION = 'Your last reply could not be read, so nothing ran. Reply again with ONE JSON object and nothing else: '
  + '{"thought": "<one short sentence>", "tool_calls": [{"name": "<tool>", "arguments": {...}}]}. No XML, no <invoke> tags, no prose.';

/** Tools that only read, search, add new files or remove files they made themselves (resolve_asset): a run of them in one reply is
 * independent, so they execute together. Everything that changes project.json, renders, or makes an
 * animation (one renderer) runs alone, in the order the model wrote it. */
export const PARALLEL_SAFE = new Set(['get_project', 'get_transcript', 'list_library', 'search_images', 'fetch_image', 'resolve_asset', 'cover_candidates']);

async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** Executes one reply's calls: consecutive parallel-safe calls together (results keep the model's
 * order), every other call alone and in order. */
async function runCalls(o: RunAgentOptions, calls: ToolCall[]): Promise<ToolResultMsg[]> {
  const results: ToolResultMsg[] = [];
  const one = async (call: ToolCall): Promise<ToolResultMsg> => {
    if (o.ctx.state.finished !== null) return { callId: call.id, name: call.name, content: JSON.stringify({ skipped: 'finish was already called' }), isError: true };
    const stage = STAGE[call.name];
    if (stage) o.onEvent({ type: 'status', message: stage.message, pct: stage.pct, phase: 'edit' });
    if (o.signal?.aborted) throw new AIError('cancelled', 'Stopped.');
    const r = await executeTool(o.ctx, call.name, call.args);
    return { callId: call.id, name: call.name, content: r.content, images: r.images, isError: r.isError };
  };
  for (let i = 0; i < calls.length;) {
    let j = i;
    while (j < calls.length && PARALLEL_SAFE.has(calls[j].name)) j++;
    if (j - i > 1) { results.push(...await mapLimit(calls.slice(i, j), o.parallel ?? PARALLEL_LIMIT, one)); i = j; continue; }
    results.push(await one(calls[i])); i++;
  }
  return results;
}

export async function runAgent(o: RunAgentOptions): Promise<RunAgentResult> {
  try { return await agentLoop(o); } finally {
    // a provider whose dispose throws must not leave this run's candidate stills and downloads on disk
    try { o.provider.dispose?.(); } finally { await discardAssetCandidates(o.ctx); }
  }
}

async function agentLoop(o: RunAgentOptions): Promise<RunAgentResult> {
  const maxSteps = o.maxSteps ?? 40;
  const tools = toolSchemas(o.tools);
  const pre = o.preload?.length ? await preloadText(o.ctx, o.preload) : '';
  const images = o.provider.supportsImages ? (o.taskImages ?? []) : [];
  const messages: ChatMessage[] = [{ role: 'user', content: [{ type: 'text', text: o.task + pre }, ...images] }];
  const retryDelays = o.retryDelays ?? [2000, 6000];
  let misses = 0; let steps = 0; let tokens = 0;
  let stoppedBy: RunAgentResult['stoppedBy'] = null;
  const budget = o.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
  const maxMisses = o.maxMisses ?? MAX_CONSECUTIVE_MISSES;
  while (steps < maxSteps && o.ctx.state.finished === null) {
    if (tokens > budget) {
      throw new AIError('token_budget', 'This edit was taking far more AI work than it should, so I stopped to protect your AI usage. Try a shorter, more specific note.', { detail: `${tokens} effective tokens > budget ${budget}` });
    }
    if (o.signal?.aborted) throw new AIError('cancelled', 'Stopped.');
    steps++;
    let res;
    for (let attempt = 0; ; attempt++) {
      try {
        const sent = pruneImages(messages);
        o.onEvent({ type: 'status', message: thinkingMessage(messages), phase: 'edit', thinking: true });
        res = await o.provider.complete({ system: o.system, messages: sent, tools, signal: o.signal });
        tokens += effectiveTokens(res.usage, o.system.length + JSON.stringify(sent).length);
        break;
      } catch (e: any) {
        if (o.signal?.aborted) throw new AIError('cancelled', 'Stopped.');
        if (e instanceof AIError && e.retryable && attempt < retryDelays.length) {
          o.onEvent({ type: 'status', message: 'The AI is busy, trying again' });
          await new Promise((r) => setTimeout(r, retryDelays[attempt]));
          continue;
        }
        throw e;
      }
    }
    messages.push({ role: 'assistant', text: res.text, toolCalls: res.toolCalls, raw: res.raw });
    if (!res.toolCalls.length) {
      // Only CONSECUTIVE misses end a run: a CLI model garbles about 1 reply in 5, and counting them
      // across the whole run stopped long edits as "ran out of time" with work still to do.
      if (++misses >= maxMisses) { stoppedBy = 'no_tools'; break; }
      messages.push({ role: 'user', content: [{ type: 'text', text: res.malformed ? FORMAT_CORRECTION : KEEP_GOING }] });
      continue;
    }
    misses = 0;
    const results = await runCalls(o, res.toolCalls);
    messages.push({ role: 'tool', results });
    if (steps === maxSteps - 2 && o.ctx.state.finished === null) {
      messages.push({ role: 'user', content: [{ type: 'text', text: 'You are almost out of steps. Wrap up now: call finish with your summary.' }] });
    }
  }
  if (o.ctx.state.finished !== null) stoppedBy = 'finish';
  else if (stoppedBy === null) stoppedBy = 'steps';
  return { finished: o.ctx.state.finished, steps, messages, tokens, stoppedBy };
}
