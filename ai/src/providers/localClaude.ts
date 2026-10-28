// Finds the person's own Claude Code app (Anthropic's `claude` CLI) and asks IT whether it is signed in.
// Reel Studio never reads, stores or proxies a Claude credential: it never opens ~/.claude* files, it only runs
// `claude --version` and `claude auth status` and keeps the yes/no answer. The result never carries an e-mail,
// an organization or a token.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runProcess } from './cli';
import { cliEnv } from '../safety';

/** What the Connect screen needs to know. */
export type ClaudeCodeState = 'missing' | 'broken' | 'signed_out' | 'ready';

export interface LocalClaude {
  state: ClaudeCodeState;
  /** a `claude` binary was found and answered `--version` */
  installed: boolean;
  /** `claude auth status` said `loggedIn: true` */
  signedIn: boolean;
  /** absolute path to the binary (a GUI app on macOS does not inherit the shell's PATH) */
  bin?: string;
  version?: string;
  /** the plan KIND only, e.g. "pro" / "max" (`subscriptionType`); never who the account is */
  plan?: string;
  /** e.g. "claude.ai" */
  authMethod?: string;
  /** plain words when it is not ready */
  reason?: string;
}

export type Runner = (cmd: string, args: string[], opts?: { timeoutMs?: number }) => Promise<{ code: number | null; stdout: string; stderr: string }>;

