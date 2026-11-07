import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ClaudeCliProvider, toolSchemas } from '../src';
import { turnTrace, waitWords } from '../src/agent';
import type { WaitSignal } from '../src/types';
import { codexProvenance, extractJson, limitResetsAt, parseProtocolReply, renderConversation, runawayAnswer } from '../src/providers/cli';
import { tmpDir } from './helpers';

describe('CLI JSON protocol', () => {
  it('extracts JSON from fenced / chatty replies', () => {
    expect(extractJson('Sure!\n```json\n{"a":{"b":"}"}}\n```')).toEqual({ a: { b: '}' } });
    expect(extractJson('no json')).toBeNull();
  });
  it('parses tool calls', () => {
    const r = parseProtocolReply('{"thought":"cut","tool_calls":[{"name":"set_cut","arguments":{"keep":[]}},{"name":"finish","arguments":{"summary_for_user":"x"}}]}');
    expect(r.toolCalls.map((c) => c.name)).toEqual(['set_cut', 'finish']);
    expect(r.text).toBe('cut');
    expect(parseProtocolReply('hello').toolCalls).toEqual([]);
  });
  it('renders the conversation with the tool catalog; only latest images attached', () => {
    const img = { type: 'image' as const, mime: 'image/png', base64: 'AA' };
    const { text, images } = renderConversation({
      system: 'SYS', tools: toolSchemas(['set_cut', 'finish']),
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'TASK' }] },
        { role: 'assistant', text: '', toolCalls: [{ id: '1', name: 'look_at_frames', args: {} }] },
        { role: 'tool', results: [{ callId: '1', name: 'look_at_frames', content: 'old', images: [img] }] },
        { role: 'assistant', text: '', toolCalls: [{ id: '2', name: 'look_at_frames', args: {} }] },
        { role: 'tool', results: [{ callId: '2', name: 'look_at_frames', content: 'new', images: [img, img] }] },
      ],
    });
    expect(text).toMatch(/SYS/); expect(text).toMatch(/- set_cut:/); expect(text).toMatch(/TASK/);
    expect(text).toMatch(/no longer attached/);
    expect(images).toHaveLength(2);
  });
  it('ClaudeCliProvider drives a (fake) claude binary via stream-json', async () => {
    const dir = tmpDir();
    const script = path.join(dir, 'fake-claude.js');
    fs.writeFileSync(script, `let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const m=JSON.parse(s.trim());const ok=m.message.content[0].text.includes('TOOLS:')&&process.argv.includes('--tools');process.stdout.write(JSON.stringify({type:'system'})+'\\n'+JSON.stringify({type:'result',is_error:false,result: ok?'{"tool_calls":[{"name":"finish","arguments":{"summary_for_user":"hi"}}]}':'bad'})+'\\n')})`);
    const p = new ClaudeCliProvider({ bin: process.execPath, binArgs: [script] });
    const r = await p.complete({ system: 'SYS', tools: toolSchemas(['finish']), messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }] });
    expect(r.toolCalls).toEqual([expect.objectContaining({ name: 'finish', args: { summary_for_user: 'hi' } })]);
  });
});

describe('Stop before the CLI starts', () => {
  // fails if a request already stopped (Stop pressed while the turn was being prepared) still starts the CLI and hands
  // it the prompt, which then runs until it finishes or times out
  it('rejects as stopped without running the CLI', async () => {
    const dir = tmpDir();
    const ran = path.join(dir, 'ran.txt');
    const script = path.join(dir, 'fake-claude.js');
    fs.writeFileSync(script, `require('fs').writeFileSync(${JSON.stringify(ran)}, 'ran');process.stdin.resume();`);
    const p = new ClaudeCliProvider({ bin: process.execPath, binArgs: [script] });
    const stop = new AbortController();
    stop.abort();
    await expect(p.complete({ system: 'SYS', tools: toolSchemas(['finish']), messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }], signal: stop.signal }))
      .rejects.toMatchObject({ code: 'cancelled' });
    expect(fs.existsSync(ran)).toBe(false);
  });
});

