// Settings › Editor › "Let other AI apps use Reel Studio" (off by default). While it is on, this process listens on a
// local-only endpoint: a Unix socket in a 0700 folder under the settings folder (0600 itself), or on Windows a named
// pipe with a random name. Nothing listens while it is off. It writes an access file (0600) with the endpoint and a
// random token; the relay an outside AI app starts (ai/relay/reelstudio-mcp.js, copied beside that file) reads it,
// connects and proves itself with the token, compared in constant time as ai/src/mcp/run.ts does.
//
// What a connection may do is the person's own controls (OutsideControls): read reels, send a note through the note
// queue, press Stop. No file paths or project files go out beyond what those answers carry. Turning it off, Reset
// access (a new token) and quitting close every connection.
//
// Messages are newline-delimited JSON:
//   relay -> app  {"hello":{"token":"...","client":"claude-code"}}   then {"id":7,"call":{"name":"send_note","args":{...}}}
//   app -> relay  {"ok":true} or {"error":"..."}                    then {"id":7,"result":{"content":"...","isError":false}}
//   app -> relay  {"bye":"reset"|"off"|"quit"} just before it closes a connection on purpose
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { promises as fs } from 'node:fs'
import * as net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** The tools a connection may call: the relay's TOOLS by name (ai/relay/reelstudio-mcp.js; a test keeps them equal). */
export const TOOL_NAMES = ['list_reels', 'get_reel', 'send_note', 'stop_note'] as const
export type ToolName = (typeof TOOL_NAMES)[number]

/** The person's own controls, as the Reel screen has them (main/index.ts). Each answer is the text the agent reads. */
export interface OutsideControls {
  listReels(): Promise<string>
  getReel(reel: string): Promise<string>
  sendNote(reel: string, text: string, base?: number): Promise<string>
  stopNote(reel: string): Promise<string>
}

export interface OutsideSetup {
  /** a command to paste in a terminal: `claude mcp add ...` */
  claudeCode: string
  /** the `mcpServers` entry for claude_desktop_config.json */
  claudeDesktop: string
  /** a command to paste in a terminal: `codex mcp add ...` */
  codex: string
  /** the same server as a ~/.codex/config.toml table (the ChatGPT desktop app reads that file too) */
  codexToml: string
}

export interface OutsideStatus {
  on: boolean
  /** the outside apps connected now, by the name each gave */
  connected: string[]
  setup: OutsideSetup | null
}

/** a line longer than this is not a call: a note is at most NOTE_MAX characters */
export const MAX_LINE = 64 * 1024
export const NOTE_MAX = 4000
const HELLO_TIMEOUT_MS = 5000
const MAX_CONNECTIONS = 8
/** calls one connection may have waiting at once */
const MAX_PENDING = 16
/** answers a connection has not read yet; past this it is cut off rather than grow the app's memory */
const MAX_UNREAD = 4 * 1024 * 1024
const SLUG = /^[\p{L}\p{N}][\p{L}\p{N}._-]*$/u
/** macOS refuses a socket path longer than 103 bytes (sun_path is 104 with its NUL) */
const SOCKET_PATH_MAX = 103

const SERVER = 'reelstudio'

/** Quoted for the shell the person pastes into: POSIX sh, or PowerShell on Windows (Settings says so). Both take
 * single quotes literally, so a path with `$` or a space stays one argument as it is; PowerShell doubles a `'`. */
