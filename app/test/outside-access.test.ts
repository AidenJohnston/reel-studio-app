// Settings › Editor › "Let other AI apps use Reel Studio" (main/outside-access.ts) and the relay an outside AI app runs
// (ai/relay/reelstudio-mcp.js), over real sockets or named pipes, with stand-in controls.
import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs'
import * as net from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createOutsideAccess, NOTE_MAX, setupFor, TOOL_NAMES, type OutsideAccess, type OutsideControls } from '../src/main/outside-access'

const RELAY = resolve(__dirname, '..', '..', 'ai', 'relay', 'reelstudio-mcp.js')
const posix = process.platform !== 'win32'

/** Stand-in controls that record what reached them. */
function controls(slowMs = 0) {
  const calls: { name: string; args: unknown[] }[] = []
  const slow = () => new Promise((r) => setTimeout(r, slowMs))
  const c: OutsideControls = {
    listReels: async () => (calls.push({ name: 'list_reels', args: [] }), JSON.stringify({ reels: [{ reel: 'my-reel' }] })),
    getReel: async (r) => (calls.push({ name: 'get_reel', args: [r] }), JSON.stringify({ reel: r })),
    sendNote: async (r, t, b) => (calls.push({ name: 'send_note', args: [r, t, b] }), await slow(), 'Sent.'),
    addToRunningNote: async (r, t) => (calls.push({ name: 'add_to_running_note', args: [r, t] }), 'Added.'),
    stopNote: async (r) => (calls.push({ name: 'stop_note', args: [r] }), 'Stopped.')
  }
  return { c, calls }
}

const opened: OutsideAccess[] = []
const children: ChildProcessWithoutNullStreams[] = []
afterEach(async () => {
  for (const ch of children.splice(0)) ch.kill()
  for (const o of opened.splice(0)) await o.close()
})

function open(dir = mkdtempSync(join(tmpdir(), 'oa-')), slowMs = 0) {
  const { c, calls } = controls(slowMs)
  const access = createOutsideAccess({ dir, platform: process.platform, command: process.execPath, relaySource: async () => readFileSync(RELAY, 'utf8'), controls: c })
  opened.push(access)
  return { access, calls, dir, file: join(dir, 'access.json') }
}

/** A raw connection speaking the app's side of the protocol. */
function connect(endpoint: string) {
  const sock = net.connect(endpoint)
  sock.setEncoding('utf8')
  const lines: any[] = []
  let buf = ''
  let wake: (() => void) | null = null
  sock.on('data', (d: string) => {
    buf += d
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      lines.push(JSON.parse(buf.slice(0, i)))
      buf = buf.slice(i + 1)
    }
    wake?.()
  })
  const closed = new Promise<void>((r) => sock.on('close', () => r()))
  sock.on('error', () => undefined)
  const next = async (): Promise<any> => {
    while (!lines.length) await new Promise<void>((r) => (wake = r))
    return lines.shift()
  }
  return { send: (m: unknown) => sock.write(JSON.stringify(m) + '\n'), next, closed, sock }
}
const accessOf = (file: string): { endpoint: string; token: string } => JSON.parse(readFileSync(file, 'utf8'))

