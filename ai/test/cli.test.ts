import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ClaudeCliProvider, toolSchemas } from '../src';
import { extractJson, parseProtocolReply, renderConversation } from '../src/providers/cli';
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
