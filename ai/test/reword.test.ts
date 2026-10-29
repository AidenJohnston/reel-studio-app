import { expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { createAI } from '../src';
import { FakeHost, tmpDir } from './helpers';

/**
 * The environment the app's CLIs get, with a stand-in `codex` signed in with ChatGPT as the only thing on PATH, so
 * detection finds and runs it the way it would a real one and never sees a Codex installed on this machine. The
 * stand-in is Node under Codex's name (Windows lists only a real codex.exe and spawns no scripts), preloading a file
 * that answers `login status` as Codex does before Node looks for a script; `--version` is Node's own and exits 0.
 */
function codexStandIn(): NodeJS.ProcessEnv {
  const dir = tmpDir('codex ');
  const bin = path.join(dir, process.platform === 'win32' ? 'codex.exe' : 'codex');
  if (process.platform === 'win32') {
    try { fs.linkSync(process.execPath, bin); } catch { fs.copyFileSync(process.execPath, bin); }
  } else fs.symlinkSync(process.execPath, bin);
  const answer = path.join(dir, 'login-status.cjs');
  // argv[1] is Node's resolved "script" path (…/login); write synchronously, since exit can drop a pending pipe write
  fs.writeFileSync(answer, `const a = process.argv.slice(1);
if (a.length === 2 && require('path').basename(a[0]) === 'login' && a[1] === 'status') {
  require('fs').writeSync(2, 'Logged in using ChatGPT\\n');
  process.exit(0);
}
`);
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toUpperCase() !== 'PATH'));
  // NODE_OPTIONS reads a backslash inside quotes as an escape, so the path goes in with forward slashes
  return { ...env, PATH: dir, NODE_OPTIONS: `--require "${answer.replace(/\\/g, '/')}"` };
}

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
    const cli = codexStandIn();
    const ai = createAI({ host: new FakeHost(tmpDir()), settingsDir: tmpDir('settings '), anthropicBaseURL: url, allowPlaintextSecrets: true, dev: true, cliEnv: () => cli });
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
