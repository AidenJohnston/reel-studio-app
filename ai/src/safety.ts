// Trust boundaries for what the model chooses. The model reads text it
// does not control (the transcript, image-search titles), so every path, file name and URL it hands
// a tool is untrusted. Mirrors engine/reelengine/safepath.py and assets.check_url.
import * as dns from 'node:dns/promises';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

// ---------------------------------------------------------------- paths

export class UnsafePathError extends Error {
  constructor(message: string) { super(message); this.name = 'UnsafePathError'; }
}

const DRIVE = /^[A-Za-z]:/;

/** Why a project path string is refused before it is resolved (null = acceptable shape). */
export function pathProblem(ref: unknown): string | null {
  if (typeof ref !== 'string' || !ref.trim()) return 'empty path';
  if (ref.includes('\0')) return 'NUL byte in path';
  const s = ref.replace(/\\/g, '/');
  if (s.startsWith('//')) return 'UNC or device path';
  if (s.startsWith('/') || DRIVE.test(s)) return 'absolute path';
  if (s.split('/').some((p) => p === '..')) return "'..' in path";
  return null;
}

/** realpath of `p`, or of its nearest existing ancestor + the rest (for files not written yet). */
function realish(p: string): string {
  let cur = path.resolve(p);
  const rest: string[] = [];
  for (;;) {
    try { return path.join(fs.realpathSync.native(cur), ...rest.reverse()); } catch { /* not there yet */ }
    const parent = path.dirname(cur);
    if (parent === cur) return path.join(cur, ...rest.reverse());
    rest.push(path.basename(cur));
    cur = parent;
  }
}

function inside(child: string, base: string): boolean {
  const norm = (x: string) => (process.platform === 'win32' ? x.toLowerCase() : x);
  const rel = path.relative(norm(realish(base)), norm(child));
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

export type PathMode = 'read' | 'write';

/** project.json path -> { ref (portable, relative), abs (real) } inside the allowed folders:
 * read: <project>/media, <project>/work, <root>/Library; write: <project>/work, <project>/versions.
 * An absolute input is accepted only when it already lies inside one of them, and comes back as
 * the relative ref. Symlinks and `..` are resolved BEFORE the check. Throws UnsafePathError. */
export function safeResolve(projectDir: string, root: string, ref: string, mode: PathMode = 'read'): { ref: string; abs: string } {
  if (typeof ref !== 'string' || !ref.trim() || ref.includes('\0')) throw new UnsafePathError('empty or invalid path');
  const s = ref.replace(/\\/g, '/');
  if (s.startsWith('//')) throw new UnsafePathError(`network or device paths are not allowed: ${ref}`);
  const bases: [string, string][] = mode === 'read'
    ? [[path.join(projectDir, 'media'), 'media'], [path.join(projectDir, 'work'), 'work'], [path.join(root, 'Library'), 'Library']]
    : [[path.join(projectDir, 'work'), 'work'], [path.join(projectDir, 'versions'), 'versions']];
  const cand = s.startsWith('/') || DRIVE.test(s) ? ref
    : s.startsWith('Library/') ? path.join(root, s) : path.join(projectDir, s);
  const real = realish(cand);
  for (const [base, prefix] of bases) {
    if (inside(real, base)) {
      const rel = path.relative(realish(base), real).split(path.sep).join('/');
      return { ref: rel ? `${prefix}/${rel}` : prefix, abs: real };
    }
  }
  throw new UnsafePathError(`"${ref}" is outside this project's media/work folders and the Library`);
}

/** A model-chosen file name hint -> `[a-z0-9-]`, at most `max` chars (never a path). */
export function slugName(s: unknown, max = 40, fallback = 'image'): string {
  return String(s ?? '').normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max).replace(/-+$/, '') || fallback;
}

// ---------------------------------------------------------------- network

export type LookupFn = (host: string) => Promise<string[]>;
export const defaultLookup: LookupFn = async (host) => (await dns.lookup(host, { all: true, verbatim: true })).map((a) => a.address);

const BLOCKED = new net.BlockList();
for (const [a, n] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]] as [string, number][]) BLOCKED.addSubnet(a, n, 'ipv4');
for (const [a, n] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8], ['2001:db8::', 32], ['100::', 64]] as [string, number][]) BLOCKED.addSubnet(a, n, 'ipv6');

/** True for loopback, private (RFC 1918 / ULA), link-local, CGNAT, multicast, reserved, unspecified. */
export function isBlockedAddress(ip: string): boolean {
  const bare = ip.replace(/^\[|\]$/g, '').split('%')[0];
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(bare) ?? /^64:ff9b::(\d+\.\d+\.\d+\.\d+)$/i.exec(bare);
  if (mapped) return BLOCKED.check(mapped[1], 'ipv4');
  const fam = net.isIP(bare);
  if (fam === 4) return BLOCKED.check(bare, 'ipv4');
  if (fam === 6) {
    const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(bare);   // ::ffff:7f00:1 form
    if (hex) {
      const a = parseInt(hex[1], 16); const b = parseInt(hex[2], 16);
      return BLOCKED.check(`${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`, 'ipv4');
    }
    return BLOCKED.check(bare, 'ipv6');
  }
  return true;                                    // not an address at all: refuse
}