function quote(arg: string, platform: NodeJS.Platform): string {
  if (platform === 'win32') return `'${arg.replace(/'/g, "''")}'`
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`
}

/**
 * The setup lines Settings shows for each client, for the app's binary (`command`) running the relay (`script`) as
 * Node. Syntax checked against each client's docs on 2026-11-06: Claude Code `claude mcp add [options] <name> --
 * <command> [args...]` (code.claude.com/docs/en/mcp), Claude Desktop `mcpServers` with command/args/env
 * (modelcontextprotocol.io), Codex `codex mcp add <name> --env KEY=VALUE -- <command>...` and `[mcp_servers.<name>]`
 * (developers.openai.com/codex/mcp).
 */
export function setupFor(command: string, script: string, platform: NodeJS.Platform): OutsideSetup {
  const q = (a: string) => quote(a, platform)
  // On Windows `--` is written '--': PowerShell would take a bare `--` for itself when claude or codex is a .ps1 shim
  const dashes = platform === 'win32' ? "'--'" : '--'
  // --transport stdio sits between --env and the name: Claude Code reads a name straight after --env as another pair
  const claudeCode = `claude mcp add --scope user --env ELECTRON_RUN_AS_NODE=1 --transport stdio ${SERVER} ${dashes} ${q(command)} ${q(script)}`
  const claudeDesktop = JSON.stringify({ mcpServers: { [SERVER]: { command, args: [script], env: { ELECTRON_RUN_AS_NODE: '1' } } } }, null, 2)
  const codex = `codex mcp add ${SERVER} --env ELECTRON_RUN_AS_NODE=1 ${dashes} ${q(command)} ${q(script)}`
  // TOML literal strings ('...') keep Windows backslashes as they are; a path with a ' cannot be one, so it is escaped
  const lit = (s: string) => (s.includes("'") ? JSON.stringify(s) : `'${s}'`)
  const codexToml = `[mcp_servers.${SERVER}]\ncommand = ${lit(command)}\nargs = [${lit(script)}]\nenv = { ELECTRON_RUN_AS_NODE = "1" }`
  return { claudeCode, claudeDesktop, codex, codexToml }
}

type Args = Record<string, unknown>
const refuse = (userMessage: string): never => {
  throw { code: 'OUTSIDE_BAD_ARGS', userMessage }
}

/** The arguments a tool takes, checked strictly: an unknown key or a wrong type is refused, never guessed at. */
export function checkArgs(name: ToolName, raw: unknown): Args {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) refuse('The arguments must be an object.')
  const args = raw as Args
  const allowed: Record<ToolName, string[]> = { list_reels: [], get_reel: ['reel'], send_note: ['reel', 'text', 'base_version'], stop_note: ['reel'] }
  const extra = Object.keys(args).filter((k) => !allowed[name].includes(k))
  if (extra.length) refuse(`${name} does not take ${extra.join(', ')}. It takes: ${allowed[name].join(', ') || 'nothing'}.`)
  if (allowed[name].includes('reel')) {
    const reel = args.reel
    if (typeof reel !== 'string' || reel.length > 200 || !SLUG.test(reel)) refuse('Give a reel id from list_reels.')
  }
  if (name === 'send_note') {
    if (typeof args.text !== 'string' || !args.text.trim()) refuse('Say what to change in text.')
    if ((args.text as string).length > NOTE_MAX) refuse(`A note can be at most ${NOTE_MAX} characters.`)
    const b = args.base_version
    if (b !== undefined && !(typeof b === 'number' && Number.isInteger(b) && b >= 1)) refuse('base_version must be a version number, 1 or more.')
  }
  return args
}

/** Runs one checked call on the controls. */
export async function dispatch(controls: OutsideControls, name: string, raw: unknown, still: () => boolean = () => true): Promise<{ content: string; isError: boolean }> {
  if (!(TOOL_NAMES as readonly string[]).includes(name)) return { content: `Reel Studio has no tool "${name}". It has: ${TOOL_NAMES.join(', ')}.`, isError: true }
  try {
    const tool = name as ToolName
    const a = checkArgs(tool, raw)
    // the connection may have been ended (off, Reset access, quit, or it closed) while this call waited its turn
    if (!still()) return { content: 'Reel Studio ended this connection.', isError: true }
    const content =
      tool === 'list_reels' ? await controls.listReels()
      : tool === 'get_reel' ? await controls.getReel(a.reel as string)
      : tool === 'send_note' ? await controls.sendNote(a.reel as string, (a.text as string).trim(), a.base_version as number | undefined)
      : await controls.stopNote(a.reel as string)
    return { content, isError: false }
  } catch (e) {
    const msg = e && typeof e === 'object' && 'userMessage' in e && typeof e.userMessage === 'string' ? e.userMessage : 'That did not work in Reel Studio. Try again.'
    return { content: msg, isError: true }
  }
}

export function tokenMatches(given: unknown, token: string): boolean {
  if (typeof given !== 'string') return false
  const a = Buffer.from(given)
  const b = Buffer.from(token)
  return a.length === b.length && timingSafeEqual(a, b)
}

export interface OutsideAccessOptions {
  /** the folder for the access file, the relay copy and (on macOS and Linux) the socket */
  dir: string
  platform: NodeJS.Platform
  /** the binary an outside app runs the relay with (the app's own, as Node) */
  command: string
  /** the relay's source, copied to `dir` each time access turns on, so an update brings the new one */
  relaySource: () => Promise<string>
  controls: OutsideControls
  /** the connected apps or the on/off state changed (Settings listens) */
  onChange?: (s: OutsideStatus) => void
  log?: (s: string) => void
}

interface Client {
  sock: net.Socket
  name: string
  authed: boolean
  /** Reel Studio ended it (off, Reset access, quit): calls still queued on it do not run */
  dropped: boolean
  chain: Promise<void>
  pending: number
}

export function createOutsideAccess(o: OutsideAccessOptions) {
  const log = o.log ?? (() => undefined)
  const accessFile = join(o.dir, 'access.json')
  const script = join(o.dir, 'reelstudio-mcp.js')
  let server: net.Server | null = null
  let token = ''
  let endpoint = ''
  /** a folder made for the socket when the settings folder's path is too long for one */
  let tempDir: string | null = null
  const clients = new Set<Client>()
  /** one on/off/reset at a time */
  let gate: Promise<unknown> = Promise.resolve()
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const p = gate.then(fn, fn)
    gate = p.catch(() => undefined)
    return p
  }

  function status(): OutsideStatus {
    const on = server !== null
    const connected = [...new Set([...clients].filter((c) => c.authed).map((c) => c.name || 'An AI app'))]
    return { on, connected, setup: on ? setupFor(o.command, script, o.platform) : null }
  }
  const changed = () => o.onChange?.(status())

  function onConnection(sock: net.Socket): void {
    const c: Client = { sock, name: '', authed: false, dropped: false, chain: Promise.resolve(), pending: 0 }
    const send = (m: unknown) => {
      if (c.dropped || !sock.writable) return
      sock.write(JSON.stringify(m) + '\n')
      if (sock.writableLength > MAX_UNREAD) sock.destroy()
    }
    let timer: NodeJS.Timeout | undefined
    sock.on('close', () => {
      // calls it sent that have not run yet never run
      c.dropped = true
      if (timer) clearTimeout(timer)
      const was = c.authed
      clients.delete(c)
      if (was) changed()
    })
    sock.on('error', () => undefined)
    if (clients.size >= MAX_CONNECTIONS) {
      send({ error: 'Too many AI apps are connected to Reel Studio.' })
      sock.end()
      return
    }
    clients.add(c)
    timer = setTimeout(() => sock.destroy(), HELLO_TIMEOUT_MS)
    let buf = ''
    sock.setEncoding('utf8')
    sock.on('data', (d: string) => {
      buf += d
      if (buf.length > MAX_LINE) return void sock.destroy()
      let i: number
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 1)
        let m: any
        try {
          m = JSON.parse(line)
        } catch {
          return void sock.destroy()
        }
        if (!c.authed) {
          if (timer) clearTimeout(timer)
          // the token is read at the time of the hello: a Reset access that ran meanwhile refuses it
          if (!server || !tokenMatches(m?.hello?.token, token)) {
            send({ error: 'Reel Studio refused this connection.' })
            sock.end()
            return
          }
          c.authed = true
          c.name = typeof m.hello.client === 'string' ? m.hello.client.replace(/[^\p{L}\p{N} ._-]/gu, '').slice(0, 40) : ''
          send({ ok: true })
          changed()
          continue
        }
        if (typeof m?.id !== 'number' || typeof m?.call?.name !== 'string') continue
        const id = m.id
        if (c.pending >= MAX_PENDING) {
          send({ id, error: 'Too many calls at once. Wait for one to finish.' })
          continue
        }
        c.pending++
        // one call at a time per connection, in the order sent
        c.chain = c.chain.then(async () => {
          if (c.dropped) return
          const r = await dispatch(o.controls, m.call.name, m.call.args ?? {}, () => !c.dropped && server !== null)
          c.pending--
          send({ id, result: r })
        })
      }
    })
  }

  /** Ends every connection, telling each relay why (it reconnects only after a quit). */
  function dropAll(why: 'reset' | 'off' | 'quit'): void {
    for (const c of clients) {
      if (c.authed && c.sock.writable) c.sock.end(JSON.stringify({ bye: why }) + '\n')
      c.dropped = true
      // the bye gets out first; a relay that does not close its end is cut off shortly after
      setTimeout(() => c.sock.destroy(), 300).unref()
    }
    clients.clear()
  }

  async function writeAccess(): Promise<void> {
    // written whole, then renamed into place: a relay never reads half a file
    const tmp = `${accessFile}.${randomBytes(4).toString('hex')}.tmp`
    await fs.writeFile(tmp, JSON.stringify({ v: 1, endpoint, token }), { mode: 0o600 })
    await fs.chmod(tmp, 0o600)
    await fs.rename(tmp, accessFile)
  }

  async function pickEndpoint(): Promise<string> {
    if (o.platform === 'win32') return `\\\\.\\pipe\\reelstudio-mcp-${randomBytes(12).toString('hex')}`
    const inDir = join(o.dir, 'rs.sock')
    if (Buffer.byteLength(inDir) <= SOCKET_PATH_MAX) return inDir
    tempDir = await fs.mkdtemp(join(tmpdir(), 'rs-mcp-'))
    return join(tempDir, 'rs.sock')
  }

  async function stop(why: 'off' | 'quit'): Promise<void> {
    const s = server
    server = null
    dropAll(why)
    if (s) await new Promise<void>((resolve) => s.close(() => resolve()))
    await fs.rm(accessFile, { force: true }).catch(() => undefined)
    if (o.platform !== 'win32' && endpoint) await fs.rm(endpoint, { force: true }).catch(() => undefined)
    if (tempDir) await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
    tempDir = null
    endpoint = ''
    token = ''
  }

  return {
    status,
    /** the folder's relay copy, for the setup lines */
    script,

    /** Starts listening and writes the access file. Already on: nothing changes. */
    enable(): Promise<OutsideStatus> {
      return serial(async () => {
        if (server) return status()
        await fs.mkdir(o.dir, { recursive: true, mode: 0o700 })
        if (o.platform !== 'win32') await fs.chmod(o.dir, 0o700)
        await fs.writeFile(script, await o.relaySource(), { mode: 0o600 })
        endpoint = await pickEndpoint()
        // a socket left by a crash is ours, in our own 0700 folder
        if (o.platform !== 'win32') await fs.rm(endpoint, { force: true })
        token = randomBytes(32).toString('base64url')
        const s = net.createServer((sock) => onConnection(sock))
        try {
          await new Promise<void>((resolve, reject) => {
            s.once('error', reject)
            s.listen(endpoint, () => {
              s.off('error', reject)
              resolve()
            })
          })
          if (o.platform !== 'win32') await fs.chmod(endpoint, 0o600)
          server = s
          await writeAccess()
        } catch (e) {
          server = null
          s.close()
          await stop('off')
          log(`[outside] could not listen: ${String(e)}`)
          throw { code: 'OUTSIDE_LISTEN', userMessage: 'Reel Studio could not open its connection for other AI apps. Restart Reel Studio and try again.' }
        }
        log('[outside] on')
        changed()
        return status()
      })
    },

    /** Closes the endpoint and every connection, and deletes the access file. */
    disable(): Promise<OutsideStatus> {
      return serial(async () => {
        if (!server) return status()
        await stop('off')
        log('[outside] off')
        changed()
        return status()
      })
    },

    /** Reset access: a new token, and every connected app is disconnected. */
    reset(): Promise<OutsideStatus> {
      return serial(async () => {
        if (!server) return status()
        token = randomBytes(32).toString('base64url')
        dropAll('reset')
        await writeAccess()
        log('[outside] access reset')
        changed()
        return status()
      })
    },

    /** The app is quitting. */
    close(): Promise<void> {
      return serial(() => stop('quit'))
    }
  }
}

export type OutsideAccess = ReturnType<typeof createOutsideAccess>