describe('the endpoint', () => {
  it('fails if a connection without the right token can call a tool', async () => {
    const { access, calls, file } = open()
    await access.enable()
    const { endpoint, token } = accessOf(file)
    // same length, so only the comparison itself can refuse it
    const wrong = connect(endpoint)
    wrong.send({ hello: { token: token.replace(/^./, (ch) => (ch === 'A' ? 'B' : 'A')) } })
    expect(await wrong.next()).toEqual({ error: 'Reel Studio refused this connection.' })
    wrong.send({ id: 1, call: { name: 'send_note', args: { reel: 'my-reel', text: 'cut it' } } })
    await wrong.closed
    const none = connect(endpoint)
    none.send({ id: 1, call: { name: 'list_reels', args: {} } })
    expect(await none.next()).toEqual({ error: 'Reel Studio refused this connection.' })
    expect(calls).toEqual([])
  })

  it('fails if a call with the token does not reach the controls, or an unknown tool or argument does', async () => {
    const { access, calls, file } = open()
    await access.enable()
    const { endpoint, token } = accessOf(file)
    const c = connect(endpoint)
    c.send({ hello: { token, client: 'Claude Code' } })
    expect(await c.next()).toEqual({ ok: true })
    expect(access.status().connected).toEqual(['Claude Code'])
    c.send({ id: 1, call: { name: 'send_note', args: { reel: 'my-reel', text: '  cut the intro ', base_version: 2 } } })
    expect(await c.next()).toEqual({ id: 1, result: { content: 'Sent.', isError: false } })
    const refused: [string, unknown][] = [
      ['delete_reel', { reel: 'my-reel' }],
      ['send_note', { reel: 'my-reel', text: 'x', path: '/etc/passwd' }],
      ['send_note', { reel: '../other', text: 'x' }],
      ['send_note', { reel: 'my-reel', text: 'x'.repeat(NOTE_MAX + 1) }],
      ['send_note', { reel: 'my-reel', text: '   ' }],
      ['send_note', { reel: 'my-reel', text: 'x', base_version: 1.5 }],
      ['get_reel', []]
    ]
    let id = 2
    for (const [name, args] of refused) {
      c.send({ id, call: { name, args } })
      const r = await c.next()
      expect(r.id).toBe(id++)
      expect(r.result.isError).toBe(true)
    }
    expect(calls).toEqual([{ name: 'send_note', args: ['my-reel', 'cut the intro', 2] }])
  })

  it('fails if calls queued on a connection still run after it closed', async () => {
    // each note takes a moment, as a real send does, so the connection closes while the first one runs
    const { access, calls, file } = open(undefined, 150)
    await access.enable()
    const { endpoint, token } = accessOf(file)
    const c = connect(endpoint)
    c.send({ hello: { token } })
    await c.next()
    // three notes in one write, then gone: only a call already running may finish
    c.sock.end([1, 2, 3].map((id) => JSON.stringify({ id, call: { name: 'send_note', args: { reel: 'my-reel', text: `note ${id}` } } })).join('\n') + '\n')
    await c.closed
    await new Promise((r) => setTimeout(r, 600))
    expect(calls.length).toBeLessThanOrEqual(1)
  })

  it('fails if a message longer than the limit is read instead of the connection being closed', async () => {
    const { access, calls, file } = open()
    await access.enable()
    const { endpoint, token } = accessOf(file)
    const c = connect(endpoint)
    c.send({ hello: { token } })
    await c.next()
    c.sock.write(JSON.stringify({ id: 1, call: { name: 'send_note', args: { reel: 'my-reel', text: 'y'.repeat(100_000) } } }))
    await c.closed
    expect(calls).toEqual([])
  })

  it('fails if turning it off leaves the endpoint, the access file or a connection open', async () => {
    const { access, file } = open()
    await access.enable()
    const { endpoint, token } = accessOf(file)
    const c = connect(endpoint)
    c.send({ hello: { token } })
    await c.next()
    await access.disable()
    expect(await c.next()).toEqual({ bye: 'off' })
    await c.closed
    expect(existsSync(file)).toBe(false)
    expect(access.status()).toEqual({ on: false, connected: [], setup: null })
    const after = net.connect(endpoint)
    await expect(new Promise((res, rej) => (after.on('connect', res), after.on('error', rej)))).rejects.toThrow()
  })

  it('fails if Reset access keeps a connection open or the old token working', async () => {
    const { access, calls, file } = open()
    await access.enable()
    const before = accessOf(file)
    const c = connect(before.endpoint)
    c.send({ hello: { token: before.token } })
    await c.next()
    await access.reset()
    expect(await c.next()).toEqual({ bye: 'reset' })
    await c.closed
    const now = accessOf(file)
    expect(now.token).not.toBe(before.token)
    const old = connect(now.endpoint)
    old.send({ hello: { token: before.token } })
    expect(await old.next()).toEqual({ error: 'Reel Studio refused this connection.' })
    const fresh = connect(now.endpoint)
    fresh.send({ hello: { token: now.token } })
    expect(await fresh.next()).toEqual({ ok: true })
    expect(calls).toEqual([])
  })

  it.skipIf(!posix)('fails if the token file, the socket or their folder can be read by another user', async () => {
    const { access, dir, file } = open()
    await access.enable()
    const mode = (p: string) => statSync(p).mode & 0o777
    expect(mode(dir)).toBe(0o700)
    expect(mode(file)).toBe(0o600)
    expect(mode(accessOf(file).endpoint)).toBe(0o600)
  })

  it.skipIf(!posix)('fails if a settings folder too long for a Unix socket path leaves access unable to turn on', async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'oa-')), 'Application Support', 'Reel Studio Nightly with a long name', 'mcp'.padEnd(60, 'x'))
    const { access, calls, file } = open(dir)
    await access.enable()
    const { endpoint, token } = accessOf(file)
    expect(Buffer.byteLength(endpoint)).toBeLessThanOrEqual(103)
    const c = connect(endpoint)
    c.send({ hello: { token } })
    expect(await c.next()).toEqual({ ok: true })
    c.send({ id: 1, call: { name: 'list_reels', args: {} } })
    expect((await c.next()).result.isError).toBe(false)
    expect(calls).toHaveLength(1)
  })
})

/** The relay as an outside AI app runs it, spoken to over its stdio as an MCP client. */
function relay(script: string) {
  const ch = spawn(process.execPath, [script], { stdio: ['pipe', 'pipe', 'pipe'] })
  children.push(ch)
  ch.stdout.setEncoding('utf8')
  const waiting = new Map<number, (m: any) => void>()
  let buf = ''
  ch.stdout.on('data', (d: string) => {
    buf += d
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const m = JSON.parse(buf.slice(0, i))
      buf = buf.slice(i + 1)
      waiting.get(m.id)?.(m)
    }
  })
  let id = 0
  const rpc = (method: string, params: unknown): Promise<any> =>
    new Promise((r) => {
      const n = ++id
      waiting.set(n, r)
      ch.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n')
    })
  const call = async (name: string, args: unknown) => (await rpc('tools/call', { name, arguments: args })).result
  return { rpc, call }
}