export class BlockedUrlError extends Error {
  constructor(message: string, readonly code: 'BAD_URL' | 'BLOCKED_HOST' | 'TOO_BIG' | 'TIMEOUT' | 'TOO_MANY_REDIRECTS' | 'NETWORK') {
    super(message); this.name = 'BlockedUrlError';
  }
}

/** Refuses anything but http(s) to a public address. Every resolved address must be public. */
export async function assertPublicUrl(raw: string, lookup: LookupFn = defaultLookup): Promise<URL> {
  let u: URL;
  try { u = new URL(raw); } catch { throw new BlockedUrlError('url must be a full http:// or https:// link', 'BAD_URL'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new BlockedUrlError('url must start with http:// or https://', 'BAD_URL');
  if (u.username || u.password) throw new BlockedUrlError('links with a user name or password are not allowed', 'BAD_URL');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!host) throw new BlockedUrlError('url has no host', 'BAD_URL');
  let addrs: string[];
  if (net.isIP(host)) addrs = [host];
  else {
    try { addrs = await lookup(host); } catch (e: any) { throw new BlockedUrlError(`could not look up ${host} (${e?.code ?? e?.message ?? 'dns error'})`, 'NETWORK'); }
  }
  if (!addrs.length || addrs.some(isBlockedAddress)) {
    throw new BlockedUrlError('that link points at this computer or a private network, so it was not downloaded', 'BLOCKED_HOST');
  }
  return u;
}

export interface GuardedFetchOptions {
  fetchImpl?: typeof fetch;
  lookup?: LookupFn;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxBytes: number;
  maxRedirects?: number;
  headers?: Record<string, string>;
}

/** GET with every redirect hop re-checked (`redirect: 'manual'`), a whole-request timeout and a
 * byte counter while streaming (never buffers more than `maxBytes` + one chunk). */
export async function guardedFetch(url: string, o: GuardedFetchOptions): Promise<{ res: Response; body: Buffer; url: string }> {
  const f = o.fetchImpl ?? fetch;
  const timeout = AbortSignal.timeout(o.timeoutMs ?? 30_000);
  const signal = o.signal ? AbortSignal.any([o.signal, timeout]) : timeout;
  let cur = url;
  for (let hop = 0; ; hop++) {
    await assertPublicUrl(cur, o.lookup);
    let res: Response;
    try {
      res = await f(cur, { headers: o.headers, signal, redirect: 'manual' });
    } catch (e: any) {
      if (timeout.aborted) throw new BlockedUrlError('the download took too long', 'TIMEOUT');
      throw e;
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      if (hop >= (o.maxRedirects ?? 5)) throw new BlockedUrlError('too many redirects', 'TOO_MANY_REDIRECTS');
      cur = new URL(res.headers.get('location')!, cur).toString();
      await res.body?.cancel().catch(() => undefined);
      continue;
    }
    const declared = Number(res.headers.get('content-length') ?? 0);
    if (declared > o.maxBytes) {
      await res.body?.cancel().catch(() => undefined);
      throw new BlockedUrlError(`over ${Math.round(o.maxBytes / 1e6)} MB`, 'TOO_BIG');
    }
    const chunks: Buffer[] = []; let got = 0;
    const reader = res.body?.getReader();
    try {
      while (reader) {
        const { done, value } = await reader.read();
        if (done) break;
        got += value.byteLength;
        if (got > o.maxBytes) { await reader.cancel().catch(() => undefined); throw new BlockedUrlError(`over ${Math.round(o.maxBytes / 1e6)} MB`, 'TOO_BIG'); }
        chunks.push(Buffer.from(value));
      }
    } catch (e) {
      if (e instanceof BlockedUrlError) throw e;
      if (timeout.aborted) throw new BlockedUrlError('the download took too long', 'TIMEOUT');
      throw e;
    }
    return { res, body: Buffer.concat(chunks), url: cur };
  }
}

/** The real image type from the bytes (never the server's word for it), or null. */
export function sniffImage(b: Buffer): '.png' | '.jpg' | '.gif' | '.webp' | null {
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return '.png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return '.jpg';
  if (b.length >= 6 && /^GIF8[79]a$/.test(b.subarray(0, 6).toString('latin1'))) return '.gif';
  if (b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return '.webp';
  return null;
}

/** Environment for a child process (python engine, `claude`, `codex`): no ANTHROPIC_* (an API key
 * or a base-URL redirect must not leak into or steer a child; review finding 33). */
export function childEnv(base: NodeJS.ProcessEnv = process.env, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) if (!/^ANTHROPIC_/i.test(k)) out[k] = v;
  return { ...out, ...extra };
}

/** The dev CLI's settings folder: OUTSIDE Documents, which is often synced to OneDrive or iCloud
 *. */
export function devSettingsDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return path.join(env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'Reel Studio', 'ai-dev');
  if (platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Reel Studio', 'ai-dev');
  return path.join(env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'reel-studio', 'ai-dev');
}
