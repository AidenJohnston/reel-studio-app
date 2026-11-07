// Finds CLIProxyAPI on this computer, so connecting an editor is one click for anyone who runs it. Reads its config
// where it is usually kept (and wherever a running copy says with --config), takes the address and a client key from
// it, and asks the server for its models with that key. Nothing is saved here: the key stays in this process until
// the person clicks Use it, and then goes to the AI package's encrypted connection store. The page only ever learns
// the address, how many models answered and which file the key came from, never the key.
import { execFile } from 'node:child_process'
import { lookup as dnsLookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'
import { load } from 'js-yaml'
import type { HubFound } from '../shared/api'

export interface HubConfig {
  file: string
  /** as written in the config; a listen-on-everything host is 127.0.0.1 */
  host: string
  port: number
  tls: boolean
  /** the client keys listed in it (api-keys, or access.api-keys in CLIProxyAPI's newer layout) */
  keys: string[]
}

export interface HubDetection extends HubFound {
  /** the key that worked, and the config it came from; main keeps them until Use it, the page never gets them */
  key?: string
  file?: string
}

/** CLIProxyAPI's own default port (config.example.yaml); tried when no config is found. */
export const DEFAULT_HUB_PORT = 8317

/**
 * Where CLIProxyAPI's config usually is. It reads `--config <path>`, else config.yaml in its working folder
 * (cmd/server/main.go). Homebrew's service passes etc/cliproxyapi.conf; the auth folder ~/.cli-proxy-api is a common
 * home for it too. `REELSTUDIO_TEST_HUB_CONFIG` (tests) replaces the whole list with one folder.
 */
export function hubConfigCandidates(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, home = homedir()): string[] {
  const P = platform === 'win32' ? win32 : posix
  if (env.REELSTUDIO_TEST_HUB_CONFIG) return [P.join(env.REELSTUDIO_TEST_HUB_CONFIG, 'config.yaml'), P.join(env.REELSTUDIO_TEST_HUB_CONFIG, 'cliproxyapi.conf')]
  const inHome = (...p: string[]) => P.join(home, ...p)
  const common = [inHome('.cli-proxy-api', 'config.yaml'), inHome('CLIProxyAPI', 'config.yaml'), inHome('cliproxyapi', 'config.yaml')]
  if (platform === 'darwin') return ['/opt/homebrew/etc/cliproxyapi.conf', '/usr/local/etc/cliproxyapi.conf', ...common]
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA || inHome('AppData', 'Local')
    return [...common, P.join(local, 'CLIProxyAPI', 'config.yaml'), inHome('scoop', 'apps', 'cliproxyapi', 'current', 'config.yaml')]
  }
  return ['/home/linuxbrew/.linuxbrew/etc/cliproxyapi.conf', inHome('.linuxbrew', 'etc', 'cliproxyapi.conf'), '/etc/cliproxyapi/config.yaml', inHome('.config', 'cliproxyapi', 'config.yaml'), ...common]
}

/** The --config paths of CLIProxyAPI processes running now (macOS and Linux; `ps` lists every process's command line). */
export function configsOfRunning(psOutput: string): string[] {
  const out: string[] = []
  for (const line of psOutput.split('\n')) {
    const cmd = line.trim()
    const bin = cmd.split(/\s/, 1)[0]
    if (!bin || !/(^|\/)(cliproxyapi|cli-proxy-api)[\w.-]*$/i.test(bin)) continue
    // ps joins the arguments with spaces and never quotes them, so "Application Support" in a path reads like two
    // words. CLIProxyAPI takes no other operands, so the config path runs to the next flag or the end of the line.
    for (const m of cmd.slice(bin.length).matchAll(/\s--?config(?:=|\s+)(.+?)(?=\s+--?[A-Za-z]|$)/g)) out.push(m[1])
  }
  return out.filter((p) => posix.isAbsolute(p))
}