describe('the relay', () => {
  it('fails if an outside AI app cannot list the tools, send a note through the controls and see why it was cut off', async () => {
    const { access, calls } = open()
    await access.enable()
    const client = relay(access.script)
    const init = await client.rpc('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'claude-code' }, capabilities: {} })
    expect(init.result.serverInfo.name).toBe('reelstudio')
    const tools = (await client.rpc('tools/list', {})).result.tools.map((t: { name: string }) => t.name)
    // the relay's list is what the app accepts: a tool on one side only would fail every call to it
    expect(tools).toEqual([...TOOL_NAMES])
    expect(await client.call('send_note', { reel: 'my-reel', text: 'cut the intro' })).toEqual({ content: [{ type: 'text', text: 'Sent.' }], isError: false })
    expect(calls).toEqual([{ name: 'send_note', args: ['my-reel', 'cut the intro', undefined] }])
    expect(access.status().connected).toEqual(['claude-code'])
    await access.reset()
    const cut = await client.call('list_reels', {})
    expect(cut.isError).toBe(true)
    expect(cut.content[0].text).toMatch(/access was reset/)
    // it does not quietly reconnect with the new token: Reset access means the app has to be restarted
    expect(await client.call('list_reels', {})).toMatchObject({ isError: true })
    expect(calls).toHaveLength(1)
    // a restarted one connects with the new token
    const again = relay(access.script)
    await again.rpc('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'codex' }, capabilities: {} })
    expect((await again.call('list_reels', {})).isError).toBe(false)
  })

  it('fails if the relay, started while access is off, crashes or hides why instead of saying what to turn on', async () => {
    const { access } = open()
    await access.enable()
    const script = access.script
    await access.disable()
    const client = relay(script)
    await client.rpc('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'codex' }, capabilities: {} })
    const r = await client.call('list_reels', {})
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toMatch(/Let other AI apps use Reel Studio/)
  })
})

describe('the setup lines', () => {
  const command = '/Applications/Reel Studio.app/Contents/MacOS/Reel Studio'
  const script = "/Users/O'Neil Zoë/Library/Application Support/Reel Studio/mcp/reelstudio-mcp.js"

  it.skipIf(!posix)('fails if a pasted command splits a path with spaces or a quote into the wrong arguments', () => {
    const s = setupFor(command, script, 'darwin')
    for (const [line, tool] of [[s.claudeCode, 'claude'], [s.codex, 'codex']] as const) {
      expect(line.startsWith(`${tool} mcp add `)).toBe(true)
      // the shell's own word splitting: what claude or codex would receive as its arguments
      const argv = execFileSync('sh', ['-c', `printf '%s\\n' ${line.slice(tool.length + 1)}`], { encoding: 'utf8' }).trimEnd().split('\n')
      expect(argv.slice(argv.indexOf('--') + 1)).toEqual([command, script])
      expect(argv).toContain('ELECTRON_RUN_AS_NODE=1')
      expect(argv[argv.indexOf('--') - 1]).toBe('reelstudio')
    }
  })

  it('fails if a Windows command lets PowerShell expand or split a path', () => {
    const win = "C:\\Users\\$Sam O'Neil\\AppData\\Local\\Programs\\Reel Studio\\Reel Studio.exe"
    const s = setupFor(win, 'C:\\x\\reelstudio-mcp.js', 'win32')
    // PowerShell reads '...' literally: no $ expansion, a ' doubled, and '--' is not taken for its own end of parameters
    expect(s.claudeCode).toBe(`claude mcp add --scope user --env ELECTRON_RUN_AS_NODE=1 --transport stdio reelstudio '--' 'C:\\Users\\$Sam O''Neil\\AppData\\Local\\Programs\\Reel Studio\\Reel Studio.exe' 'C:\\x\\reelstudio-mcp.js'`)
    expect(s.codexToml).toContain(`command = ${JSON.stringify(win)}`)
  })

  it('fails if the Claude Desktop entry does not start the relay with the app as Node', () => {
    const win = 'C:\\Program Files\\Reel Studio\\Reel Studio.exe'
    const entry = JSON.parse(setupFor(win, 'C:\\Users\\Zoë\\AppData\\Roaming\\Reel Studio\\mcp\\reelstudio-mcp.js', 'win32').claudeDesktop).mcpServers.reelstudio
    expect(entry).toEqual({ command: win, args: ['C:\\Users\\Zoë\\AppData\\Roaming\\Reel Studio\\mcp\\reelstudio-mcp.js'], env: { ELECTRON_RUN_AS_NODE: '1' } })
  })
})
