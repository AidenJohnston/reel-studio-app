// @ts-check
// The MCP server another AI app (Claude Code, Claude Desktop, Codex, the ChatGPT desktop app) starts over stdio to use
// Reel Studio, when Settings › Editor › "Let other AI apps use Reel Studio" is on. It holds no project logic: it reads
// the access file the app writes beside this script (endpoint and token, readable only by the person), connects to the
// app's local endpoint, proves itself with the token and forwards each tool call (app/src/main/outside-access.ts).
// The tools are the person's own controls (list reels, read one, send a note, Stop), so everything an outside agent
// does goes through the reel's note queue and shows in the app as it happens.
//
// Plain JavaScript with no dependencies: the app copies it into its settings folder and the client runs it with the
// app's own binary as Node (ELECTRON_RUN_AS_NODE=1).
'use strict';
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
/** a line from the app or the client longer than this is not a message */
const MAX_LINE = 1024 * 1024;
const HELLO_TIMEOUT_MS = 5000;

const reel = { type: 'string', description: 'The reel\'s id, from list_reels.' };
/** What this server offers. The app checks every call again (outside-access.ts TOOL_NAMES and its argument rules). */
const TOOLS = [
  {
    name: 'list_reels',
    description: 'List the reels in Reel Studio, newest first: id, title, status, newest version, notes waiting, and whether a note is running.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_reel',
    description: 'Read one reel: its versions (number, title, the version it was made from), the note running now, the notes waiting their turn, and the latest lines of its notes.',
    inputSchema: { type: 'object', properties: { reel }, required: ['reel'], additionalProperties: false },
  },
  {
    name: 'send_note',
    description: 'Send a note to a reel\'s AI editor, exactly as the person types one on the Reel screen: it waits its turn behind notes already sent, then makes a new version. It shows in Reel Studio at once. Notes are plain words such as "cut the first sentence" or "make the subtitles smaller".',
    inputSchema: {
      type: 'object',
      properties: {
        reel,
        text: { type: 'string', description: 'What to change, in plain words (at most 4000 characters).' },
        base_version: { type: 'integer', minimum: 1, description: 'Change this saved version instead of the newest, which makes the new version a branch from it.' },
      },
      required: ['reel', 'text'],
      additionalProperties: false,
    },
  },
  {
    name: 'stop_note',
    description: 'Press Stop on the note running on a reel. Unless it was already saved, the note waits again at the top of the queue, and the notes behind it hold until the person sends them on.',
    inputSchema: { type: 'object', properties: { reel }, required: ['reel'], additionalProperties: false },
  },
];

const INSTRUCTIONS = 'Reel Studio makes short vertical videos (reels) from a person\'s talking-head recordings on this computer. '
  + 'These tools are the person\'s own controls: list_reels and get_reel read, send_note queues a note for the reel\'s AI editor, stop_note presses Stop. '
  + 'A note takes a minute or more; call get_reel to see it running and the version it made. Every version is kept, so nothing is lost.';

const NOT_REACHABLE = 'Reel Studio is not open, or "Let other AI apps use Reel Studio" is off in its Settings. Open Reel Studio, turn it on, then try again.';
/** what the app said when it ended the connection on purpose (outside-access.ts `bye`) */
const BYE = {
  reset: 'Reel Studio\'s access was reset, which disconnected this app. Restart this app\'s Reel Studio connection to use it again.',
  off: '"Let other AI apps use Reel Studio" was turned off in Reel Studio. Turn it on, then restart this app\'s Reel Studio connection.',
};

/** @param {unknown} m */
function reply(m) { process.stdout.write(JSON.stringify(m) + '\n'); }
/** @param {string} why */
function log(why) { process.stderr.write(`[reelstudio] ${why}\n`); }

const accessFile = process.argv[2] || path.join(__dirname, 'access.json');
/** the client's name from initialize, shown in Reel Studio's Settings while it is connected */
let clientName = '';

/** @type {{ sock: net.Socket, pending: Map<number, (m: any) => void> } | null} */
let conn = null;
/** @type {Promise<typeof conn> | null} */
let connecting = null;
/** set once the app ended the connection on purpose: no reconnecting until the client restarts this server */
/** @type {string | null} */
let ended = null;
let nextId = 1;

