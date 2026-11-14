// A stand-in for `claude -p --input-format stream-json --output-format stream-json` with an MCP
// config: it starts the configured server as claude does (stdio, its env merged over ours), and on
// each user message plays the next turn of the scenario (--scenario FILE) as MCP tool calls.
// Scenario: { turns: [[{name, args} | "hang"]], pidFile, inbox, initTools?, argvFile? }; "hang" never ends
// the turn (a slow model); initTools is the tool list the init event reports (claude lists what the model
// can call); argvFile receives the arguments this process was started with
'use strict';
const fs = require('node:fs');
// Whole or absent: a Stop can kill this process while it starts, and a reader must never find the file empty
// (a plain writeFileSync creates it before it writes). A temporary name in the same folder, then a rename.
const writeWhole = (file, text) => { fs.writeFileSync(file + '.part', text); fs.renameSync(file + '.part', file); };
const { spawn } = require('node:child_process');

const arg = (k) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : undefined; };
const scenario = JSON.parse(fs.readFileSync(arg('--scenario'), 'utf8'));
if (scenario.argvFile) writeWhole(scenario.argvFile, JSON.stringify(process.argv.slice(2)));
const cfg = JSON.parse(fs.readFileSync(arg('--mcp-config'), 'utf8')).mcpServers.reelstudio;
const out = (m) => process.stdout.write(JSON.stringify(m) + '\n');

const relay = spawn(cfg.command, cfg.args, { env: { ...process.env, ...cfg.env }, stdio: ['pipe', 'pipe', 'inherit'] });
const exited = new Promise((r) => relay.once('close', r));
writeWhole(scenario.pidFile, JSON.stringify({ claude: process.pid, relay: relay.pid }));
const waiting = new Map();
let rid = 0; let rbuf = '';
relay.stdout.setEncoding('utf8').on('data', (d) => {
  rbuf += d;
  let i;
  while ((i = rbuf.indexOf('\n')) >= 0) {
    const m = JSON.parse(rbuf.slice(0, i)); rbuf = rbuf.slice(i + 1);
    waiting.get(m.id)?.(m); waiting.delete(m.id);
  }
});
const request = (method, params) => new Promise((resolve) => {
  const id = ++rid;
  waiting.set(id, resolve);
  relay.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
});

let turn = 0; let msg = 0;
async function play(calls) {
  const id = `msg_${++msg}`;
  for (const [k, c] of calls.entries()) {
    if (c === 'hang') { setInterval(() => undefined, 1000); return new Promise(() => undefined); }
    out({ type: 'assistant', message: { id, content: [{ type: 'tool_use', id: `tu_${msg}_${k}`, name: `mcp__reelstudio__${c.name}`, input: c.args ?? {} }] } });
    const r = await request('tools/call', { name: c.name, arguments: c.args ?? {} });
    out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `tu_${msg}_${k}`, content: r.result?.content }] } });
  }
  out({ type: 'result', subtype: 'success', is_error: false, result: 'ok', usage: { input_tokens: 10, output_tokens: 5 } });
}

(async () => {
  await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-claude', version: '0' } });
  relay.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const list = await request('tools/list', {});
  const tools = scenario.initTools ?? (list.result?.tools ?? []).map((t) => `mcp__reelstudio__${t.name}`);
  const probe = tools.includes('mcp__reelstudio__harness_probe');
  if (scenario.starts) fs.appendFileSync(scenario.starts, (probe ? 'probe' : 'note') + '\n');
  if (probe && scenario.probe === 'refused') { process.stderr.write('MCP refused'); process.exit(1); }
  out({ type: 'system', subtype: 'init', tools, mcp_servers: [{ name: 'reelstudio', status: list.result ? 'connected' : 'failed' }] });
  let ibuf = '';
  let queue = Promise.resolve();
  process.stdin.setEncoding('utf8').on('data', (d) => {
    ibuf += d;
    let i;
    while ((i = ibuf.indexOf('\n')) >= 0) {
      const m = JSON.parse(ibuf.slice(0, i)); ibuf = ibuf.slice(i + 1);
      fs.appendFileSync(scenario.inbox, m.message.content[0].text + '\n---\n');
      const nonce = /nonce ([a-f0-9-]+)/.exec(m.message.content[0].text)?.[1];
      const t = probe ? (scenario.probe === 'pass' ? [{ name: 'harness_probe', args: { nonce } }] : []) : scenario.turns[turn++];
      queue = queue.then(() => play(t ?? []));
    }
  });
  process.stdin.on('end', () => queue.then(() => { relay.stdin.end(); return exited; }).then(() => process.exit(0)));
})();