function runningConfigs(platform: NodeJS.Platform): Promise<string[]> {
  if (platform === 'win32') return Promise.resolve([])
  return new Promise((resolve) => {
    // -ww, as orphans.ts uses: without a terminal, BSD ps cuts each line to 79 columns, which can end a config path early
    execFile('/bin/ps', ['-ww', '-axo', 'command'], { timeout: 3000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => resolve(err ? [] : configsOfRunning(String(stdout))))
  })
}

const keyOf = (k: unknown): string | null => {
  if (typeof k === 'string') return k.trim() || null
  if (k && typeof k === 'object') {
    const v = (k as Record<string, unknown>).key ?? (k as Record<string, unknown>)['api-key'] ?? (k as Record<string, unknown>).value
    return typeof v === 'string' && v.trim() ? v.trim() : null
  }
  return null
}

/**
 * The address and client keys in one config file. The older layout has top-level host, port, tls and an api-keys
 * list; the v8 layout moves them under server: and access: (internal/config/config_v8.go), where a top-level api-keys
 * map holds upstream provider keys instead and is not used. A listen-on-everything host (empty, 0.0.0.0, ::) means
 * this computer; any other name is resolved later (localAddress) and must turn out to be this computer too.
 */
export function parseHubConfig(text: string, file: string): HubConfig | null {
  let doc: unknown
  try {
    doc = load(text)
  } catch {
    return null
  }
  if (!doc || typeof doc !== 'object') return null
  const d = doc as Record<string, any>
  const server = d.server && typeof d.server === 'object' ? d.server : {}
  const port = Number(server.port ?? d.port ?? DEFAULT_HUB_PORT)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null
  const tls = (server.tls ?? d.tls)?.enable === true
  let host = String(server.host ?? d.host ?? '').trim().replace(/^\[(.*)\]$/, '$1')
  if (!host || host === '0.0.0.0' || host === '::') host = '127.0.0.1'
  const list = Array.isArray(d['api-keys']) ? d['api-keys'] : Array.isArray(d.access?.['api-keys']) ? d.access['api-keys'] : []
  const keys = [...new Set(list.map(keyOf).filter((k: string | null): k is string => !!k))] as string[]
  return { file, host, port, tls, keys }
}

/**
 * How a path is said in the row: on a Mac or Linux the home folder as ~, as their own tools write it. Windows has no
 * such shorthand, so its paths stay whole. Only the folder itself counts, not one whose name merely begins the same
 * (/Users/sam is not the home of /Users/samuel).
 */
export function shownPath(file: string, home = homedir(), platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32' || !home) return file
  const base = home.endsWith('/') ? home.slice(0, -1) : home
  return file === base || file.startsWith(`${base}/`) ? `~${file.slice(base.length)}` : file
}

export type Lookup = (host: string) => Promise<{ address: string; family: number }[]>
const systemLookup: Lookup = (host) => dnsLookup(host, { all: true })

const isLoopback = (ip: string): boolean => (isIP(ip) === 4 ? /^127\./.test(ip) : isIP(ip) === 6 ? ip === '::1' || ip === '0:0:0:0:0:0:0:1' : false)

/**
 * The literal loopback address to reach `host` at, or null when it is not this computer. A name is resolved once and
 * every address it resolves to must be loopback (127.0.0.0/8 or ::1); the literal is then what every request uses,
 * so nothing is looked up again between this check and the key being sent.
 */
export async function localAddress(host: string, lookup: Lookup = systemLookup): Promise<string | null> {
  if (isIP(host)) return isLoopback(host) ? host : null
  let all: { address: string }[]
  try {
    all = await lookup(host)
  } catch {
    return null
  }
  if (!all.length || !all.every((a) => isLoopback(a.address))) return null
  return (all.find((a) => isIP(a.address) === 4) ?? all[0]).address
}

const originOf = (tls: boolean, ip: string, port: number): string => `${tls ? 'https' : 'http'}://${isIP(ip) === 6 ? `[${ip === '0:0:0:0:0:0:0:1' ? '::1' : ip}]` : ip}:${port}`

type Fetch = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal; redirect?: 'error' }) => Promise<{ status: number; json(): Promise<any> }>

/**
 * GET /v1/models: how many models a key gets, 'refused' for 401/403, null when nothing like CLIProxyAPI answers. The
 * models its catalog hides (image models, its review helper) are not counted, so the row's count is the picker's.
 * A redirect is refused, so the key never goes anywhere but the address checked.
 */
async function probe(f: Fetch, origin: string, key: string | null): Promise<number | 'refused' | null> {
  const headers: Record<string, string> = key ? { authorization: `Bearer ${key}` } : {}
  try {
    const res = await f(`${origin}/v1/models`, { headers, signal: AbortSignal.timeout(2500), redirect: 'error' })
    if (res.status === 401 || res.status === 403) return 'refused'
    if (res.status !== 200) return null
    const j = await res.json().catch(() => null)
    if (!Array.isArray(j?.data)) return null
    const hidden = await f(`${origin}/v1/models?client_version=0.163.0`, { headers, signal: AbortSignal.timeout(2500), redirect: 'error' })
      .then((r) => (r.status === 200 ? r.json() : null))
      .then((c) => new Set<string>((Array.isArray(c?.models) ? c.models : []).filter((m: any) => m?.visibility === 'hide').map((m: any) => String(m.slug))))
      .catch(() => new Set<string>())
    return j.data.filter((m: any) => !hidden.has(String(m?.id))).length
  } catch {
    return null
  }
}

