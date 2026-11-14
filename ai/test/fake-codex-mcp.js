'use strict';
const fs = require('node:fs');
// Whole or absent: a Stop can kill this process while it starts, and a reader must never find the file empty
// (a plain writeFileSync creates it before it writes). A temporary name in the same folder, then a rename.
const writeWhole = (file, text) => { fs.writeFileSync(file + '.part', text); fs.renameSync(file + '.part', file); };
const { spawn } = require('node:child_process');
const argv = process.argv.slice(2);
const arg = (k) => argv[argv.indexOf(k) + 1];
const scenario = JSON.parse(fs.readFileSync(arg('--scenario'), 'utf8'));
if (scenario.argvFile) writeWhole(scenario.argvFile, JSON.stringify(argv));
const config = new Map();
for (let i = 0; i < argv.length; i++) if (argv[i] === '-c') {
  const v = argv[++i]; const eq = v.indexOf('=');
  try { config.set(v.slice(0, eq), JSON.parse(v.slice(eq + 1))); } catch { config.set(v.slice(0, eq), v.slice(eq + 1)); }
}
const out = (m) => process.stdout.write(JSON.stringify(m) + '\n');
const relay = spawn(config.get('mcp_servers.reelstudio.command'), config.get('mcp_servers.reelstudio.args'), { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['pipe', 'pipe', 'inherit'] });
writeWhole(scenario.pidFile, JSON.stringify({ codex: process.pid, relay: relay.pid }));
const closed = new Promise((r) => relay.once('close', r));
let id = 0, buf = '';
const waiting = new Map();
relay.stdout.setEncoding('utf8').on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
    waiting.get(m.id)?.(m); waiting.delete(m.id);
  }
});
const request = (method, params) => new Promise((resolve) => {
  const rid = ++id; waiting.set(rid, resolve);
  relay.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: rid, method, params }) + '\n');
});
(async () => {
  let input = '';
  for await (const d of process.stdin) input += d;
  await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-codex', version: '0' } });
  await request('tools/list', {});
  if (scenario.error) { out({ type: 'error', message: scenario.error }); relay.stdin.end(); await closed; return; }
  const probe = config.get('mcp_servers.reelstudio.enabled_tools').includes('harness_probe');
  if (scenario.starts) fs.appendFileSync(scenario.starts, (probe ? 'probe' : 'note') + '\n');
  const nonce = /nonce ([a-f0-9-]+)/.exec(input)?.[1];
  const turns = probe ? [[{ name: 'harness_probe', args: { nonce } }]] : scenario.turns;
  for (const calls of turns) for (const c of calls) {
    if (c === 'hang') { setInterval(() => undefined, 1000); return; }
    const item = { id: String(id), type: 'mcp_tool_call', server: 'reelstudio', tool: c.name, arguments: c.args ?? {} };
    out({ type: 'item.started', item: { ...item, status: 'in_progress' } });
    const result = await request('tools/call', { name: c.name, arguments: c.args ?? {} });
    out({ type: 'item.completed', item: { ...item, status: 'completed', result: result.result } });
  }
  out({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5, cached_input_tokens: 0 } });
  relay.stdin.end(); await closed;
})();