describe('waiting for Claude, said as it is', () => {
  // fails if the CLI's retries, its thinking and the start of its answer stay invisible (notes waited 543 s and 544 s
  // on one call while the screen said "Watching your video and planning the edit")
  it('passes on each retry, the start of thinking and the start of the answer once each, and times the turn', async () => {
    const dir = tmpDir();
    const script = path.join(dir, 'fake-claude.js');
    const ev = (event: object) => ({ type: 'stream_event', event });
    const lines = [
      { type: 'system', subtype: 'init' },
      { type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 10, retry_delay_ms: 500, error_status: 529, error: 'overloaded' },
      ev({ type: 'message_start' }),
      ev({ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } }),
      ev({ type: 'content_block_delta', index: 0 }),
      ev({ type: 'content_block_start', index: 1, content_block: { type: 'text' } }),
      ev({ type: 'content_block_start', index: 2, content_block: { type: 'text' } }),
      { type: 'result', is_error: false, result: '{"tool_calls":[{"name":"finish","arguments":{"summary_for_user":"hi"}}]}' },
    ];
    fs.writeFileSync(script, `process.stdin.resume();process.stdin.on('end',()=>{process.stdout.write(${JSON.stringify(lines.map((l) => JSON.stringify(l)).join('\n') + '\n')})})`);
    const seen: WaitSignal[] = [];
    const p = new ClaudeCliProvider({ bin: process.execPath, binArgs: [script] });
    const r = await p.complete({ system: 'SYS', tools: toolSchemas(['finish']), messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }], onWait: (w) => seen.push(w) });
    expect(seen).toEqual([{ kind: 'retrying', attempt: 1, max: 10, delayMs: 500, status: 529 }, { kind: 'thinking' }, { kind: 'answering' }]);
    expect(r.timing).toMatchObject({ retries: 1, thinkingMs: expect.any(Number), answerMs: expect.any(Number) });
  });

  it('says it waits after a quiet spell, that Claude is thinking after a long think, names a retry, and goes back to the step', async () => {
    const said: [string, boolean][] = [];
    const tick = () => new Promise((r) => setTimeout(r, 60));
    const w = waitWords({ id: 'claude-cli', reportsWaits: true }, (m, waiting) => said.push([m, waiting]), 'Picking your pictures', 30);
    await tick();
    w.onWait!({ kind: 'retrying', attempt: 2, max: 10, delayMs: 1000, status: 529 });
    w.onWait!({ kind: 'thinking' });
    await tick();
    w.onWait!({ kind: 'answering' });
    await tick();
    w.end();
    expect(said).toEqual([
      ['Waiting for Claude to answer', true],
      ['Claude is busy. Trying again (2 of 10)', true],
      ['Picking your pictures', false],
      ['Claude is thinking it through', true],
      ['Picking your pictures', false],
    ]);
    const quiet: string[] = [];
    const other = waitWords({ id: 'chatgpt' }, (m) => quiet.push(m), 'x', 10);
    await new Promise((r) => setTimeout(r, 40));
    other.end();
    expect([other.onWait, quiet]).toEqual([undefined, []]);
  });

  it('logs where a turn went', () => {
    expect(turnTrace({ thinkingMs: 2100, answerMs: 540_300, totalMs: 544_000, retries: 0 })).toBe('model turn 544.0 s: thinking from 2.1 s, answer from 540.3 s');
    expect(turnTrace({ thinkingMs: null, answerMs: null, totalMs: 30_000, retries: 2 })).toBe('model turn 30.0 s: no answer streamed, 2 retries');
  });
});

describe('a plan at its limit: when it resets', () => {
  // fails if a reel paused at its plan limit cannot say when it continues, though the CLI said
  it('reads the reset time from both forms the Claude Code CLI uses, or says it does not know', () => {
    const now = new Date(2026, 9, 23, 14, 5);
    expect(limitResetsAt('Claude AI usage limit reached|1761170400', now)).toBe(new Date(1761170400 * 1000).toISOString());
    expect(limitResetsAt("5-hour limit reached ∙ resets 3pm", now)).toBe(new Date(2026, 9, 23, 15, 0).toISOString());
  });

  // fails if a reset said in the CLI's named zone is read on this computer's clock instead
  it('reads "resets 3:40pm (America/Chicago)" in the zone it names, whatever zone this computer is in', () => {
    const now = new Date('2026-10-23T19:05:00Z'); // 2:05 pm in Chicago, 4:05 am on the 24th in Tokyo
    expect(limitResetsAt("You've hit your limit · resets 3:40pm (America/Chicago)", now)).toBe('2026-10-23T20:40:00.000Z');
    expect(limitResetsAt("You've hit your weekly limit · resets 9am (Asia/Tokyo)", now)).toBe('2026-10-24T00:00:00.000Z');
    expect(limitResetsAt('resets 9am (Europe/London)', now)).toBe('2026-10-24T08:00:00.000Z'); // BST, the day before the clocks change
    // a zone of three segments, and one-word zones Intl knows
    expect(limitResetsAt('resets 9am (America/Argentina/Buenos_Aires)', now)).toBe('2026-10-24T12:00:00.000Z');
    expect(limitResetsAt('resets 9am (GMT)', now)).toBe('2026-10-24T09:00:00.000Z');
    expect(limitResetsAt('resets 4pm (EST)', now)).toBe('2026-10-23T21:00:00.000Z');
    // a zone Intl doesn't know falls back to this computer's clock rather than failing
    expect(limitResetsAt('resets 9am (Mars/Olympus)', new Date(2026, 9, 23, 14, 5))).toBe(new Date(2026, 9, 24, 9, 0).toISOString());
  });

  it('reads the other forms, or says it does not know', () => {
    const now = new Date(2026, 9, 23, 14, 5);
    // a time already gone today is tomorrow's
    expect(limitResetsAt('limit reached, resets 9am', now)).toBe(new Date(2026, 9, 24, 9, 0).toISOString());
    expect(limitResetsAt('Claude usage limit reached', now)).toBeNull();
  });
});

