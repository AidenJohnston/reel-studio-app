// Finds the person's own Codex app (OpenAI's `codex` CLI) and asks IT whether it is signed in.
// Same rules as localClaude.ts: Reel Studio never reads, stores or proxies a ChatGPT credential. It never opens
// ~/.codex files; it only runs `codex --version` and `codex login status` and keeps the yes/no answer.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runProcess } from './cli';
import type { ClaudeCodeState, Runner } from './localClaude';
import { cliEnv } from '../safety';

/** Same four states as the Claude Code app. */
export type CodexState = ClaudeCodeState;

export interface LocalCodex {
  state: CodexState;
  installed: boolean;
  signedIn: boolean;
  /** absolute path to the binary (a GUI app on macOS does not inherit the shell's PATH) */
  bin?: string;
  version?: string;
  /** how it is signed in: "chatgpt" or "api_key". Never the key, never the account. */
  authMethod?: 'chatgpt' | 'api_key';
  reason?: string;
}

export interface CodexDetectOptions {
  run?: Runner;
  /** skip the search: a known binary, or null = "not found" (tests) */
  bin?: string | null;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  exists?: (p: string) => boolean;
  listDir?: (dir: string) => string[];
}

const RUN_TIMEOUT_MS = 15_000;
const LOGIN_SHELL_TIMEOUT_MS = 5_000;

const defaultExists = (p: string): boolean => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const defaultListDir = (d: string): string[] => { try { return fs.readdirSync(d); } catch { return []; } };

function homeOf(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  return (platform === 'win32' ? env.USERPROFILE || env.HOME : env.HOME || env.USERPROFILE) || os.homedir();
}