export interface DetectOptions {
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

// No ANTHROPIC_* (or OPENAI_*) variable reaches `claude`, so a stray API key in the environment can never change
// what the person's own CLI reports or bills.
// `env` (the app's test switch can point it at a throwaway config folder) goes to the CLI through cliEnv().
const runnerFor = (env: NodeJS.ProcessEnv): Runner => async (cmd, args, o) => {
  const r = await runProcess(cmd, args, '', { timeoutMs: o?.timeoutMs ?? RUN_TIMEOUT_MS, env: cliEnv(env) });
  return { code: r.code, stdout: r.stdout, stderr: r.stderr };
};
const defaultExists = (p: string): boolean => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const defaultListDir = (d: string): string[] => { try { return fs.readdirSync(d); } catch { return []; } };

function homeOf(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  return (platform === 'win32' ? env.USERPROFILE || env.HOME : env.HOME || env.USERPROFILE) || os.homedir();
}

/** Newest-looking first: "v22.11.0" before "v20.3.1" (numeric, not alphabetical). */
function byVersionDesc(a: string, b: string): number {
  const n = (s: string) => s.replace(/^v/i, '').split(/[.\-_]/).map((x) => parseInt(x, 10) || 0);
  const x = n(a); const y = n(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((y[i] ?? 0) !== (x[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0);
  return 0;
}

/**
 * Where `claude` usually lives, in order. PATH first, then Anthropic's native installer (`~/.local/bin` on both
 * systems), the old local install, then package managers. On Windows only a real `claude.exe` is ever listed:
 * the npm `.cmd` shim is never spawned (the native binary npm installs is found under node_modules instead).
 */
export function claudeCandidates(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform,
  listDir: (dir: string) => string[] = defaultListDir): string[] {
  const win = platform === 'win32';
  const P = win ? path.win32 : path.posix;
  const home = homeOf(env, platform);
  const exe = win ? 'claude.exe' : 'claude';
  const out: string[] = [];
  const add = (p: string) => { if (P.isAbsolute(p) && !out.includes(p)) out.push(p); };
  const inDir = (d: string) => add(P.join(d, exe));

  for (const d of (env.PATH || env.Path || '').split(P.delimiter).filter(Boolean)) inDir(d);
  inDir(P.join(home, '.local', 'bin'));
  inDir(P.join(home, '.claude', 'local'));

  if (platform === 'darwin') {
    inDir('/opt/homebrew/bin');
    inDir('/usr/local/bin');
    inDir(P.join(home, '.npm-global', 'bin'));
    const nvm = P.join(home, '.nvm', 'versions', 'node');
    for (const v of listDir(nvm).sort(byVersionDesc)) inDir(P.join(nvm, v, 'bin'));
    inDir(P.join(home, '.volta', 'bin'));
    inDir(P.join(home, '.bun', 'bin'));
  } else if (win) {
    const local = env.LOCALAPPDATA || P.join(home, 'AppData', 'Local');
    const roaming = env.APPDATA || P.join(home, 'AppData', 'Roaming');
    inDir(P.join(local, 'Microsoft', 'WinGet', 'Links'));
    const pk = P.join(local, 'Microsoft', 'WinGet', 'Packages');
    for (const d of listDir(pk).filter((n) => /^Anthropic\.ClaudeCode_/i.test(n)).sort()) inDir(P.join(pk, d));
    // npm -g puts the native exe one or two levels under @anthropic-ai (claude-code\bin\claude.exe, or a
    // platform package such as claude-code-win32-x64\claude.exe, possibly nested in claude-code\node_modules)
    const scopes = [P.join(roaming, 'npm', 'node_modules', '@anthropic-ai')];
    for (const pkg of listDir(scopes[0])) scopes.push(P.join(scopes[0], pkg, 'node_modules', '@anthropic-ai'));
    for (const scope of scopes) {
      for (const pkg of listDir(scope).filter((n) => /^claude-code/i.test(n)).sort()) {
        const base = P.join(scope, pkg);
        inDir(base);
        inDir(P.join(base, 'bin'));
        for (const sub of listDir(base).filter((n) => n !== 'node_modules').sort()) inDir(P.join(base, sub));
      }
    }
  } else {
    inDir('/usr/local/bin');
    inDir('/usr/bin');
  }
  return out;
}

export function findClaude(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform,
  exists: (p: string) => boolean = defaultExists, listDir: (dir: string) => string[] = defaultListDir): string | null {
  return claudeCandidates(env, platform, listDir).find(exists) ?? null;
}

/**
 * macOS: an app opened from Finder gets a minimal PATH, so ask the person's login shell where `claude` is.
 * Only an absolute path to a file that exists is accepted (shell start-up files may print anything).
 */
export async function claudeFromLoginShell(run: Runner, env: NodeJS.ProcessEnv = process.env,
  exists: (p: string) => boolean = defaultExists): Promise<string | null> {
  const shell = env.SHELL && path.posix.isAbsolute(env.SHELL) && !/\s/.test(env.SHELL) ? env.SHELL : '/bin/zsh';
  try {
    const r = await run(shell, ['-ilc', 'command -v claude'], { timeoutMs: LOGIN_SHELL_TIMEOUT_MS });
    if (r.code !== 0) return null;
    const lines = r.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).reverse();
    return lines.find((l) => path.posix.isAbsolute(l) && /\/claude$/.test(l) && exists(l)) ?? null;
  } catch {
    return null;
  }
}

const SAFE_WORD = /^[A-Za-z0-9_.\-]{1,32}$/;
const safeWord = (v: unknown): string | undefined => (typeof v === 'string' && SAFE_WORD.test(v) && !v.includes('@') ? v : undefined);

/** The first JSON object in some output, or null. */
function parseJsonObject(s: string): Record<string, unknown> | null {
  const a = s.indexOf('{'); const b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { const j = JSON.parse(s.slice(a, b + 1)); return j && typeof j === 'object' && !Array.isArray(j) ? j : null; } catch { return null; }
}

export const CLAUDE_CODE_MESSAGES = {
  missing: 'We could not find the Claude Code app on this computer.',
  broken: 'We found the Claude Code app, but it did not start. Try installing it again.',
  signed_out: 'Your Claude Code app is not signed in yet.',
  unknown: 'We could not tell if your Claude Code app is signed in. Update it, then click Check again.',
  slow: 'Your Claude Code app took too long to answer. Click Check again.',
} as const;

/** Installed = `claude --version` exits 0. Signed in = `claude auth status` says `loggedIn: true`. */
export async function detectLocalClaude(o: DetectOptions = {}): Promise<LocalClaude> {
  const env = o.env ?? process.env;
  const run = o.run ?? runnerFor(env);
  const platform = o.platform ?? process.platform;
  const exists = o.exists ?? defaultExists;
  let bin: string | null = o.bin === undefined ? findClaude(env, platform, exists, o.listDir ?? defaultListDir) : o.bin;
  if (!bin && o.bin === undefined && platform === 'darwin') bin = await claudeFromLoginShell(run, env, exists);
  if (!bin) return { state: 'missing', installed: false, signedIn: false, reason: CLAUDE_CODE_MESSAGES.missing };

  let version: string | undefined;
  try {
    const v = await run(bin, ['--version'], { timeoutMs: RUN_TIMEOUT_MS });
    if (v.code !== 0) return { state: 'broken', installed: false, signedIn: false, bin, reason: CLAUDE_CODE_MESSAGES.broken };
    version = (v.stdout.match(/\d+\.\d+(?:\.\d+)?/) ?? [])[0];
  } catch {
    return { state: 'broken', installed: false, signedIn: false, bin, reason: CLAUDE_CODE_MESSAGES.broken };
  }

  const base = { installed: true, bin, ...(version ? { version } : {}) };
  let a: { code: number | null; stdout: string; stderr: string };
  try {
    a = await run(bin, ['auth', 'status'], { timeoutMs: RUN_TIMEOUT_MS });
  } catch (e: any) {
    const slow = e?.code === 'cli_timeout';
    return { ...base, state: 'signed_out', signedIn: false, reason: slow ? CLAUDE_CODE_MESSAGES.slow : CLAUDE_CODE_MESSAGES.unknown };
  }
  // Keep ONLY the yes/no and the plan kind. email, orgId, orgName and anything else in the answer are dropped here.
  const j = parseJsonObject(a.stdout);
  if (j && typeof j.loggedIn === 'boolean') {
    if (j.loggedIn === true) {
      const plan = safeWord(j.subscriptionType); const authMethod = safeWord(j.authMethod);
      return { ...base, state: 'ready', signedIn: true, ...(plan ? { plan } : {}), ...(authMethod ? { authMethod } : {}) };
    }
    return { ...base, state: 'signed_out', signedIn: false, reason: CLAUDE_CODE_MESSAGES.signed_out };
  }
  // Not JSON (an older CLI, or `--text` output): only a plain "not logged in" counts as an answer.
  const text = `${a.stdout}\n${a.stderr}`;
  if (/not (logged|signed) in|logged out|please (log|sign) in/i.test(text)) {
    return { ...base, state: 'signed_out', signedIn: false, reason: CLAUDE_CODE_MESSAGES.signed_out };
  }
  return { ...base, state: 'signed_out', signedIn: false, reason: CLAUDE_CODE_MESSAGES.unknown };
}
