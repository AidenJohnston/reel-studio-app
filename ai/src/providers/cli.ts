// Providers that shell out to the person's own signed-in CLI (`claude -p`, `codex exec`) and drive the
// SAME tool loop through a JSON protocol: the model replies with {"tool_calls":[...]} as text,
// we execute them and feed results back. Offered to people as "Claude (your Claude Code app)" and
// "ChatGPT (your Codex app)" (index.ts).
import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { AIError, CallProvenance, ChatMessage, CompletionRequest, CompletionResponse, ImagePart, LimitWindow, ModelProvider, NOT_REPORTED, ToolCall, ToolSchema, WaitSignal } from '../types';
import { childEnv, cliEnv } from '../safety';
import { reportedTokens, uncachedInput } from '../provenance';
import { claudeCodeLimitWords, resetWords } from './limits';

const codexLimitWords = (resetsAt: string | null): string =>
  `Your Codex app’s ChatGPT plan has hit its limit.${resetsAt ? ` It resets ${resetWords(resetsAt)}.` : ' Codex didn’t say when it resets.'}`;

export function protocolPrompt(tools: ToolSchema[], jsonOnly: boolean): string {
  if (jsonOnly) return 'OUTPUT RULE: reply with ONE JSON object exactly as the task specifies. No prose, no markdown fences.';
  const catalog = tools.map((t) => `- ${t.name}: ${t.description}\n  arguments schema: ${JSON.stringify(t.parameters)}`).join('\n');
  return [
    'OUTPUT PROTOCOL (you are connected to a program, not a person):',
    'Reply with ONE JSON object and nothing else (no prose, no markdown fences):',
    '{"thought": "<one short sentence>", "tool_calls": [{"name": "<tool name>", "arguments": { ... }}]}',
    '- Put one or more tool calls in each reply. They run in order and you receive every result in the next message.',
    '- arguments must match the tool schema. Use null for optional fields you are not setting.',
    '- Calls that depend on the result of an earlier call must wait for the next reply.',
    '- When the task is complete, call the finish tool (alone, last).',
    '- Write no XML and no <invoke> tags: the JSON object is the whole reply.',
    '',
    'TOOLS:',
    catalog,
  ].join('\n');
}

/** Renders the neutral conversation as one prompt. Only the most recent tool images are attached. */
export function renderConversation(req: CompletionRequest): { text: string; images: { label: string; img: ImagePart }[] } {
  return renderFrom(req, 0, `# INSTRUCTIONS\n${req.system}\n\n${protocolPrompt(req.tools, !!req.jsonOnly)}`);
}

/** Only the messages from `from` on (a live session already has the rest). The model's own replies
 * are skipped: the session remembers what it said. */
export function renderDelta(req: CompletionRequest, from: number): { text: string; images: { label: string; img: ImagePart }[] } {
  return renderFrom(req, from, null);
}

function renderFrom(req: CompletionRequest, from: number, head: string | null): { text: string; images: { label: string; img: ImagePart }[] } {
  const parts: string[] = head ? [head] : [];
  const images: { label: string; img: ImagePart }[] = [];
  const lastToolIdx = req.messages.map((m) => m.role).lastIndexOf('tool');
  req.messages.forEach((m, i) => {
    if (i < from || (head === null && m.role === 'assistant')) return;
    if (m.role === 'user') {
      parts.push(`# USER\n${m.content.filter((p) => p.type === 'text').map((p: any) => p.text).join('\n')}`);
      m.content.filter((p): p is ImagePart => p.type === 'image').forEach((img, k) => images.push({ label: `user image ${k + 1}`, img }));
    } else if (m.role === 'assistant') {
      parts.push(`# YOUR PREVIOUS REPLY\n${JSON.stringify({ thought: m.text || undefined, tool_calls: m.toolCalls.map((c) => ({ name: c.name, arguments: c.args })) })}`);
    } else {
      const body = m.results.map((r) => {
        let line = `## result of ${r.name}${r.isError ? ' (ERROR)' : ''}\n${r.content}`;
        if (r.images?.length) {
          if (i === lastToolIdx) {
            r.images.forEach((img, k) => images.push({ label: `${r.name} image ${k + 1}`, img }));
            line += `\n(${r.images.length} image(s) attached at the end of this message, in order)`;
          } else line += '\n(images from this earlier call are no longer attached)';
        }
        return line;
      }).join('\n\n');
      parts.push(`# TOOL RESULTS\n${body}`);
    }
  });
  parts.push(req.jsonOnly ? '# YOUR REPLY (one JSON object)' : '# YOUR NEXT REPLY (one JSON object with tool_calls)');
  return { text: parts.join('\n\n'), images };
}

