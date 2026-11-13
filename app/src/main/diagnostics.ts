export async function logDuration<T>(label: string, log: (line: string) => void, operation: () => Promise<T>): Promise<T> {
  const started = performance.now()
  log(`${label} started`)
  let outcome = 'failed'
  try {
    const result = await operation()
    outcome = 'completed'
    return result
  } finally {
    log(`${label} ${outcome} durationMs=${Math.round(performance.now() - started)}`)
  }
}

// ---- "Copy diagnostics" (Settings > About, and Help on a Mac) ------------------------------------------------------
// One block of plain text the person pastes into a bug report: what is running, on what, which AI editor and how it
// answered, and the end of the app's log. Nothing is sent anywhere: it goes to the clipboard on the person's click.
// The log is redacted here first (user name in paths, e-mail addresses, keys and tokens), so a pasted report is safe
// to post in a group chat. File names of videos can still appear, and the Settings text says so.

/** How much of the log goes in: the last lines of its last bytes. */
export const DIAGNOSTICS_LOG_LINES = 300
export const DIAGNOSTICS_LOG_BYTES = 256 * 1024

export interface CliFacts {
  state: string
  version?: string
  plan?: string
}

export interface DiagnosticsFacts {
  appVersion: string
  packaged: boolean
  /** "macOS 15.1.0", "Windows 10.0.26200" */
  os: string
  arch: string
  /** the chip, from os.cpus(): "Apple M2", "Intel(R) Core(TM) i7-..." */
  cpu: string
  memoryGb: number
  /** a Mac app running under Rosetta (an Intel build on an Apple chip) */
  translated?: boolean
  /** macOS: the app is in /Applications (false = run from the disk image or Downloads) */
  inApplications?: boolean
  electron: string
  engine: string
  aiEditor: string
  claudeCode: CliFacts | null
  codex: CliFacts | null
  listeningModel: string
  /** the checks that did not answer within DIAGNOSTICS_CHECK_MS, in plain words */
  timedOut?: string[]
}

const SECRET_PATTERNS: [RegExp, string][] = [
  // a Reel Studio download key (main/update-key.ts KEY_RE), anywhere in a line
  [/\bv1\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '<key>'],
  [/\bsk-[A-Za-z0-9_-]{10,}/g, '<key>'],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 <token>'],
  [/([?&#](?:key|token|code|state|access_token|id_token|sig|signature)=)[^&\s"']+/gi, '$1<redacted>'],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<email>'],
  // long opaque ids (tokens, session ids); hashes go too, which costs nothing in a bug report
  [/\b[A-Za-z0-9_-]{40,}\b/g, '<id>']
]

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Takes the person's user name out of `text`: their home folder becomes `~` (either slash, any case on Windows), and
 * any other `Users/<name>` or `home/<name>` folder becomes `<user>`. Then e-mail addresses, keys and tokens go.
 */
export function redactDiagnostics(text: string, home: string): string {
  let out = text
  const h = home.replace(/[\\/]+$/, '')
  if (h.length > 3) {
    const pattern = h
      .split(/[\\/]+/)
      .map(escapeRe)
      .join('[\\\\/]+')
    // only a whole folder name: /Users/zoe must not eat the start of /Users/zoey
    out = out.replace(new RegExp(`${pattern}(?=[\\\\/\\s"']|$)`, 'gim'), '~')
  }
  // The whole folder name, up to the next slash: account names can hold apostrophes, spaces, dots, hyphens and
  // non-ASCII letters (O'Connor, Zoë-Ann Smith Jr.). A name with no slash after it runs to a double quote (a JSON
  // string) or the end of the line, which may take a little more than the name: better too much than part of it.
  out = out.replace(/([\\/](?:Users|home)[\\/]+)[^\\/\r\n"]+/gi, '$1<user>')
  for (const [re, to] of SECRET_PATTERNS) out = out.replace(re, to)
  return out
}

/** The last `n` lines of `text` (a partial first line, from reading a byte tail, is dropped). */
export function lastLines(text: string, n: number, cutAtStart = false): string {
  const lines = text.split(/\r?\n/)
  if (cutAtStart) lines.shift()
  while (lines.length && lines[lines.length - 1] === '') lines.pop()
  return lines.slice(-n).join('\n')
}

// ---- one time limit for the optional checks -----------------------------------------------------------------------
// Asking the Claude Code and Codex apps can take up to 15 s each, and a broken install can hang. The report must still
// copy, so every optional check shares ONE deadline; whatever has not answered by then is marked as timed out.

/** How long the optional checks may take, all together. */
export const DIAGNOSTICS_CHECK_MS = 5000

export type Settled<T> = { ok: true; value: T } | { ok: false; reason: 'timeout' | 'error' }

/**
 * One deadline, `ms` from now, shared by every check wrapped in `within()`: each resolves to its value, `error` if it
 * threw, or `timeout` if it was still running when the deadline passed. A check left running is not stopped here (its
 * own code owns that). Call `done()` once all are settled, so the timer does not keep the process busy.
 */
export function sharedDeadline(ms: number): { within<T>(check: Promise<T>): Promise<Settled<T>>; done(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined
  const passed = new Promise<{ ok: false; reason: 'timeout' }>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, reason: 'timeout' }), ms)
  })
  return {
    within: <T>(check: Promise<T>): Promise<Settled<T>> =>
      Promise.race([
        check.then(
          (value): Settled<T> => ({ ok: true, value }),
          (): Settled<T> => ({ ok: false, reason: 'error' })
        ),
        passed
      ]),
    done: () => clearTimeout(timer)
  }
}

/** The words for a check that did not answer in time. */
export const timedOutText = (ms: number): string => `no answer within ${Math.round(ms / 1000)} s`

const cli = (c: CliFacts | null): string =>
  c ? [c.state, c.version && `version ${c.version}`, c.plan && `plan ${c.plan}`].filter(Boolean).join(', ') : 'not checked'

/** The text "Copy diagnostics" puts on the clipboard. `log` is already redacted. */
export function diagnosticsReport(f: DiagnosticsFacts, log: string, when: Date): string {
  const lines = [
    'Reel Studio diagnostics',
    `Copied: ${when.toISOString()}`,
    `App: ${f.appVersion}${f.packaged ? '' : ' (development build)'}`,
    `Computer: ${f.os}, ${f.arch}${f.translated ? ' under Rosetta' : ''}, ${f.cpu}, ${f.memoryGb} GB`,
    ...(f.inApplications === undefined ? [] : [`In Applications: ${f.inApplications ? 'yes' : 'no'}`]),
    `Electron: ${f.electron}`,
    `Engine: ${f.engine}`,
    `AI editor: ${f.aiEditor}`,
    `Claude Code app: ${cli(f.claudeCode)}`,
    `Codex app: ${cli(f.codex)}`,
    `Listening model: ${f.listeningModel}`,
    ...(f.timedOut?.length ? [`Timed out: ${f.timedOut.join(', ')}`] : []),
    '',
    `Recent log (last ${DIAGNOSTICS_LOG_LINES} lines):`,
    log || '(empty)'
  ]
  return lines.join('\n') + '\n'
}