export interface DetectDeps {
  env: NodeJS.ProcessEnv
  platform: NodeJS.Platform
  fetch: Fetch
  readFile?: (p: string) => Promise<string>
  running?: () => Promise<string[]>
  home?: string
  lookup?: Lookup
}

/** One config, checked: on this computer at `origin`, or elsewhere (never probed, never sent a key). */
async function checkConfig(d: DetectDeps, cfg: HubConfig): Promise<{ origin: string } | { elsewhere: string }> {
  const ip = await localAddress(cfg.host, d.lookup)
  return ip ? { origin: originOf(cfg.tls, ip, cfg.port) } : { elsewhere: cfg.host }
}

/**
 * CLIProxyAPI on this computer, best first: a running copy's config, then the usual places, then the default port with
 * no config. `ready`: a key from a config was accepted; `needs-key`: the server answers but no readable key works;
 * `elsewhere`: the config names another computer, which is never asked anything.
 */
export async function detectHub(d: DetectDeps): Promise<HubDetection> {
  const read = d.readFile ?? ((p: string) => readFile(p, 'utf8'))
  const test = !!d.env.REELSTUDIO_TEST_HUB_CONFIG
  const files = [...new Set([...(test ? [] : await (d.running ?? (() => runningConfigs(d.platform)))()), ...hubConfigCandidates(d.env, d.platform, d.home)])]
  let answered: { origin: string; file: string; refused: boolean } | null = null
  let elsewhere: { host: string; file: string } | null = null
  for (const file of files) {
    const text = await read(file).catch(() => null)
    if (text === null) continue
    const cfg = parseHubConfig(text, file)
    if (!cfg) continue
    const where = await checkConfig(d, cfg)
    if ('elsewhere' in where) {
      elsewhere ??= { host: where.elsewhere, file }
      continue
    }
    for (const key of cfg.keys) {
      const n = await probe(d.fetch, where.origin, key)
      if (typeof n === 'number') return { state: 'ready', origin: where.origin, models: n, keySource: shownPath(file, d.home, d.platform), key, file }
      if (n === 'refused') answered ??= { origin: where.origin, file, refused: true }
    }
    if (!answered && (await probe(d.fetch, where.origin, null)) !== null) answered = { origin: where.origin, file, refused: cfg.keys.length > 0 }
  }
  if (answered) return { state: 'needs-key', origin: answered.origin, keySource: shownPath(answered.file, d.home, d.platform), file: answered.file, ...(answered.refused ? { keyRefused: true } : {}) }
  if (!test) {
    const origin = `http://127.0.0.1:${DEFAULT_HUB_PORT}`
    if ((await probe(d.fetch, origin, null)) !== null) return { state: 'needs-key', origin }
  }
  if (elsewhere) return { state: 'elsewhere', host: elsewhere.host, keySource: shownPath(elsewhere.file, d.home, d.platform) }
  return { state: 'none', ...(test ? {} : { looked: `127.0.0.1:${DEFAULT_HUB_PORT}` }) }
}

/**
 * Right before Use it stores and uses a key: the config read again and checked again. The address must still be this
 * computer and the same one the row showed; the key from the config must still be in it and still accepted. A typed
 * key goes only to an address checked here. Throws plain words when anything changed.
 */
export async function confirmHub(d: DetectDeps, found: HubDetection, typed?: string): Promise<{ origin: string; key: string; keySource: string }> {
  const gone = { code: 'HUB_CHANGED', userMessage: 'CLIProxyAPI’s config changed since Reel Studio looked. Look again.' }
  if (!found.origin || (found.state !== 'ready' && found.state !== 'needs-key')) throw gone
  let origin: string
  let keys: string[] = []
  if (found.file) {
    const cfg = parseHubConfig(await (d.readFile ?? ((p: string) => readFile(p, 'utf8')))(found.file).catch(() => ''), found.file)
    if (!cfg) throw gone
    const where = await checkConfig(d, cfg)
    if ('elsewhere' in where) throw { code: 'HUB_NOT_LOCAL', userMessage: `CLIProxyAPI’s config now names ${where.elsewhere}, not this computer, so its key was not sent.` }
    origin = where.origin
    keys = cfg.keys
  } else {
    origin = `http://127.0.0.1:${DEFAULT_HUB_PORT}` // the default port, found with no config
  }
  if (origin !== found.origin) throw gone
  if (typed) return { origin, key: typed, keySource: 'typed' }
  if (!found.key || !keys.includes(found.key) || typeof (await probe(d.fetch, origin, found.key)) !== 'number') throw gone
  return { origin, key: found.key, keySource: found.keySource ?? 'typed' }
}