/** Connects and says hello. Resolves to the live connection, or throws a message for the person. */
function connect() {
  if (ended) return Promise.reject(new Error(ended));
  if (conn) return Promise.resolve(conn);
  connecting ??= (async () => {
    /** @type {{ endpoint?: unknown, token?: unknown }} */
    let access;
    try { access = JSON.parse(fs.readFileSync(accessFile, 'utf8')); } catch { throw new Error(NOT_REACHABLE); }
    if (typeof access.endpoint !== 'string' || typeof access.token !== 'string') throw new Error(NOT_REACHABLE);
    const sock = net.connect(access.endpoint);
    sock.setEncoding('utf8');
    /** @type {Map<number, (m: any) => void>} */
    const pending = new Map();
    let authed = false;
    let buf = '';
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error('Reel Studio did not answer. Try again.')); sock.destroy(); }, HELLO_TIMEOUT_MS);
      sock.on('connect', () => sock.write(JSON.stringify({ hello: { token: access.token, client: clientName } }) + '\n'));
      sock.on('data', (/** @type {string} */ d) => {
        buf += d;
        if (buf.length > MAX_LINE) { sock.destroy(); return; }
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          let m;
          try { m = JSON.parse(line); } catch { continue; }
          if (typeof m?.bye === 'string') { ended = BYE[/** @type {'reset' | 'off'} */ (m.bye)] ?? null; continue; }
          if (!authed) {
            clearTimeout(timer);
            if (m?.ok !== true) { reject(new Error(typeof m?.error === 'string' ? m.error : 'Reel Studio refused this connection.')); sock.destroy(); return; }
            authed = true;
            conn = { sock, pending };
            resolve(conn);
            continue;
          }
          const w = typeof m?.id === 'number' ? pending.get(m.id) : undefined;
          if (w) { pending.delete(m.id); w(m); }
        }
      });
      const gone = () => {
        clearTimeout(timer);
        if (conn?.sock === sock) conn = null;
        const why = ended ?? 'Reel Studio closed the connection. Try again.';
        for (const [id, w] of pending) { pending.delete(id); w({ id, error: why }); }
        reject(new Error(authed ? why : NOT_REACHABLE));
      };
      sock.on('close', gone);
      sock.on('error', (e) => { log(`socket: ${e.message}`); });
    });
  })().finally(() => { connecting = null; });
  return connecting;
}

/** @param {string} name @param {unknown} args @returns {Promise<{ text: string, isError: boolean }>} */
async function call(name, args) {
  let c;
  try { c = await connect(); } catch (e) { return { text: String(/** @type {any} */ (e)?.message ?? e), isError: true }; }
  const id = nextId++;
  const m = await new Promise((resolve) => {
    c.pending.set(id, resolve);
    c.sock.write(JSON.stringify({ id, call: { name, args } }) + '\n');
  });
  if (typeof m.error === 'string') return { text: m.error, isError: true };
  return { text: String(m.result?.content ?? ''), isError: !!m.result?.isError };
}

/** @param {any} msg */
async function handle(msg) {
  const { id, method, params } = msg ?? {};
  const isRequest = id !== undefined && id !== null;
  try {
    if (method === 'initialize') {
      const name = params?.clientInfo?.name;
      if (typeof name === 'string') clientName = name.replace(/[^\p{L}\p{N} ._-]/gu, '').slice(0, 40);
      const asked = params?.protocolVersion;
      const protocolVersion = PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0];
      return reply({ jsonrpc: '2.0', id, result: { protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'reelstudio', version: '1' }, instructions: INSTRUCTIONS } });
    }
    if (method === 'ping') return reply({ jsonrpc: '2.0', id, result: {} });
    if (method === 'tools/list') return reply({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    if (method === 'tools/call') {
      const r = await call(String(params?.name ?? ''), params?.arguments ?? {});
      return reply({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: r.text }], isError: r.isError } });
    }
    if (isRequest) reply({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
  } catch (e) {
    if (isRequest) reply({ jsonrpc: '2.0', id, error: { code: -32603, message: String(/** @type {any} */ (e)?.message ?? e) } });
  }
}

function main() {
  let ibuf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (/** @type {string} */ d) => {
    ibuf += d;
    if (ibuf.length > MAX_LINE && ibuf.indexOf('\n') < 0) { ibuf = ''; reply({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'message too long' } }); return; }
    let i;
    while ((i = ibuf.indexOf('\n')) >= 0) {
      const line = ibuf.slice(0, i).trim(); ibuf = ibuf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { reply({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); continue; }
      void handle(msg);
    }
  });
  // the client is gone: so is this server
  process.stdin.on('end', () => { conn?.sock.destroy(); process.exit(0); });
}

if (require.main === module) main();
module.exports = { TOOLS };