function byVersionDesc(a: string, b: string): number {
  const n = (s: string) => s.replace(/^v/i, '').split(/[.\-_]/).map((x) => parseInt(x, 10) || 0);
  const x = n(a); const y = n(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((y[i] ?? 0) !== (x[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0);
  return 0;
}

/**
 * Where `codex` usually lives, in order: PATH, OpenAI's own installer (Windows `%LOCALAPPDATA%\Programs\OpenAI\Codex\bin`;
 * macOS `~/.local/bin`, both backed by `~/.codex/packages/standalone/current/bin`), then package managers. On Windows
 * only a real `codex.exe` is listed: the npm `.cmd` shim is never spawned (the native exe npm ships is found instead).
 */
export function codexCandidates(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform,
  listDir: (dir: string) => string[] = defaultListDir): string[] {
  const win = platform === 'win32';
  const P = win ? path.win32 : path.posix;
  const home = homeOf(env, platform);
  const exe = win ? 'codex.exe' : 'codex';
  const out: string[] = [];
  const add = (p: string) => { if (P.isAbsolute(p) && !out.includes(p)) out.push(p); };
  const inDir = (d: string) => add(P.join(d, exe));
  const codexHome = env.CODEX_HOME && P.isAbsolute(env.CODEX_HOME) ? env.CODEX_HOME : P.join(home, '.codex');

  for (const d of (env.PATH || env.Path || '').split(P.delimiter).filter(Boolean)) inDir(d);
  if (win) {
    const local = env.LOCALAPPDATA || P.join(home, 'AppData', 'Local');
    const roaming = env.APPDATA || P.join(home, 'AppData', 'Roaming');
    inDir(P.join(local, 'Programs', 'OpenAI', 'Codex', 'bin'));
    inDir(P.join(codexHome, 'packages', 'standalone', 'current', 'bin'));
    inDir(P.join(home, '.local', 'bin'));
    // npm -g ships the native exe in a platform package: @openai/codex/node_modules/@openai/codex-win32-x64/vendor/<triple>/bin
    const scope = P.join(roaming, 'npm', 'node_modules', '@openai', 'codex', 'node_modules', '@openai');
    for (const pkg of listDir(scope).filter((n) => /^codex-win32-/i.test(n)).sort()) {
      const vendor = P.join(scope, pkg, 'vendor');
      for (const triple of listDir(vendor).sort()) inDir(P.join(vendor, triple, 'bin'));
    }
  } else {
    inDir(P.join(home, '.local', 'bin'));
    inDir(P.join(codexHome, 'packages', 'standalone', 'current', 'bin'));
    if (platform === 'darwin') {
      inDir('/opt/homebrew/bin');
      inDir('/usr/local/bin');
      inDir(P.join(home, '.npm-global', 'bin'));
      const nvm = P.join(home, '.nvm', 'versions', 'node');
      for (const v of listDir(nvm).sort(byVersionDesc)) inDir(P.join(nvm, v, 'bin'));
      inDir(P.join(home, '.volta', 'bin'));
      inDir(P.join(home, '.bun', 'bin'));
    } else {
      inDir('/usr/local/bin');
      inDir('/usr/bin');
    }
  }
  return out;
}

export function findCodex(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform,
  exists: (p: string) => boolean = defaultExists, listDir: (dir: string) => string[] = defaultListDir): string | null {
  return codexCandidates(env, platform, listDir).find(exists) ?? null;
}

/** macOS: an app opened from Finder gets a minimal PATH, so ask the login shell. Only an absolute existing path counts. */
export async function codexFromLoginShell(run: Runner, env: NodeJS.ProcessEnv = process.env,
  exists: (p: string) => boolean = defaultExists): Promise<string | null> {
  const shell = env.SHELL && path.posix.isAbsolute(env.SHELL) && !/\s/.test(env.SHELL) ? env.SHELL : '/bin/zsh';
  try {
    const r = await run(shell, ['-ilc', 'command -v codex'], { timeoutMs: LOGIN_SHELL_TIMEOUT_MS });
    if (r.code !== 0) return null;
    const lines = r.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).reverse();
    return lines.find((l) => path.posix.isAbsolute(l) && /\/codex$/.test(l) && exists(l)) ?? null;
  } catch {
    return null;
  }
}

export const CODEX_MESSAGES = {
  missing: 'We could not find the Codex app on this computer.',
  broken: 'We found the Codex app, but it did not start. Try installing it again.',
  signed_out: 'Your Codex app is not signed in yet.',
  unknown: 'We could not tell if your Codex app is signed in. Click Check again.',
  slow: 'Your Codex app took too long to answer. Click Check again.',
} as const;

/** Installed = `codex --version` exits 0. Signed in = `codex login status` exits 0 and says "Logged in". */
export async function detectCodex(o: CodexDetectOptions = {}): Promise<LocalCodex> {
  const env = o.env ?? process.env;
  const run: Runner = o.run ?? (async (cmd, args, ro) => {
    const r = await runProcess(cmd, args, '', { timeoutMs: ro?.timeoutMs ?? RUN_TIMEOUT_MS, env: cliEnv(env) });
    return { code: r.code, stdout: r.stdout, stderr: r.stderr };
  });
  const platform = o.platform ?? process.platform;
  const exists = o.exists ?? defaultExists;
  let bin: string | null = o.bin === undefined ? findCodex(env, platform, exists, o.listDir ?? defaultListDir) : o.bin;
  if (!bin && o.bin === undefined && platform === 'darwin') bin = await codexFromLoginShell(run, env, exists);
  if (!bin) return { state: 'missing', installed: false, signedIn: false, reason: CODEX_MESSAGES.missing };

  let version: string | undefined;
  try {
    const v = await run(bin, ['--version'], { timeoutMs: RUN_TIMEOUT_MS });
    if (v.code !== 0) return { state: 'broken', installed: false, signedIn: false, bin, reason: CODEX_MESSAGES.broken };
    version = (v.stdout.match(/\d+\.\d+(?:\.\d+)?/) ?? [])[0];
  } catch {
    return { state: 'broken', installed: false, signedIn: false, bin, reason: CODEX_MESSAGES.broken };
  }

  const base = { installed: true, bin, ...(version ? { version } : {}) };
  let a: { code: number | null; stdout: string; stderr: string };
  try {
    a = await run(bin, ['login', 'status'], { timeoutMs: RUN_TIMEOUT_MS });
  } catch (e: any) {
    const slow = e?.code === 'cli_timeout';
    return { ...base, state: 'signed_out', signedIn: false, reason: slow ? CODEX_MESSAGES.slow : CODEX_MESSAGES.unknown };
  }
  // Keep ONLY the yes/no and the kind of sign-in. An API-key answer can carry part of the key: it is dropped here.
  const text = `${a.stdout}\n${a.stderr}`;
  if (a.code === 0 && /logged in/i.test(text) && !/not logged in/i.test(text)) {
    const authMethod = /api key/i.test(text) ? 'api_key' as const : /chatgpt/i.test(text) ? 'chatgpt' as const : undefined;
    return { ...base, state: 'ready', signedIn: true, ...(authMethod ? { authMethod } : {}) };
  }
  if (/not logged in|logged out/i.test(text) || a.code === 1) return { ...base, state: 'signed_out', signedIn: false, reason: CODEX_MESSAGES.signed_out };
  return { ...base, state: 'signed_out', signedIn: false, reason: CODEX_MESSAGES.unknown };
}
