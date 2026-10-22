import { expect, it } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as http from 'node:http';
import { approxOutputTimes, createAI, loadProject } from '../src';
import { call, FakeHost, makeProject, ScriptedModel, tmpDir } from './helpers';

it('fails if a note’s status line names the wrong words, moment or direction (music turned down read as taken out), or says the video is ready mid-note', async () => {
  const { root, dir, transcript } = await makeProject();
  const p0 = await loadProject(dir);
  p0.cut.keep = [{ from: 'w0', to: 'w8' }, { from: 'w27', to: 'w56' }];
  p0.version = 1;
  p0.music = { ...p0.music, enabled: true, track: 'Library/Music/gentle.mp3', level: 'under-voice' };
  await fsp.writeFile(`${dir}/project.json`, JSON.stringify(p0));
  await fsp.writeFile(`${root}/Library/Music/gentle.mp3`, 'x');
  const at = approxOutputTimes(transcript, p0.cut.keep, p0.cut.gapCap).get('w29')!.s;
  const model = new ScriptedModel([
    { toolCalls: [call('set_cut', { keep: [{ from: 'w0', to: 'w8' }, { from: 'w27', to: 'w28' }, { from: 'w31', to: 'w56' }] }), call('set_gap_cap', { seconds: p0.cut.gapCap + 0.2 }), call('choose_music', { track: null, startAt: null, level: 'quiet' }), call('render_draft')] },
    { toolCalls: [call('finish', { summary_for_user: 'I cut "twenty bucks".' })] },
  ]);
  const ai = createAI({ host: new FakeHost(root), settingsDir: tmpDir('settings '), providerOverride: model });
  const said: string[] = [];
  await ai.applyNote(dir, 'cut "twenty bucks"', (e) => { if (e.type === 'status' && said.at(-1) !== e.message) said.push(e.message); });
  expect(said).toContain(`Cutting 2 words at 0:${String(Math.round(at)).padStart(2, '0')}`);
  expect(said).toContain('Giving the pauses more room');
  expect(said).toContain('Changing the music volume');
  expect(said).not.toContain('Taking out the music');
  expect(said).toContain('Making a preview of Version 2');
  expect(said).toContain('Making Version 2');
  expect(said.slice(0, -1)).not.toContain('Your video is ready');
});

it('fails if the version title call leaves the creator’s own key, uses the editing model, or runs on a connection with no small model', async () => {
  const bodies: any[] = [];
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    bodies.push({ body, key: req.headers['x-api-key'] });
    const text = body.stream ? '{"title": "Two words gone", "summary": "cut 2 words"}' : 'h';
    if (!body.stream) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'm', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const ev = (type: string, data: any) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    ev('message_start', { message: { id: 'm', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } });
    ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
    ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text } });
    ev('content_block_stop', { index: 0 });
    ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } });
    ev('message_stop', {});
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    const url = `http://127.0.0.1:${(server.address() as any).port}`;
    const ai = createAI({ host: new FakeHost(tmpDir()), settingsDir: tmpDir('settings '), anthropicBaseURL: url, allowPlaintextSecrets: true, dev: true });
    expect((await ai.setClaudeKey('sk-ant-mine')).connected).toBe(true);
    await ai.setModel('claude', 'claude-opus-5-5');
    expect(await ai.rewordVersion({ title: 'Shorter cut', summary: 'cut 2 words' })).toEqual({ title: 'Two words gone', summary: 'cut 2 words' });
    const asked = bodies.at(-1);
    expect([asked.body.model, asked.key]).toEqual(['claude-haiku-5-5', 'sk-ant-mine']);
    await ai.setActive('codex-cli');
    const before = bodies.length;
    expect(await ai.rewordVersion({ title: 'Shorter cut', summary: 'cut 2 words' })).toBeNull();
    expect(bodies.length).toBe(before);
  } finally {
    server.closeAllConnections?.(); server.close();
  }
});
