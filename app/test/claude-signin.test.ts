// "Sign in to your Claude Code app": the launcher script that opens Anthropic's own CLI in a terminal window.
import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  LauncherError,
  SIGN_IN_LINES,
  launcherFor,
  macLauncher,
  openSignInWindow,
  publicInfo,
  shQuote,
  windowsLauncher
} from '../src/main/claude-signin'

const WIN_BIN = 'C:\\Users\\Pat Q\\.local\\bin\\claude.exe'
const MAC_BIN = "/Users/pat o'neil/.local/bin/claude"

describe('Windows launcher (.cmd)', () => {
  const l = windowsLauncher(WIN_BIN)
  const lines = l.contents.split('\r\n')
  it('a titled console window with two plain lines, the CLI in double quotes, then pause', () => {
    expect(l.fileName).toBe('Sign in to Claude.cmd')
    expect(lines[0]).toBe('@echo off')
    expect(lines[1]).toBe('title Sign in to Claude')
    expect(lines).toContain(`echo ${SIGN_IN_LINES[0]}`)
    expect(lines).toContain(`echo ${SIGN_IN_LINES[1]}`)
    expect(lines).toContain(`"${WIN_BIN}" auth login --claudeai`)
    expect(lines.filter(Boolean).at(-1)).toBe('pause')
    expect(l.contents.endsWith('\r\n')).toBe(true)
  })
  it('runs in its own folder and clears ANTHROPIC_* first (an API key must not change the sign-in)', () => {
    expect(lines).toContain('cd /d "%~dp0"')
    expect(l.contents).toMatch(/set ANTHROPIC_ 2\^>nul'\) do set "%%v="/)
    const clear = lines.findIndex((x) => x.includes('ANTHROPIC_'))
    const run = lines.findIndex((x) => x.includes(WIN_BIN))
    expect(clear).toBeLessThan(run)
  })
  it('holds only the binary path: no account, no token, no other program', () => {
    const programs = lines.filter((x) => x.includes('.exe'))
    expect(programs).toEqual([`"${WIN_BIN}" auth login --claudeai`])
    expect(l.contents).not.toMatch(/token|password|\w@\w/i)
  })
  it('refuses a path that could break out of the quotes', () => {
    for (const bad of ['C:\\a"b\\claude.exe', 'C:\\100%\\claude.exe', 'C:\\a^b\\claude.exe', 'C:\\a&calc\\claude.exe', 'C:\\a|b\\claude.exe',
      'C:\\a<b\\claude.exe', 'C:\\a>b\\claude.exe', 'C:\\a\r\nb\\claude.exe', 'C:\\a\nb\\claude.exe']) {
      expect(() => windowsLauncher(bad), JSON.stringify(bad)).toThrow(LauncherError)
    }
    expect(() => windowsLauncher('claude.exe')).toThrow(LauncherError) // not absolute
    expect(() => windowsLauncher('C:\\x\\claude.cmd')).toThrow(LauncherError) // never a .cmd shim
    expect(() => windowsLauncher("C:\\Users\\Pat O'Neil (Home)\\claude.exe")).not.toThrow()
  })
})

describe('macOS launcher (.command)', () => {
  const l = macLauncher(MAC_BIN)
  const lines = l.contents.split('\n')
  it('an executable sh script with the same two lines, the CLI single-quoted, then waits', () => {
    expect(l.fileName).toBe('Sign in to Claude.command')
    expect(l.mode).toBe(0o755)
    expect(lines[0]).toBe('#!/bin/sh')
    expect(lines).toContain(`echo 'Sign in to Claude in this window.'`)
    expect(lines).toContain(`echo 'When it says you are signed in, close this window and go back to Reel Studio.'`)
    expect(lines).toContain(`'/Users/pat o'\\''neil/.local/bin/claude' auth login --claudeai`)
    expect(lines.filter(Boolean).at(-1)).toBe('read _')
    expect(l.contents).not.toContain('\r')
  })
  it('clears ANTHROPIC_* and runs in its own folder', () => {
    expect(l.contents).toContain('cd "$(dirname "$0")" || exit 1')
    expect(l.contents).toMatch(/ANTHROPIC_\[A-Za-z0-9_\]\*.*unset "\$v"/)
  })
  it('refuses CR, LF, NUL and relative paths', () => {
    for (const bad of ['/a\nb/claude', '/a\rb/claude', '/a\0b/claude', 'claude']) expect(() => macLauncher(bad)).toThrow(LauncherError)
  })
  it('shQuote survives every quote', () => {
    expect(shQuote("it's")).toBe(`'it'\\''s'`)
    expect(shQuote("''")).toBe(`''\\'''\\'''`)
  })
})

describe('the sign-in window', () => {
  it('UI copy: no em dashes, and Reel Studio is never called Claude Code', () => {
    for (const l of [windowsLauncher(WIN_BIN).contents, macLauncher(MAC_BIN).contents]) {
      expect(l).not.toContain('\u2014')
      expect(l).not.toMatch(/Reel Studio is|Claude Code/)
    }
  })
  it('other systems get a plain "use a terminal" message', () => {
    expect(() => launcherFor('/usr/bin/claude', 'linux')).toThrow(/terminal/)
  })
  it('writes the script, makes it executable on a Mac, opens it, and reports a failed open', async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'rs signin ')), 'claude-sign-in')
    const opened: string[] = []
    const file = await openSignInWindow(MAC_BIN, { dir, platform: 'darwin', open: async (f) => (opened.push(f), '') })
    expect(opened).toEqual([file])
    expect(readFileSync(file, 'utf8')).toBe(macLauncher(MAC_BIN).contents)
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o755)
    const again = await openSignInWindow(WIN_BIN, { dir, platform: 'win32', open: async () => '' })
    expect(readFileSync(again, 'utf8')).toBe(windowsLauncher(WIN_BIN).contents)
    await expect(openSignInWindow(WIN_BIN, { dir, platform: 'win32', open: async () => 'No application is associated' })).rejects.toMatchObject({
      code: 'CLAUDE_SIGN_IN',
      userMessage: 'The sign-in window did not open. Try again.'
    })
    await expect(openSignInWindow(undefined, { dir, platform: 'win32', open: async () => '' })).rejects.toBeInstanceOf(LauncherError)
  })
  it('the page gets the state, version, plan and reason only (never the binary path)', () => {
    expect(publicInfo({ state: 'ready', version: '2.1.304', plan: 'max', bin: WIN_BIN } as never)).toEqual({ state: 'ready', version: '2.1.304', plan: 'max' })
    expect(publicInfo({ state: 'missing', reason: 'x' })).toEqual({ state: 'missing', reason: 'x' })
  })
})
