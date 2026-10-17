// Detects Claude Code installed and signed in on this computer, for builds that set
// `allowLocalClaudeCode` (a local Claude Code build). Public builds never call this.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runProcess } from './cli';

export interface LocalClaude {
  installed: boolean;
  loggedIn: boolean;
  /** absolute path to the claude binary (a GUI app on macOS does not inherit the shell's PATH) */
  bin?: string;
  version?: string;
  account?: string;
  /** plain-English reason when not usable */
  reason?: string;
}

export type Runner = (cmd: string, args: string[]) => Promise<{ code: number | null; stdout: string; stderr: string }>;

const defaultRunner: Runner = async (cmd, args) => {
  const r = await runProcess(cmd, args, '', { timeoutMs: 15_000 });
  return { code: r.code, stdout: r.stdout, stderr: r.stderr };
};

/** Where `claude` usually lives, in order: PATH, then the installer's and package managers' folders. */
export function claudeCandidates(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string[] {
  const P = platform === 'win32' ? path.win32 : path.posix;
  const home = env.HOME || env.USERPROFILE || os.homedir();
  const exe = platform === 'win32' ? ['claude.exe'] : ['claude'];
  const dirs = (env.PATH || env.Path || '').split(P.delimiter).filter(Boolean);
  dirs.push(P.join(home, '.local', 'bin'), P.join(home, '.claude', 'local'));
  if (platform === 'darwin') dirs.push('/opt/homebrew/bin', '/usr/local/bin');
  if (platform === 'linux') dirs.push('/usr/local/bin', '/usr/bin');
  const out: string[] = [];
  for (const d of dirs) for (const e of exe) { const p = P.join(d, e); if (!out.includes(p)) out.push(p); }
  return out;
}

export function findClaude(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform,
  exists: (p: string) => boolean = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } }): string | null {
  return claudeCandidates(env, platform).find(exists) ?? null;
}

/** Installed = a `claude` binary answers `--version`. Signed in = `claude auth status` says so. */
export async function detectLocalClaude(o: { run?: Runner; bin?: string | null } = {}): Promise<LocalClaude> {
  const run = o.run ?? defaultRunner;
  const bin = o.bin === undefined ? findClaude() : o.bin;
  if (!bin) return { installed: false, loggedIn: false, reason: 'Claude Code is not installed on this computer.' };
  let version: string | undefined;
  try {
    const v = await run(bin, ['--version']);
    if (v.code !== 0) return { installed: false, loggedIn: false, bin, reason: 'Claude Code is installed but did not start.' };
    version = v.stdout.trim().split(/\s+/)[0] || undefined;
  } catch {
    return { installed: false, loggedIn: false, bin, reason: 'Claude Code is not installed on this computer.' };
  }
  try {
    const a = await run(bin, ['auth', 'status']);
    const j = JSON.parse(a.stdout.slice(a.stdout.indexOf('{')));
    if (j && j.loggedIn === true) return { installed: true, loggedIn: true, bin, version, account: j.email ?? j.account ?? undefined };
    return { installed: true, loggedIn: false, bin, version, reason: 'Claude Code is installed but not signed in. Open a terminal, run claude, and sign in.' };
  } catch {
    return { installed: true, loggedIn: false, bin, version, reason: 'I could not tell whether Claude Code is signed in. Open a terminal, run claude, and sign in.' };
  }
}