/** Extracts the first top-level JSON object from model text (tolerates fences / leading prose). */
export function extractJson(text: string): any | null {
  const t = text.replace(/```(?:json)?/gi, '').trim();
  const start = t.indexOf('{');
  if (start < 0) return null;
  let depth = 0; let inStr = false; let esc = false;
  for (let i = start; i < t.length; i++) {
    const c = t[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { try { return JSON.parse(t.slice(start, i + 1)); } catch { return null; } } }
  }
  return null;
}

/** Every top-level JSON object in the text that parses, in order. */
export function extractAllJson(text: string): any[] {
  const t = text.replace(/```(?:json)?/gi, '');
  const out: any[] = [];
  let i = t.indexOf('{');
  while (i >= 0 && i < t.length) {
    let depth = 0; let inStr = false; let esc = false; let end = -1;
    for (let k = i; k < t.length; k++) {
      const c = t[k];
      if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) { end = k; break; } }
    }
    if (end < 0) break;
    try { out.push(JSON.parse(t.slice(i, end + 1))); i = t.indexOf('{', end + 1); } catch { i = t.indexOf('{', i + 1); }
  }
  return out;
}

let callSeq = 0;

/** Text that was clearly MEANT as tool calls but could not be read (XML-style calls with no tool we
 * know, a broken JSON object). The agent then re-asks with a one-line format correction. */
function looksLikeCalls(text: string): boolean {
  return /<invoke\b|<function_calls>|"tool_calls"|"arguments"\s*:/.test(text);
}

/** One parameter value from an XML-style call: JSON when it parses (objects, arrays, numbers, null),
 * else the raw string. A string-typed parameter stays a string ("123" as a caption is text). */
function xmlValue(raw: string, schema: any): unknown {
  const v = raw.trim();
  if (v === 'null') return null;
  const type = schema?.type;
  const isString = type === 'string' || (Array.isArray(type) && type.includes('string') && !type.some((t: string) => t === 'object' || t === 'array' || t === 'number' || t === 'integer' || t === 'boolean'));
  const bare = raw.replace(/^\n+|\n+$/g, '');
  if (isString) return bare;
  try { return JSON.parse(v); } catch { return bare; }
}

/** claude -p with its tools turned off still answers about 1 turn in 5 with its native XML call
 * format (`<invoke name="set_cut"><parameter name="keep">[...]</parameter></invoke>`), sometimes
 * repeating the block or trailing a run of stray `</invoke>`. Each one cost a whole wasted turn and
 * three of them ended a run. Read the well-formed calls to KNOWN tools; drop unknown names, empty
 * calls to tools that take arguments (an empty choose_music would REMOVE the music), and exact
 * repeats. A reply that lists several empty calls is the model dumping the tool catalog, not a
 * plan: nothing from it runs. */
