import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ClaudeCliProvider, toolSchemas } from '../src';
import { codexProvenance, extractJson, parseProtocolReply, renderConversation } from '../src/providers/cli';
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
    p.dispose();
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
