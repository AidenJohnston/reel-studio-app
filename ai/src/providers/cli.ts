// Dev/test providers that shell out to a logged-in CLI (`claude -p`, `codex exec`) and drive the
// SAME tool loop through a JSON protocol: the model replies with {"tool_calls":[...]} as text,
// we execute them and feed results back. Hidden unless `dev: true`. Never shown to users.
import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { AIError, ChatMessage, CompletionRequest, CompletionResponse, ImagePart, ModelProvider, ToolCall, ToolSchema } from '../types';
import { childEnv } from '../safety';

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

export function runProcess(cmd: string, args: string[], input: string, opts: { cwd?: string; signal?: AbortSignal; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env ?? childEnv(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = ''; let killed = false;
    child.stdout.setEncoding('utf8').on('data', (d) => { stdout += d; });
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

export interface CliOptions { model?: string; bin?: string; /** args placed before the CLI's own (e.g. a script path) */ binArgs?: string[]; timeoutMs?: number; cwd?: string; extraArgs?: string[] }

function userLine(text: string, images: { label: string; img: ImagePart }[]): string {
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

interface Waiter { resolve: (r: any) => void; reject: (e: unknown) => void }

interface LiveSession {
  child: ChildProcessWithoutNullStreams;
  key: string;
  /** req.messages.length + 1 after the last answered turn: where the next delta starts */
  next: number;
  buf: string;
  closed: boolean;
  waiter: Waiter | null;
  idle: NodeJS.Timeout | null;
}

/** `claude -p` with all built-in tools, MCP, skills and settings disabled: it only returns text.
 * With `session: true` ONE `claude` process serves a whole agent run: each turn sends only the new
 * tool results (the CLI keeps the history), saving its ~2.5 s start-up and the re-read of the whole
 * conversation on every turn. Any hiccup (process gone, a different conversation) falls back to a
 * fresh process with the full conversation, exactly as before. */
export class ClaudeCliProvider implements ModelProvider {
  readonly id = 'claude-cli' as const;
  readonly supportsImages = true;
  readonly model: string;
  private live: LiveSession | null = null;
  /** settles once every session process this provider ended has exited */
  private ending: Promise<void> = Promise.resolve();
  constructor(private readonly o: CliOptions & { session?: boolean; effort?: string } = {}) { this.model = o.model ?? 'sonnet'; }

  private args(): string[] {
    return [
      ...(this.o.binArgs ?? []),
      '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
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
    const child = spawn(this.o.bin ?? 'claude', this.args(), { cwd: this.o.cwd ?? workDir(), env: childEnv(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const s: LiveSession = { child, key, next: 0, buf: '', closed: false, waiter: null, idle: null };
    let errTail = '';
    child.stderr.setEncoding('utf8').on('data', (d: string) => { errTail = (errTail + d).slice(-800); });
    child.stdout.setEncoding('utf8').on('data', (d: string) => {
      s.buf += d;
      let i: number;
      while ((i = s.buf.indexOf('\n')) >= 0) {
        const l = s.buf.slice(0, i); s.buf = s.buf.slice(i + 1);
        let j: any; try { j = JSON.parse(l); } catch { continue; }
        if (j?.type === 'result' && s.waiter) { const w = s.waiter; s.waiter = null; w.resolve(j); }
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

  private async sessionTurn(req: CompletionRequest): Promise<any> {
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
    const result = await new Promise<any>((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void) => { if (settled) return; settled = true; clearTimeout(timer); req.signal?.removeEventListener('abort', abort); fn(); };
      const timer = setTimeout(() => finish(() => { s.waiter = null; void this.dispose(); reject(new AIError('cli_timeout', 'The AI took too long to answer.', { retryable: true })); }), this.o.timeoutMs ?? 600_000);
      const abort = () => finish(() => { s.waiter = null; void this.dispose(); reject(new AIError('cancelled', 'Stopped.')); });
      if (req.signal?.aborted) return abort();
      req.signal?.addEventListener('abort', abort, { once: true });
      s.waiter = { resolve: (r) => finish(() => resolve(r)), reject: (e) => finish(() => reject(e)) };
      try { s.child.stdin.write(userLine(rendered.text, rendered.images)); } catch (e) {
        finish(() => { s.waiter = null; reject(new AIError('cli_error', 'The AI did not answer.', { retryable: true, detail: String(e) })); });
      }
    });
    s.next = req.messages.length + 1;
    // an idle session must not outlive its run for long (a crashed caller never calls dispose)
    s.idle = setTimeout(() => { if (this.live === s) void this.dispose(); }, 120_000);
    s.idle.unref?.();
    return result;
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    if (this.o.session && !req.jsonOnly) return this.toResponse(await this.sessionTurn(req), req);
    const { text, images } = renderConversation(req);
    const line = userLine(text, images);
    const args = this.args();
    let r: RunResult;
    try {
      r = await runProcess(this.o.bin ?? 'claude', args, line, { cwd: this.o.cwd ?? workDir(), signal: req.signal, timeoutMs: this.o.timeoutMs ?? 600_000 });
    } catch (e: any) {
      if (e instanceof AIError) throw e;
      throw new AIError('cli_missing', 'The claude command line tool is not installed or not on PATH.', { detail: e?.message });
    }
    const result = r.stdout.split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((x) => x && x.type === 'result').at(-1);
    if (!result) throw new AIError('cli_error', 'The AI did not answer.', { retryable: true, detail: `exit ${r.code}: ${r.stderr.slice(-500) || r.stdout.slice(-500)}` });
    return this.toResponse(result, req);
  }

  private toResponse(result: any, req: CompletionRequest): CompletionResponse {
    if (result.is_error) {
      const limited = /limit|quota|rate/i.test(String(result.result ?? '')) || result.api_error_status === 429;
      throw new AIError(limited ? 'cli_limited' : 'cli_error', limited ? 'The AI hit its usage limit. Try again later.' : 'The AI had a problem answering.', { retryable: !limited, detail: String(result.result ?? '').slice(0, 500) });
    }
    const reply = String(result.result ?? '');
    const parsed = req.jsonOnly ? { text: reply, toolCalls: [] } : parseProtocolReply(reply, req.tools);
    return { ...parsed, raw: { reply }, usage: { input: result.usage?.input_tokens, output: result.usage?.output_tokens } };
  }
}

/** `codex exec` (read-only sandbox, ephemeral). Not yet tested against a live account. */
export class CodexCliProvider implements ModelProvider {
  readonly id = 'codex-cli' as const;
  readonly supportsImages = true;
  readonly model?: string;
  constructor(private readonly o: CliOptions = {}) { this.model = o.model; }

  private resolveBin(): { cmd: string; pre: string[] } {
    if (this.o.bin) return { cmd: this.o.bin, pre: [] };
    if (process.platform === 'win32') {
      // Spawning codex.cmd needs a shell; run its node entry point directly instead.
      const npmDir = path.join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
      if (fs.existsSync(npmDir)) return { cmd: process.execPath, pre: [npmDir] };
    }
    return { cmd: 'codex', pre: [] };
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
      const { cmd, pre } = this.resolveBin();
      const args = [...pre, 'exec', '--skip-git-repo-check', '--sandbox', 'read-only', '--ephemeral', '--color', 'never',
        ...(this.model ? ['-m', this.model] : []), ...imageArgs, '-o', out, ...(this.o.extraArgs ?? []), '-'];
      let r: RunResult;
      try {
        r = await runProcess(cmd, args, text, { cwd: dir, signal: req.signal, timeoutMs: this.o.timeoutMs ?? 600_000 });
      } catch (e: any) {
        if (e instanceof AIError) throw e;
        throw new AIError('cli_missing', 'The codex command line tool is not installed or not on PATH.', { detail: e?.message });
      }
      const reply = fs.existsSync(out) ? await fsp.readFile(out, 'utf8') : '';
      if (!reply.trim()) {
        const all = r.stderr + r.stdout;
        const limited = /usage limit|rate limit|429|quota/i.test(all);
        throw new AIError(limited ? 'cli_limited' : 'cli_error', limited ? 'The AI hit its usage limit. Try again later.' : 'The AI did not answer.', { detail: all.slice(-600) });
      }
      return req.jsonOnly ? { text: reply, toolCalls: [] } : parseProtocolReply(reply, req.tools);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
