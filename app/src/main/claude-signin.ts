// "Sign in to your Claude Code app": opens a terminal window that runs Anthropic's own `claude` CLI so the person
// signs in THERE, with their own Claude account. Reel Studio never sees, stores, reads or proxies that sign-in:
// the launcher script holds nothing but the path of the CLI, and the app only learns "signed in or not" by asking
// the CLI afterwards (`claude auth status`, see @reelstudio/ai localClaude.ts).
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { join, posix, win32 } from 'node:path'
import type { ClaudeCodeInfo, ClaudeCodeState } from '../shared/api'

/** Plain words shown in the terminal window. No em dashes, nothing that names Reel Studio as Claude. */
export const SIGN_IN_LINES = [
  'Sign in to Claude in this window.',
  'When it says you are signed in, close this window and go back to Reel Studio.'
] as const
export const SIGN_IN_TITLE = 'Sign in to Claude'

// cmd.exe gives these a meaning even inside double quotes (% expands, ^ & | < > in some contexts, " ends the
// quote). A path with any of them is refused rather than escaped: claude is never installed in such a folder.
const WIN_UNSAFE = /["%^&|<>\r\n\0]/
const MAC_UNSAFE = /[\r\n\0]/

export class LauncherError extends Error {
  readonly code = 'CLAUDE_SIGN_IN'
  constructor(public readonly userMessage: string) {
    super(userMessage)
  }
}

const BAD_PATH = 'Your Claude Code app is in a folder we cannot open safely. Sign in from a terminal instead: run claude there.'

/** Single-quote a string for /bin/sh: 'it'\''s' */
export const shQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`

export interface Launcher {
  fileName: string
  contents: string
  /** posix permission bits to set (macOS .command must be executable) */
  mode?: number
}

/** The Windows launcher: a .cmd that runs `"<bin>" auth login --claudeai` in a console window, then waits. */
export function windowsLauncher(bin: string): Launcher {
  if (!win32.isAbsolute(bin) || !/\.exe$/i.test(bin) || WIN_UNSAFE.test(bin)) throw new LauncherError(BAD_PATH)
  const lines = [
    '@echo off',
    `title ${SIGN_IN_TITLE}`,
    // the window runs in its own empty folder, and no ANTHROPIC_* variable (an API key) can change the sign-in
    'cd /d "%~dp0"',
    'for /f "delims==" %%v in (\'set ANTHROPIC_ 2^>nul\') do set "%%v="',
    'echo.',
    ...SIGN_IN_LINES.map((l) => `echo ${l}`),
    'echo.',
    `"${bin}" auth login --claudeai`,
    'echo.',
    'pause'
  ]
  return { fileName: 'Sign in to Claude.cmd', contents: lines.join('\r\n') + '\r\n' }
}

/** The macOS launcher: a .command (opens in Terminal) that runs `'<bin>' auth login --claudeai`, then waits. */
export function macLauncher(bin: string): Launcher {
  if (!posix.isAbsolute(bin) || MAC_UNSAFE.test(bin)) throw new LauncherError(BAD_PATH)
  const lines = [
    '#!/bin/sh',
    `printf '\\033]0;%s\\007' ${shQuote(SIGN_IN_TITLE)}`,
    'cd "$(dirname "$0")" || exit 1',
    'for v in $(env | sed -n \'s/^\\(ANTHROPIC_[A-Za-z0-9_]*\\)=.*/\\1/p\'); do unset "$v"; done',
    'echo',
    ...SIGN_IN_LINES.map((l) => `echo ${shQuote(l)}`),
    'echo',
    `${shQuote(bin)} auth login --claudeai`,
    'echo',
    "printf '%s' 'Press Return to close this window. '",
    'read _'
  ]
  return { fileName: 'Sign in to Claude.command', contents: lines.join('\n') + '\n', mode: 0o755 }
}

export function launcherFor(bin: string, platform: NodeJS.Platform): Launcher {
  if (platform === 'win32') return windowsLauncher(bin)
  if (platform === 'darwin') return macLauncher(bin)
  throw new LauncherError('Sign in from a terminal: run claude there.')
}

/** What the page may know: the state and the version, never the binary path or anything about the account. */
export function publicInfo(s: { state: ClaudeCodeState; version?: string; plan?: string; reason?: string }): ClaudeCodeInfo {
  return { state: s.state, ...(s.version ? { version: s.version } : {}), ...(s.plan ? { plan: s.plan } : {}), ...(s.reason ? { reason: s.reason } : {}) }
}

export interface OpenDeps {
  dir: string
  platform: NodeJS.Platform
  /** Electron shell.openPath: resolves '' on success, else an error message */
  open: (file: string) => Promise<string>
}

/** Writes the launcher into `dir` (replacing an old one) and opens it in the system terminal. */
export async function openSignInWindow(bin: string | undefined, deps: OpenDeps): Promise<string> {
  if (!bin) throw new LauncherError('We could not find the Claude Code app on this computer.')
  const l = launcherFor(bin, deps.platform)
  await mkdir(deps.dir, { recursive: true })
  const file = join(deps.dir, l.fileName)
  await writeFile(file, l.contents, 'utf8')
  if (l.mode !== undefined) await chmod(file, l.mode)
  const err = await deps.open(file)
  if (err) throw new LauncherError('The sign-in window did not open. Try again.')
  return file
}
