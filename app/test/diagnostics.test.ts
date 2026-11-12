import { describe, expect, it } from 'vitest'
import { diagnosticsReport, lastLines, logDuration, redactDiagnostics } from '../src/main/diagnostics'

describe('logDuration', () => {
  it('logs the request before starting and completion after returning the result', async () => {
    const logs: string[] = []
    const result = await logDuration('[dialog] Pick a song', (line) => logs.push(line), async () => {
      expect(logs).toEqual(['[dialog] Pick a song started'])
      return { canceled: true, filePaths: [] }
    })
    expect(result).toEqual({ canceled: true, filePaths: [] })
    expect(logs[1]).toMatch(/^\[dialog\] Pick a song completed durationMs=\d+$/)
  })

  it('logs failures without exposing the error or changing the rejection', async () => {
    const logs: string[] = []
    const error = new Error('/private/path/song.mp3')
    await expect(logDuration('[library] classify fileCount=1', (line) => logs.push(line), async () => {
      throw error
    })).rejects.toBe(error)
    expect(logs).toHaveLength(2)
    expect(logs[1]).toMatch(/^\[library\] classify fileCount=1 failed durationMs=\d+$/)
    expect(logs.join('\n')).not.toContain(error.message)
  })
})

describe('Copy diagnostics', () => {
  it('takes the user name out of paths on a Mac and on Windows', () => {
    const mac = redactDiagnostics('[start] root=/Users/zoe.muller/Documents/Reel Studio and /Users/someone/x', '/Users/zoe.muller')
    expect(mac).toBe('[start] root=~/Documents/Reel Studio and /Users/<user>/x')
    expect(redactDiagnostics('a /Users/zoey/b and /Users/zoe', '/Users/zoe')).toBe('a /Users/<user>/b and ~')
    const win = redactDiagnostics(
      '[model] reused C:\\Users\\Zoë Müller\\.cache\\hf and c:/users/zoë müller/AppData and D:\\Users\\Other\\a',
      'C:\\Users\\Zoë Müller'
    )
    expect(win).toBe('[model] reused ~\\.cache\\hf and ~/AppData and D:\\Users\\<user>\\a')
  })

  it('removes e-mail addresses, keys and tokens', () => {
    const line = [
      'mail zoe@example.com',
      'key v1.eyJjaGVja291dCI6ImNzXzEyMyJ9.c2lnbmF0dXJlLWhlcmU',
      'api sk-ant-api03-abcdefghijklmnop',
      'Authorization: Bearer abc.def.ghi',
      'https://getreelstudio.com/updates.html#key=secret123&x=1',
      'session 0123456789abcdef0123456789abcdef01234567'
    ].join('\n')
    const out = redactDiagnostics(line, '/Users/zoe')
    expect(out).not.toMatch(/zoe@|eyJ|sk-ant|abc\.def|secret123|0123456789abcdef/)
    expect(out).toContain('mail <email>')
    expect(out).toContain('key <key>')
    expect(out).toContain('Bearer <token>')
    expect(out).toContain('#key=<redacted>&x=1')
  })

  it('keeps only the last lines and drops a partial first line', () => {
    expect(lastLines('half line\na\nb\nc\n', 2, true)).toBe('b\nc')
    expect(lastLines('half line\na\n', 5, true)).toBe('a')
    expect(lastLines('a\nb', 5)).toBe('a\nb')
  })

  it('writes one plain-text block', () => {
    const text = diagnosticsReport(
      {
        appVersion: '0.1.4',
        packaged: true,
        os: 'macOS 15.1.0',
        arch: 'arm64',
        cpu: 'Apple M2',
        memoryGb: 16,
        inApplications: false,
        electron: '44.8.0',
        engine: 'real',
        aiEditor: 'Claude (your Claude Code app), connected',
        claudeCode: { state: 'ready', version: '2.1.3', plan: 'pro' },
        codex: { state: 'missing' },
        listeningModel: 'ready'
      },
      'line 1\nline 2',
      new Date('2026-11-12T10:00:00Z')
    )
    expect(text).toContain('App: 0.1.4\n')
    expect(text).toContain('Computer: macOS 15.1.0, arm64, Apple M2, 16 GB')
    expect(text).toContain('In Applications: no')
    expect(text).toContain('Claude Code app: ready, version 2.1.3, plan pro')
    expect(text).toContain('Codex app: missing')
    expect(text.endsWith('line 1\nline 2\n')).toBe(true)
  })
})
