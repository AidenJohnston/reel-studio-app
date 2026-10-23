import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { ClaudeCliProvider, createAI, loadProject, saveProject, toolSchemas } from '../src';
import { planFastNote } from '../src/fastnote';
import { FakeHost, ScriptedModel, call, makeProject, tmpDir } from './helpers';

async function setup() {
  const { root, dir } = await makeProject();
  await fsp.writeFile(path.join(root, 'Library', 'Music', 'gentle.mp3'), 'x');
  const p = await loadProject(dir);
  p.music = { ...p.music, enabled: true, track: 'Library/Music/gentle.mp3', level: 'under-voice' };
  await saveProject(dir, p);
  return { root, dir, host: new FakeHost(root), settingsDir: tmpDir('settings ') };
}

describe('fast notes (no model turns)', () => {
  it('recognises only unambiguous whole-video notes', async () => {
    const { dir } = await setup();
    const p = await loadProject(dir);
    const kind = (n: string) => planFastNote(n, p)?.kind ?? null;
    expect(kind('make the captions smaller')).toBe('captions-smaller');
    expect(kind('Captions are too big!')).toBe('captions-smaller');
    expect(kind('bigger subtitles please')).toBe('captions-bigger');
    expect(kind('move the captions up')).toBe('captions-up');
    expect(kind('no captions')).toBe('captions-off');
    expect(kind('the music is too loud')).toBe('music-quieter');
    expect(kind('quieter music')).toBe('music-quieter');
    expect(kind('remove the music')).toBe('music-off');
    // a place in the video, two requests, a lasting preference, a question, other subjects: the AI
    for (const n of ['the music is too loud at the start', 'make the captions smaller and the music quieter',
      'always use smaller captions', 'captions smaller when I say twenty bucks', 'can the music be quieter?',
      'different music', 'add a picture of my dog', 'cut the part where I say B-flat', 'make it better',
      'captions say Oregon but I said Oregano']) expect(kind(n)).toBeNull();
    // already at the floor: the AI explains instead of a no-op
    p.captions.style = { ...(p.captions.style as any), size: 80 };
    expect(planFastNote('smaller captions', p)).toBeNull();
    p.music.level = 'quiet';
    expect(planFastNote('quieter music', p)).toBeNull();
  });

  it('moves captions down only as far as a two-line caption clears Instagram\'s caption and username', async () => {
    const { dir, host, settingsDir } = await setup();
    const p = await loadProject(dir);
    p.captions.style = { ...p.captions.style, position: 0.66 }; // Higher
    await saveProject(dir, p);
    const model = new ScriptedModel([new Error('the model must not be called for a fast note')]);
    const r: any = await createAI({ host, settingsDir, providerOverride: model }).applyNote(dir, 'captions lower', () => {});
    expect(r.fast).toBe('captions-down');
    expect((await loadProject(dir)).captions.style.position).toBe(0.72);
    // the default 0.75 is already as low as a two-line caption at size 105 goes: the AI reads that note
    p.captions.style = { ...p.captions.style, position: 0.75 };
    expect(planFastNote('captions lower', p)).toBeNull();
  });

  it('makes captions bigger without moving them, and says when that reaches Instagram\'s caption', async () => {
    const { dir, host, settingsDir } = await setup();
    const model = new ScriptedModel([new Error('the model must not be called for a fast note')]);
    const r: any = await createAI({ host, settingsDir, providerOverride: model }).applyNote(dir, 'bigger captions', () => {});
    expect(r.fast).toBe('captions-bigger');
    expect((await loadProject(dir)).captions.style).toMatchObject({ size: 121, position: 0.75 });
    expect(r.summary).toMatch(/^I made the captions a bit bigger\. .*under Instagram's own caption and username/);
    const p = await loadProject(dir);
    p.captions.style = { ...p.captions.style, size: 105, position: 0.66 };
    expect(planFastNote('bigger captions', p)!.summary).toBe('I made the captions a bit bigger.');
  });

  it('applies a simple note with one direct change and one final render, no model', async () => {
    const { dir, host, settingsDir } = await setup();
    const model = new ScriptedModel([new Error('the model must not be called for a fast note')]);
    const ai = createAI({ host, settingsDir, providerOverride: model });
    const size = Number((await loadProject(dir)).captions.style.size) || 105;
    const events: any[] = [];
    const r: any = await ai.applyNote(dir, 'make the captions smaller', (e) => events.push(e));
    expect(model.requests).toHaveLength(0);
    expect(r.fast).toBe('captions-smaller');
    expect(r.summary).toBe('I made the captions a bit smaller.');
    expect(r.changed).toEqual(['captions']);
    expect(Number((await loadProject(dir)).captions.style.size)).toBeLessThan(size);
    expect(host.calls.filter((c) => c.command === 'render').map((c) => c.args.includes('--draft'))).toEqual([false]);
    expect(events.some((e) => e.type === 'status' && e.phase === 'final')).toBe(true);
    // the reply goes out BEFORE the render that makes it true (the app shows it at once)
    const reply = events.findIndex((e) => e.type === 'reply');
    expect(events[reply]).toEqual({ type: 'reply', text: 'I made the captions a bit smaller.' });
    expect(reply).toBeLessThan(events.findIndex((e) => e.type === 'render'));
    expect((await loadProject(dir)).notes).toEqual([expect.objectContaining({ text: 'make the captions smaller', applied: ['captions'] })]);
  });

  it('a note the fast path cannot express goes to the AI, with the project preloaded', async () => {
    const { dir, host, settingsDir } = await setup();
    const model = new ScriptedModel([
      { toolCalls: [call('set_music_automation', { automation: [{ fromWord: 'w0', toWord: 'w8', gainDb: -6 }] }), call('render_draft')] },
      { toolCalls: [call('finish', { summary_for_user: 'I turned the music down at the start.' })] },
    ]);
    const ai = createAI({ host, settingsDir, providerOverride: model });
    const r: any = await ai.applyNote(dir, 'the music is too loud at the start', () => undefined);
    expect(r.fast).toBeUndefined();
    expect((model.requests[0].messages[0] as any).content[0].text).toMatch(/result of get_project/);
    // only the music changed, which a preview cannot show: no draft, just the final render
    expect(host.calls.filter((c) => c.command === 'render').map((c) => c.args.includes('--draft'))).toEqual([false]);
  });
});

describe('claude-cli live session', () => {
  it('keeps one process for a run and sends only the new tool results each turn', async () => {
    const dir = tmpDir();
    const log = path.join(dir, 'log.txt');
    const script = path.join(dir, 'fake-claude.js');
    // answers every stdin line with a result; logs its pid at start and what each turn contained
    fs.writeFileSync(script, `const fs=require('fs');fs.appendFileSync(${JSON.stringify(log)},'start '+process.pid+'\\n');let buf='';let n=0;
process.stdin.on('data',d=>{buf+=d;let i;while((i=buf.indexOf('\\n'))>=0){const l=buf.slice(0,i);buf=buf.slice(i+1);const m=JSON.parse(l);const t=m.message.content[0].text;n++;
fs.appendFileSync(${JSON.stringify(log)},'turn '+n+' '+(t.includes('# INSTRUCTIONS')?'full':'delta')+' '+(t.includes('RESULT-ONE')?'r1':'')+'\\n');
const reply=n===1?'{"tool_calls":[{"name":"get_project","arguments":{}}]}':'{"tool_calls":[{"name":"finish","arguments":{"summary_for_user":"ok"}}]}';
process.stdout.write(JSON.stringify({type:'result',is_error:false,result:reply})+'\\n')}});`);
    const p = new ClaudeCliProvider({ bin: process.execPath, binArgs: [script], session: true });
    const tools = toolSchemas(['get_project', 'finish']);
    const messages: any[] = [{ role: 'user', content: [{ type: 'text', text: 'TASK' }] }];
    const r1 = await p.complete({ system: 'SYS', tools, messages });
    expect(r1.toolCalls[0].name).toBe('get_project');
    messages.push({ role: 'assistant', text: '', toolCalls: r1.toolCalls });
    messages.push({ role: 'tool', results: [{ callId: r1.toolCalls[0].id, name: 'get_project', content: 'RESULT-ONE' }] });
    const r2 = await p.complete({ system: 'SYS', tools, messages });
    expect(r2.toolCalls[0].name).toBe('finish');
    p.dispose();
    const lines = fs.readFileSync(log, 'utf8').trim().split('\n');
    expect(lines.filter((l) => l.startsWith('start'))).toHaveLength(1);
    expect(lines.filter((l) => l.startsWith('turn'))).toEqual(['turn 1 full ', 'turn 2 delta r1']);
  });

  it('starts over with the full conversation when the process is gone', async () => {
    const dir = tmpDir();
    const script = path.join(dir, 'one-shot.js');
    // answers one line, then exits (like a crash between turns)
    fs.writeFileSync(script, `let b='';process.stdin.on('data',d=>{b+=d;if(b.includes('\\n')){const t=JSON.parse(b.split('\\n')[0]).message.content[0].text;process.stdout.write(JSON.stringify({type:'result',is_error:false,result:t.includes('# INSTRUCTIONS')?'{"tool_calls":[{"name":"finish","arguments":{"summary_for_user":"full"}}]}':'{"tool_calls":[]}'})+'\\n');process.exit(0)}});`);
    const p = new ClaudeCliProvider({ bin: process.execPath, binArgs: [script], session: true });
    const tools = toolSchemas(['finish']);
    const messages: any[] = [{ role: 'user', content: [{ type: 'text', text: 'TASK' }] }];
    const r1 = await p.complete({ system: 'SYS', tools, messages });
    await new Promise((r) => setTimeout(r, 300));
    messages.push({ role: 'assistant', text: '', toolCalls: r1.toolCalls });
    messages.push({ role: 'tool', results: [{ callId: 'x', name: 'finish', content: 'ok' }] });
    const r2 = await p.complete({ system: 'SYS', tools, messages });
    expect(r2.toolCalls[0]?.args).toEqual({ summary_for_user: 'full' });
    p.dispose();
  });
});

describe('CLI reply parsing', () => {
  it('takes the last object with tool calls when the model sketches a draft first', async () => {
    const { parseProtocolReply } = await import('../src/providers/cli');
    const reply = 'Plan:\n```json\n{"keep": [{"from": "w1"}]}\n```\nActually, here it is.\n{"thought":"go","tool_calls":[{"name":"set_cut","arguments":{"keep":[]}}]}';
    expect(parseProtocolReply(reply).toolCalls.map((c) => c.name)).toEqual(['set_cut']);
    const broken = '{"tool_calls": [ oops }\n{"thought":"x","tool_calls":[{"name":"finish","arguments":{"summary_for_user":"a {brace} \\"q\\""}}]}';
    expect(parseProtocolReply(broken).toolCalls[0].args).toEqual({ summary_for_user: 'a {brace} "q"' });
  });
});