export function parseXmlCalls(text: string, tools: ToolSchema[] = []): ToolCall[] {
  const known = new Map(tools.map((t) => [t.name, t]));
  const out: ToolCall[] = [];
  const seen = new Set<string>();
  const re = /<invoke\s+name="([^"]+)"\s*(\/>|>([\s\S]*?)<\/invoke>)/g;
  const empties = [...text.matchAll(re)].filter((x) => !(x[3] ?? '').includes('<parameter')).length;
  if (empties > 2) return [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const name = m[1];
    const tool = known.get(name);
    if (!tool && known.size) continue;
    const body = m[3] ?? '';
    // a parameter opened and never closed: the call was cut off, do not guess
    if ((body.match(/<parameter\b/g) ?? []).length !== (body.match(/<\/parameter>/g) ?? []).length) continue;
    const props = ((tool?.parameters as any)?.properties ?? {}) as Record<string, any>;
    const args: Record<string, unknown> = {};
    const pr = /<parameter\s+name="([^"]+)">([\s\S]*?)<\/parameter>/g;
    let q: RegExpExecArray | null;
    while ((q = pr.exec(body))) args[q[1]] = xmlValue(q[2], props[q[1]]);
    if (!Object.keys(args).length && Object.keys(props).length) continue;     // an empty call to a tool that takes input
    // a catalog-style dump carries placeholder values: a `finish` with summary "x" ended a first edit and the user
    // read "x" as its whole explanation. A real summary has words; drop the call and the loop asks again.
    if (name === 'finish' && (String(args.summary_for_user ?? '').match(/[\p{L}\p{N}']+/gu) ?? []).length < 3) continue;
    const key = `${name}:${JSON.stringify(args)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ id: `cli_${++callSeq}`, name, args });
  }
  return out;
}

export function parseProtocolReply(text: string, tools: ToolSchema[] = []): CompletionResponse {
  // The model sometimes sketches a draft object (or prose with braces) before its real answer: take
  // the LAST object that carries tool calls. Reading only the first one cost a whole wasted turn.
  const all = extractAllJson(text);
  const withCalls = all.filter((o) => o && (Array.isArray(o.tool_calls) || Array.isArray(o.toolCalls) || typeof o.name === 'string'));
  const j = withCalls.length ? withCalls[withCalls.length - 1] : (/<invoke\b/.test(text) ? null : extractJson(text));
  const list = !j ? [] : Array.isArray(j.tool_calls) ? j.tool_calls : Array.isArray(j.toolCalls) ? j.toolCalls : j.name ? [j] : [];
  const toolCalls: ToolCall[] = list.filter((c: any) => c && typeof c.name === 'string').map((c: any) => ({
    id: `cli_${++callSeq}`, name: c.name, args: (c.arguments ?? c.args ?? c.input ?? {}) as Record<string, unknown>,
  }));
  if (toolCalls.length) return { text: typeof j.thought === 'string' ? j.thought : '', toolCalls };
  const xml = parseXmlCalls(text, tools);
  if (xml.length) return { text: '', toolCalls: xml, repaired: 'xml' };
  return { text: j && typeof j.thought === 'string' ? j.thought : text, toolCalls: [], ...(looksLikeCalls(text) ? { malformed: true } : {}) };
}

export interface RunResult { code: number | null; stdout: string; stderr: string }

/** Minutes `zone` is ahead of UTC at `at` (Intl's own offset table; DST included). NaN for a zone it doesn't know. */
function zoneOffsetMin(zone: string, at: Date): number {
  try {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
      .formatToParts(at).map((p) => [p.type, p.value]));
    const wall = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute, +parts.second);
    return Math.round((wall - at.getTime()) / 60_000);
  } catch {
    return NaN;
  }
}

/** The next `h:m` wall-clock time in `zone` after `now`, as an instant. */
function nextInZone(h: number, m: number, zone: string, now: Date): Date | null {
  for (let day = 0; day <= 2; day++) {
    // that calendar day in the zone, at h:m, read as UTC, then moved by the zone's offset at that moment
    const off0 = zoneOffsetMin(zone, now);
    if (!Number.isFinite(off0)) return null;
    const local = new Date(now.getTime() + off0 * 60_000);
    const guess = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + day, h, m);
    const off = zoneOffsetMin(zone, new Date(guess - off0 * 60_000));
    const at = new Date(guess - off * 60_000);
    if (at.getTime() > now.getTime()) return at;
  }
  return null;
}

/**
 * When a Claude plan at its limit resets, from the CLI's own words (ISO), or null when they don't say. Known forms:
 * "Claude AI usage limit reached|1761170400" (epoch seconds), and "resets 3pm" or "resets 3:40pm (America/Chicago)",
 * the next such time in the zone it names, else on this computer's clock.
 */
export function limitResetsAt(text: string, now: Date): string | null {
  const epoch = /\|(\d{10})\b/.exec(text);
  if (epoch) return new Date(Number(epoch[1]) * 1000).toISOString();
  // any zone name in brackets; Intl decides whether it is one (America/Argentina/Buenos_Aires, Etc/GMT+3, GMT, EST)
  const at = /resets\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\b(?:\s*\(([A-Za-z][A-Za-z0-9_+\-/]{0,63})\))?/i.exec(text);
  if (!at) return null;
  const h = (Number(at[1]) % 12) + (at[3].toLowerCase() === 'p' ? 12 : 0);
  const m = Number(at[2] ?? 0);
  if (at[4]) {
    const zoned = nextInZone(h, m, at[4], now);
    if (zoned) return zoned.toISOString();
  }
  const d = new Date(now);
  d.setHours(h, m, 0, 0);
  if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
  return d.toISOString();
}

const CLAUDE_WINDOW: Record<string, string> = { five_hour: '5-hour', seven_day: 'Weekly', seven_day_opus: 'Weekly · Opus', seven_day_sonnet: 'Weekly · Sonnet', seven_day_fable: 'Weekly · Fable' };

/**
 * The windows in Claude Code's rate_limit_event (2.1.311: `rate_limit_info.unifiedWindows`, each with `utilization`
 * 0-1, `resetsAt` in epoch seconds and `status`). A window refused with no utilization counts as nothing left.
 */
export function claudeCodeWindows(info: any): LimitWindow[] | undefined {
  const w = info?.unifiedWindows;
  if (!w || typeof w !== 'object') return undefined;
  const out: LimitWindow[] = [];
  for (const [k, v] of Object.entries<any>(w)) {
    if (!v || typeof v !== 'object') continue;
    const used = typeof v.utilization === 'number' ? v.utilization : v.status === 'rejected' ? 1 : null;
    if (used === null) continue;
    out.push({ label: CLAUDE_WINDOW[k] ?? k.replace(/_/g, ' '), left: Math.max(0, Math.min(100, Math.round((1 - used) * 100))), ...(typeof v.resetsAt === 'number' ? { resetsAt: new Date(v.resetsAt * 1000).toISOString() } : {}) });
  }
  return out.length ? out : undefined;
}

/** The latest reset among the windows with nothing left: when Claude Code can answer again. */
function refusedReset(limits: LimitWindow[] | undefined): string | null {
  const at = (limits ?? []).filter((l) => l.left === 0 && l.resetsAt).map((l) => l.resetsAt!).sort().at(-1);
  return at ?? null;
}

export function runProcess(cmd: string, args: string[], input: string, opts: { cwd?: string; signal?: AbortSignal; timeoutMs?: number; env?: NodeJS.ProcessEnv; onLine?: (line: string) => void } = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    // An abort listener added after the abort never runs, so a request stopped before this point would
    // start the CLI, hand it the prompt and wait for it to finish on its own.
    if (opts.signal?.aborted) return reject(new AIError('cancelled', 'Stopped.'));
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env ?? childEnv(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = ''; let killed = false; let seen = 0;
    child.stdout.setEncoding('utf8').on('data', (d) => {
      stdout += d;
      if (!opts.onLine) return;
      let i: number;
      while ((i = stdout.indexOf('\n', seen)) >= 0) { opts.onLine(stdout.slice(seen, i)); seen = i + 1; }
    });
    child.stderr.setEncoding('utf8').on('data', (d) => { stderr += d; });
    const kill = () => { killed = true; child.kill(); };
    const timer = opts.timeoutMs ? setTimeout(kill, opts.timeoutMs) : null;
    opts.signal?.addEventListener('abort', kill, { once: true });
    child.on('error', (e) => { if (timer) clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', kill);
      if (opts.signal?.aborted) return reject(new AIError('cancelled', 'Stopped.'));
      if (killed) return reject(new AIError('cli_timeout', 'The AI took too long to answer.', { retryable: true }));
      resolve({ code, stdout, stderr });
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(input, 'utf8');
  });
}

function workDir(): string {
  const d = path.join(os.tmpdir(), 'reelstudio-cli');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

export interface CliOptions { model?: string; bin?: string; /** base environment for the CLI (ANTHROPIC_* and OPENAI_* are always removed) */ env?: NodeJS.ProcessEnv; /** args placed before the CLI's own (e.g. a script path) */ binArgs?: string[]; timeoutMs?: number; cwd?: string; extraArgs?: string[];
  /** what the CLI printed for `--version` when the app detected it (localClaude.ts, localCodex.ts) */
  cliVersion?: string }

// ---------------------------------------------------------------- provenance: what each call ran on

function jsonLines(text: string): any[] {
  return text.split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((x) => x && typeof x === 'object');
}

/** One `claude -p --output-format stream-json --verbose` call: the `system/init` event (claude_code_version), the
 * `assistant` events (message.model, what the API answered with) and the `result` event (usage). `<synthetic>` is
 * the model name Claude Code puts on a message it wrote itself after an error, so it is not a model that ran. */
export function claudeProvenance(events: any[], o: { requestedModel: string; effort?: string; cliVersion?: string }): CallProvenance {
  const init = events.find((e) => e?.type === 'system' && e.subtype === 'init');
  const u = events.filter((e) => e?.type === 'result').at(-1)?.usage;
  const models = [...new Set(events.filter((e) => e?.type === 'assistant').map((e) => e.message?.model)
    .filter((m): m is string => typeof m === 'string' && m !== '' && m !== '<synthetic>'))];
  const version = typeof init?.claude_code_version === 'string' && init.claude_code_version ? init.claude_code_version : o.cliVersion;
  return {
    provider: 'claude-cli', requestedModel: o.requestedModel,
    reportedModels: models.length ? models : NOT_REPORTED,
    cliVersion: version ?? NOT_REPORTED,
    effort: o.effort ?? null,
    usage: { input: reportedTokens(u?.input_tokens), output: reportedTokens(u?.output_tokens), cacheRead: reportedTokens(u?.cache_read_input_tokens), cacheWrite: reportedTokens(u?.cache_creation_input_tokens) },
  };
}

/** One `codex exec --json` call. Its events never name the model, so that stays "not reported". `turn.completed`
 * carries usage in OpenAI's convention: cached_input_tokens and cache_write_input_tokens are PART of input_tokens,
 * so they are taken out to match Claude's count. Codex leaves cache_write_input_tokens out when it is 0 and older
 * versions never send it, so its absence is "not reported" and input then keeps any writes it may hold. */
export function codexProvenance(stdout: string, o: { requestedModel: string | null; effort?: string; cliVersion?: string }): CallProvenance {
  const u = jsonLines(stdout).filter((e) => e.type === 'turn.completed').at(-1)?.usage;
  const cacheRead = reportedTokens(u?.cached_input_tokens);
  const cacheWrite = reportedTokens(u?.cache_write_input_tokens);
  const input = uncachedInput(reportedTokens(u?.input_tokens), cacheRead, cacheWrite);
  return {
    provider: 'codex-cli', requestedModel: o.requestedModel, reportedModels: NOT_REPORTED,
    cliVersion: o.cliVersion ?? NOT_REPORTED, effort: o.effort ?? null,
    usage: { input, output: reportedTokens(u?.output_tokens), cacheRead, cacheWrite },
  };
}

/** One stream-json user message for `claude -p --input-format stream-json`. */
export function userLine(text: string, images: { label: string; img: ImagePart }[]): string {
  const content: any[] = [{ type: 'text', text }];
  for (const { label, img } of images) {
    content.push({ type: 'text', text: `[${label}]` });
    content.push({ type: 'image', source: { type: 'base64', media_type: img.mime, data: img.base64 } });
  }
  return JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n';
}

/** The first user message identifies a conversation (task text + preloaded project). */
function conversationKey(req: CompletionRequest): string {
  const first = req.messages[0];
  const text = first && first.role === 'user' ? first.content.map((p: any) => p.text ?? '').join('') : '';
  return `${req.system.length}:${req.system.slice(0, 200)}|${text.length}:${text.slice(0, 2000)}`;
}

interface Waiter { resolve: (r: any) => void; reject: (e: unknown) => void; watch: TurnWatch }

/**
 * A stream-json line's news for the caller while it waits: a retry (`system`/`api_retry`, Claude Code 2.1.308's
 * SDKAPIRetryMessage), or a content block starting (`stream_event`, from --include-partial-messages): a thinking
 * block is the model reasoning, any other block is the answer itself.
 */
export function waitSignal(j: any): WaitSignal | null {
  if (j?.type === 'system' && j.subtype === 'api_retry') {
    return { kind: 'retrying', attempt: Number(j.attempt) || 1, max: Number(j.max_retries) || 0, delayMs: Number(j.retry_delay_ms) || 0, status: typeof j.error_status === 'number' ? j.error_status : null };
  }
  if (j?.type !== 'stream_event' || j.event?.type !== 'content_block_start') return null;
  const block = j.event.content_block?.type;
  return block === 'thinking' || block === 'redacted_thinking' ? { kind: 'thinking' } : { kind: 'answering' };
}

/** Answers are one JSON object of a few KB; this is far past any real one. */
const MAX_ANSWER_CHARS = 40_000;

/**
 * An answer that has gone wrong while it streams: empty placeholder tool tags repeating, or far longer than any real
 * answer. Seen in a real run: sonnet wrote `<invoke name="placeholder"></invoke>` for 531 s until its output limit,
 * then the CLI asked it to go on; that one turn of a first edit took 551 s and cost $1.65.
 */
export function runawayAnswer(text: string): boolean {
  return text.length > MAX_ANSWER_CHARS || (text.match(/<invoke name="placeholder">\s*<\/invoke>/g)?.length ?? 0) >= 3;
}
const runawayError = (text: string) =>
  new AIError('cli_runaway', 'Claude started repeating itself, so that answer was stopped.', { retryable: true, detail: `${text.length} chars: ${JSON.stringify(text.slice(0, 160))} … ${JSON.stringify(text.slice(-80))}` });


/** REELSTUDIO_CLI_TRACE=<file>: every stream-json line but the answer's text deltas, timed, for diagnosing a slow turn. */
function trace(j: any): void {
  const file = process.env.REELSTUDIO_CLI_TRACE;
  if (!file || j?.event?.type === 'content_block_delta') return;
  fs.appendFileSync(file, `${new Date().toISOString()} ${JSON.stringify(j).slice(0, 600)}\n`);
}

/** One turn: passes its wait news on (thinking and answering once, every retry) and notes where its time went. */
export class TurnWatch {
  private readonly t0 = Date.now();
  private thinkingMs: number | null = null;
  private answerMs: number | null = null;
  private retries = 0;
  /** the answer's text so far, for the runaway check and its error */
  text = '';
  /** set once the answer runs away (runawayAnswer); `stop` is then called to end the turn */
  runaway = false;
  stop: () => void = () => undefined;
  constructor(private readonly onWait?: (w: WaitSignal) => void) {}
  /** the plan's windows from the turn's last rate_limit_event (Claude Code sends one before it answers or refuses) */
  limits: LimitWindow[] | undefined;
  line(j: any): void {
    if (j?.type === 'rate_limit_event') { this.limits = claudeCodeWindows(j.rate_limit_info) ?? this.limits; return; }
    const delta = j?.type === 'stream_event' && j.event?.type === 'content_block_delta' && j.event.delta?.type === 'text_delta' ? String(j.event.delta.text ?? '') : null;
    if (delta !== null) {
      this.text += delta;
      if (!this.runaway && runawayAnswer(this.text)) { this.runaway = true; this.stop(); }
      return;
    }
    const sig = waitSignal(j);
    if (!sig) return;
    const ms = Date.now() - this.t0;
    if (sig.kind === 'retrying') this.retries++;
    else if (sig.kind === 'thinking') { if (this.thinkingMs !== null) return; this.thinkingMs = ms; }
    else { if (this.answerMs !== null) return; this.answerMs = ms; }
    this.onWait?.(sig);
  }
  timing(): NonNullable<CompletionResponse['timing']> {
    return { thinkingMs: this.thinkingMs, answerMs: this.answerMs, totalMs: Date.now() - this.t0, retries: this.retries };
  }
}

interface LiveSession {
  child: ChildProcessWithoutNullStreams;
  key: string;
  /** req.messages.length + 1 after the last answered turn: where the next delta starts */
  next: number;
  buf: string;
  closed: boolean;
  waiter: Waiter | null;
  idle: NodeJS.Timeout | null;
  /** the `system/init` event (sent once per process) and this turn's assistant events so far, for claudeProvenance */
  init: any;
  turn: any[];
}

/** `claude -p` with all built-in tools, MCP, skills and settings disabled: it only returns text.
 * With `session: true` ONE `claude` process serves a whole agent run: each turn sends only the new
 * tool results (the CLI keeps the history), saving its ~2.5 s start-up and the re-read of the whole
 * conversation on every turn. Any hiccup (process gone, a different conversation) falls back to a
 * fresh process with the full conversation, exactly as before. */
export class ClaudeCliProvider implements ModelProvider {
  readonly id = 'claude-cli' as const;
  readonly supportsImages = true;
  readonly reportsWaits = true;
  readonly model: string;
  private live: LiveSession | null = null;
  /** settles once every session process this provider ended has exited */
  private ending: Promise<void> = Promise.resolve();
  constructor(private readonly o: CliOptions & { session?: boolean; effort?: string } = {}) { this.model = o.model ?? 'sonnet'; }

  private args(): string[] {
    return [
      ...(this.o.binArgs ?? []),
      '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
      '--tools', '', '--strict-mcp-config', '--setting-sources', '', '--disable-slash-commands', '--no-session-persistence',
      '--model', this.model,
      ...(this.o.effort ? ['--effort', this.o.effort] : []),
      '--system-prompt', 'You are a precise assistant embedded in a desktop video editor. Follow the INSTRUCTIONS in the user message exactly and answer only in the requested JSON format.',
      ...(this.o.extraArgs ?? []),
    ];
  }

  /** Ends the live session (the agent loop calls this when a run ends) and settles once its process,
   * and any session ended before it, has exited: Stop waits for every process a note started. */
  dispose(): Promise<void> {
    const s = this.live; this.live = null;
    if (s) {
      if (s.idle) clearTimeout(s.idle);
      s.closed = true;
      try { s.child.stdin.end(); } catch { /* gone */ }
      const t = setTimeout(() => { try { s.child.kill(); } catch { /* gone */ } }, 3000);
      const exited = s.child.exitCode !== null || s.child.signalCode !== null ? Promise.resolve()
        : new Promise<void>((resolve) => s.child.once('close', () => resolve()));
      this.ending = Promise.all([this.ending, exited.finally(() => clearTimeout(t))]).then(() => undefined);
    }
    return this.ending;
  }

  private startSession(key: string): LiveSession {
    const child = spawn(this.o.bin ?? 'claude', this.args(), { cwd: this.o.cwd ?? workDir(), env: cliEnv(this.o.env), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const s: LiveSession = { child, key, next: 0, buf: '', closed: false, waiter: null, idle: null, init: null, turn: [] };
    let errTail = '';
    child.stderr.setEncoding('utf8').on('data', (d: string) => { errTail = (errTail + d).slice(-800); });
    child.stdout.setEncoding('utf8').on('data', (d: string) => {
      s.buf += d;
      let i: number;
      while ((i = s.buf.indexOf('\n')) >= 0) {
        const l = s.buf.slice(0, i); s.buf = s.buf.slice(i + 1);
        let j: any; try { j = JSON.parse(l); } catch { continue; }
        trace(j);
        // the CLI sends system/init once per process: kept for every turn's provenance (claudeProvenance)
        if (j?.type === 'system' && j.subtype === 'init') { s.init = j; continue; }
        if (j?.type !== 'result') {
          // only the assistant events name the model; the partial-message stream_events stay out of the turn's record
          if (j?.type === 'assistant') s.turn.push(j);
          s.waiter?.watch.line(j);
          continue;
        }
        const events = [...(s.init ? [s.init] : []), ...s.turn, j];
        s.turn = [];
        if (s.waiter) { const w = s.waiter; s.waiter = null; w.resolve({ result: j, events }); }
      }
    });
    const gone = (why: string) => {
      s.closed = true;
      if (this.live === s) this.live = null;
      if (s.waiter) { const w = s.waiter; s.waiter = null; w.reject(new AIError('cli_error', 'The AI did not answer.', { retryable: true, detail: `${why}: ${errTail}` })); }
    };
    child.on('error', (e) => gone(String(e?.message ?? e)));
    child.on('close', (code) => gone(`exit ${code}`));
    child.stdin.on('error', () => undefined);
    return s;
  }

  private async sessionTurn(req: CompletionRequest): Promise<{ result: any; events: any[]; watch: TurnWatch }> {
    const key = conversationKey(req);
    const cur = this.live;
    const continues = !!cur && !cur.closed && cur.key === key && cur.next > 0 && req.messages.length > cur.next
      && req.messages[cur.next - 1]?.role === 'assistant';
    let s: LiveSession;
    let rendered: { text: string; images: { label: string; img: ImagePart }[] };
    if (continues) { s = cur!; rendered = renderDelta(req, s.next); }
    else {
      void this.dispose();
      s = this.live = this.startSession(key);
      rendered = renderConversation(req);
    }
    if (s.idle) { clearTimeout(s.idle); s.idle = null; }
    const watch = new TurnWatch(req.onWait);
    const turn = await new Promise<{ result: any; events: any[] }>((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void) => { if (settled) return; settled = true; clearTimeout(timer); req.signal?.removeEventListener('abort', abort); fn(); };
      const timer = setTimeout(() => finish(() => { s.waiter = null; void this.dispose(); reject(new AIError('cli_timeout', 'The AI took too long to answer.', { retryable: true })); }), this.o.timeoutMs ?? 600_000);
      const abort = () => finish(() => { s.waiter = null; void this.dispose(); reject(new AIError('cancelled', 'Stopped.')); });
      if (req.signal?.aborted) return abort();
      req.signal?.addEventListener('abort', abort, { once: true });
      s.waiter = { resolve: (r) => finish(() => resolve(r)), reject: (e) => finish(() => reject(e)), watch };
      watch.stop = () => finish(() => { s.waiter = null; void this.dispose(); reject(runawayError(watch.text)); });
      try { s.child.stdin.write(userLine(rendered.text, rendered.images)); } catch (e) {
        finish(() => { s.waiter = null; reject(new AIError('cli_error', 'The AI did not answer.', { retryable: true, detail: String(e) })); });
      }
    });
    s.next = req.messages.length + 1;
    // an idle session must not outlive its run for long (a crashed caller never calls dispose)
    s.idle = setTimeout(() => { if (this.live === s) void this.dispose(); }, 120_000);
    s.idle.unref?.();
    return { ...turn, watch };
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    if (this.o.session && !req.jsonOnly) {
      const { result, events, watch } = await this.sessionTurn(req);
      return this.toResponse(result, events, req, watch);
    }
    const { text, images } = renderConversation(req);
    const line = userLine(text, images);
    const args = this.args();
    let r: RunResult;
    const watch = new TurnWatch(req.onWait);
    // a runaway answer stops the process the way Stop does, and is reported as itself
    const stop = new AbortController();
    const relay = () => stop.abort();
    req.signal?.addEventListener('abort', relay, { once: true });
    if (req.signal?.aborted) stop.abort();
    watch.stop = relay;
    try {
      const onLine = (l: string) => {
        let j: any;
        try { j = JSON.parse(l); } catch { return; }
        trace(j);
        watch.line(j);
      };
      r = await runProcess(this.o.bin ?? 'claude', args, line, { cwd: this.o.cwd ?? workDir(), signal: stop.signal, timeoutMs: this.o.timeoutMs ?? 600_000, onLine, env: cliEnv(this.o.env) });
    } catch (e: any) {
      if (watch.runaway) throw runawayError(watch.text);
      if (e instanceof AIError) throw e;
      throw new AIError('cli_missing', 'The claude command line tool is not installed or not on PATH.', { detail: e?.message });
    } finally {
      req.signal?.removeEventListener('abort', relay);
    }
    const events = jsonLines(r.stdout);
    const result = events.filter((x) => x.type === 'result').at(-1);
    if (!result) throw new AIError('cli_error', 'The AI did not answer.', { retryable: true, detail: `exit ${r.code}: ${r.stderr.slice(-500) || r.stdout.slice(-500)}` });
    return this.toResponse(result, events, req, watch);
  }

  private toResponse(result: any, events: any[], req: CompletionRequest, watch: TurnWatch): CompletionResponse {
    if (result.is_error) {
      const text = String(result.result ?? '');
      const limited = /limit|quota|rate/i.test(text) || result.api_error_status === 429;
      // the rate_limit_event's epoch is exact; the words are the fallback
      const resetsAt = limited ? refusedReset(watch.limits) ?? limitResetsAt(text, new Date()) : null;
      throw new AIError(limited ? 'cli_limited' : 'cli_error', limited ? claudeCodeLimitWords(text, resetsAt) : 'The AI had a problem answering.', {
        retryable: !limited, detail: text.slice(0, 500), ...(resetsAt ? { resetsAt } : {}), ...(watch.limits ? { limits: watch.limits } : {}),
      });
    }
    const reply = String(result.result ?? '');
    const parsed = req.jsonOnly ? { text: reply, toolCalls: [] } : parseProtocolReply(reply, req.tools);
    // `usage` feeds the token budget (agent.ts) and stays input + output only, as before; `provenance` measures
    const provenance = claudeProvenance(events, { requestedModel: this.model, effort: this.o.effort, cliVersion: this.o.cliVersion });
    return { ...parsed, raw: { reply }, usage: { input: result.usage?.input_tokens, output: result.usage?.output_tokens }, provenance, timing: watch.timing(), ...(watch.limits ? { limits: watch.limits } : {}) };
  }
}

/** `codex exec` (read-only sandbox, ephemeral, the person's own Codex config ignored). Measured live 2026-10-25:
 * a whole first edit on the Day 86 take, 17 tool calls in 4 min. */
export class CodexCliProvider implements ModelProvider {
  readonly id = 'codex-cli' as const;
  readonly supportsImages = true;
  readonly model?: string;
  /** `effort`: the reasoning level, passed as `-c model_reasoning_effort` (index.ts codexChoice) */
  constructor(private readonly o: CliOptions & { effort?: string } = {}) { this.model = o.model; }

  /** The binary the app found (index.ts), else `codex` on PATH. Never `process.execPath` + codex.js: inside the
   * Electron app process.execPath is Reel Studio itself, not Node. */
  private resolveBin(): string { return this.o.bin ?? 'codex'; }

  /** `--ignore-user-config`: the person's MCP servers, plugins and notify hooks from ~/.codex/config.toml never run
   * for an edit (their sign-in still works: it is not in that file). `--json` only changes stdout to JSONL events,
   * read for usage (codexProvenance); the reply still comes from the `-o` file. */
  args(imageArgs: string[], out: string): string[] {
    return ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '--ephemeral', '--color', 'never', '--ignore-user-config', '--json',
      ...(this.model ? ['-m', this.model] : []), ...imageArgs, '-o', out,
      ...(this.o.effort ? ['-c', `model_reasoning_effort="${this.o.effort}"`] : []), ...(this.o.extraArgs ?? []), '-'];
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const { text, images } = renderConversation(req);
    const dir = await fsp.mkdtemp(path.join(workDir(), 'codex-'));
    try {
      const imageArgs: string[] = [];
      for (const [k, { img }] of images.entries()) {
        const f = path.join(dir, `img${k}${img.mime === 'image/jpeg' ? '.jpg' : '.png'}`);
        await fsp.writeFile(f, Buffer.from(img.base64, 'base64'));
        imageArgs.push('-i', f);
      }
      const out = path.join(dir, 'last.txt');
      let r: RunResult;
      try {
        r = await runProcess(this.resolveBin(), this.args(imageArgs, out), text, { cwd: dir, signal: req.signal, timeoutMs: this.o.timeoutMs ?? 600_000, env: cliEnv(this.o.env) });
      } catch (e: any) {
        if (e instanceof AIError) throw e;
        throw new AIError('cli_missing', 'We could not start your Codex app. Connect ChatGPT again in Settings.', { detail: e?.message });
      }
      const reply = fs.existsSync(out) ? await fsp.readFile(out, 'utf8') : '';
      if (!reply.trim()) {
        const all = r.stderr + r.stdout;
        const limited = /usage limit|rate limit|429|quota/i.test(all);
        const resetsAt = limited ? limitResetsAt(all, new Date()) : null;
        throw new AIError(limited ? 'cli_limited' : 'cli_error', limited ? codexLimitWords(resetsAt) : 'The AI did not answer.', { detail: all.slice(-600), ...(resetsAt ? { resetsAt } : {}) });
      }
      const provenance = codexProvenance(r.stdout, { requestedModel: this.model ?? null, effort: this.o.effort, cliVersion: this.o.cliVersion });
      return { ...(req.jsonOnly ? { text: reply, toolCalls: [] } : parseProtocolReply(reply, req.tools)), provenance };
    } finally {
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