describe('a runaway answer', () => {
  it('is empty placeholder tags repeating, or far longer than any real answer', () => {
    const tag = '\n<invoke name="placeholder">\n</invoke>\n'
    expect(runawayAnswer(tag.repeat(2))).toBe(false);
    expect(runawayAnswer(tag.repeat(3))).toBe(true);
    expect(runawayAnswer('{"thought":"cut","tool_calls":[]}')).toBe(false);
    expect(runawayAnswer('x'.repeat(40_001))).toBe(true);
  });

  // fails if a model that loops on placeholder tags is left to run to its output limit (551 s and $1.65 in a real run)
  it('is stopped as it streams, in a live session and in a one-off call, and reported so the loop asks again', async () => {
    const dir = tmpDir();
    const script = path.join(dir, 'fake-claude.js');
    const delta = JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '<invoke name="placeholder">\n</invoke>\n' } } });
    // answers with the loop, then never ends on its own
    fs.writeFileSync(script, `process.stdin.once('data',()=>{let n=0;const t=setInterval(()=>{process.stdout.write(${JSON.stringify(delta)}+'\\n');if(++n>50)clearInterval(t)},20)});setInterval(()=>{},1000)`);
    const req = { system: 'SYS', tools: toolSchemas(['finish']), messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'go' }] }] };
    for (const session of [true, false]) {
      const p = new ClaudeCliProvider({ bin: process.execPath, binArgs: [script], session });
      const t0 = Date.now();
      await expect(p.complete(req)).rejects.toMatchObject({ code: 'cli_runaway', retryable: true });
      expect(Date.now() - t0).toBeLessThan(5000);
      await p.dispose();
    }
  });
});

const fixture = (name: string) => path.join(__dirname, 'cli-output', name);

describe('what each CLI call ran on (provenance)', () => {
  it('claude-cli keeps the cache counts and the model the CLI reported, on every turn of a live session', async () => {
    const dir = tmpDir();
    const script = path.join(dir, 'fake-claude.js');
    // like `claude -p --input-format stream-json`: system/init once at start, then assistant + result per stdin line;
    // the second turn answers on another model with other cache counts (a fallback), so turns must not blend
    fs.writeFileSync(script, `const lines=require('fs').readFileSync(${JSON.stringify(fixture('claude-stream.jsonl'))},'utf8').trim().split('\\n');
process.stdout.write(lines[0]+'\\n');let buf='';let n=0;
const turn=(l)=>n===1?l:l.split('claude-sonnet-5-5-20261001').join('claude-opus-5-5').split('"cache_read_input_tokens":18000').join('"cache_read_input_tokens":7');
process.stdin.on('data',d=>{buf+=d;let i;while((i=buf.indexOf('\\n'))>=0){buf=buf.slice(i+1);n++;process.stdout.write(turn(lines[1])+'\\n'+turn(lines[2])+'\\n')}});`);
    const p = new ClaudeCliProvider({ bin: process.execPath, binArgs: [script], session: true, cliVersion: '2.1.0' });
    const tools = toolSchemas(['finish']);
    const messages: any[] = [{ role: 'user', content: [{ type: 'text', text: 'TASK' }] }];
    const r1 = await p.complete({ system: 'SYS', tools, messages });
    messages.push({ role: 'assistant', text: '', toolCalls: r1.toolCalls });
    messages.push({ role: 'tool', results: [{ callId: r1.toolCalls[0].id, name: 'finish', content: 'ok' }] });
    const r2 = await p.complete({ system: 'SYS', tools, messages });
    await p.dispose();
    const expected = {
      provider: 'claude-cli', requestedModel: 'sonnet', reportedModels: ['claude-sonnet-5-5-20261001'],
      cliVersion: '2.1.296', effort: null, usage: { input: 12, output: 240, cacheRead: 18000, cacheWrite: 5321 },
    };
    expect(r1.provenance).toEqual(expected);
    // init came once, with the first turn; the second turn still knows the version and reports only its own model
    expect(r2.provenance).toEqual({ ...expected, reportedModels: ['claude-opus-5-5'], usage: { ...expected.usage, cacheRead: 7 } });
    // the token budget still sees input + output only (measurement must not change when a run stops)
    expect(r1.usage).toEqual({ input: 12, output: 240 });
  });

  it('codex-cli: turn.completed usage, with cached input taken out of input; no model or cache write reported', () => {
    expect(codexProvenance(fs.readFileSync(fixture('codex-exec.jsonl'), 'utf8'), { requestedModel: null, cliVersion: '0.165.0' })).toEqual({
      provider: 'codex-cli', requestedModel: null, reportedModels: 'not reported', cliVersion: '0.165.0', effort: null,
      usage: { input: 4000, output: 900, cacheRead: 20000, cacheWrite: 'not reported' },
    });
  });

  it('codex-cli: a stream without usage is "not reported", never 0', () => {
    expect(codexProvenance(fs.readFileSync(fixture('codex-exec-no-usage.jsonl'), 'utf8'), { requestedModel: 'gpt-5.5' }).usage)
      .toEqual({ input: 'not reported', output: 'not reported', cacheRead: 'not reported', cacheWrite: 'not reported' });
  });
});
