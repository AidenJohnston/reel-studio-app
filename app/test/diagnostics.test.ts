import { afterEach, describe, expect, it, vi } from 'vitest'
import { diagnosticsReport, lastLines, logDuration, redactDiagnostics, sharedDeadline } from '../src/main/diagnostics'

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

  it('takes out the whole account name: apostrophes, spaces, dots, hyphens and accents', () => {
    const home = '/Users/zoe'
    expect(redactDiagnostics("open /Users/O'Connor/Documents/clip.mp4", home)).toBe('open /Users/<user>/Documents/clip.mp4')
    expect(redactDiagnostics("/Users/José.Núñez-O'Brien/Movies/a.mov", home)).toBe('/Users/<user>/Movies/a.mov')
    expect(redactDiagnostics('C:\\Users\\Zoë-Ann Smith Jr.\\Videos\\take 1.mov', 'C:\\Users\\other')).toBe(
      'C:\\Users\\<user>\\Videos\\take 1.mov'
    )
    expect(redactDiagnostics("/home/d'arcy/x", home)).toBe('/home/<user>/x')
    // a name with nothing after it: the JSON string's closing quote stays
    expect(redactDiagnostics(`{"path":"/Users/O'Connor"}`, home)).toBe('{"path":"/Users/<user>"}')
    // the person's own home folder with an apostrophe becomes ~
    expect(redactDiagnostics("/Users/O'Connor/Documents/clip.mp4", "/Users/O'Connor")).toBe('~/Documents/clip.mp4')
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

describe('sharedDeadline', () => {
  afterEach(() => vi.useRealTimers())

  it('gives each check its answer, an error, or a timeout at ONE shared deadline', async () => {
    vi.useFakeTimers()
    const d = sharedDeadline(5000)
    const hangs = new Promise<string>(() => {}) // a CLI that never answers and ignores its stop signal
    const slowButInTime = new Promise<string>((resolve) => setTimeout(() => resolve('late but ok'), 4000))
    const all = Promise.all([
      d.within(Promise.resolve('ready')),
      d.within(Promise.reject(new Error('broken'))),
      d.within(hangs),
      d.within(slowButInTime),
      d.within(hangs)
    ])
    await vi.advanceTimersByTimeAsync(5000)
    const [ok, failed, timedOut, inTime, alsoTimedOut] = await all
    d.done()
    expect(ok).toEqual({ ok: true, value: 'ready' })
    expect(failed).toEqual({ ok: false, reason: 'error' })
    expect(timedOut).toEqual({ ok: false, reason: 'timeout' })
    expect(inTime).toEqual({ ok: true, value: 'late but ok' })
    // two hung checks still finish at 5 s in total, not 10
    expect(alsoTimedOut).toEqual({ ok: false, reason: 'timeout' })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('names the checks that timed out in the report', () => {
    const text = diagnosticsReport(
      {
        appVersion: '0.1.4',
        packaged: true,
        os: 'macOS 15.1.0',
        arch: 'arm64',
        cpu: 'Apple M2',
        memoryGb: 16,
        electron: '44.8.0',
        engine: 'real',
        aiEditor: 'Claude (your Claude Code app), connected',
        claudeCode: { state: 'no answer within 5 s' },
        codex: null,
        listeningModel: 'ready',
        timedOut: ['Claude Code app']
      },
      'line',
      new Date('2026-11-12T10:00:00Z')
    )
    expect(text).toContain('Claude Code app: no answer within 5 s\n')
    expect(text).toContain('Timed out: Claude Code app\n')
    expect(text).toContain('Codex app: not checked\n')
  })
})
