// Engine processes left running by a hard crash of the app (power cut, force quit) would keep
// rendering into a project the next app instance is about to resume. We record each engine's pid and
// project in a small file, from its start until it and everything it started have exited, and at
// startup stop whatever of ours is still running. A project with something we could not stop stays
// closed until nothing of ours runs in it.
import { execFile } from 'node:child_process'
import { closeSync, existsSync, fsyncSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeSync } from 'node:fs'
import { uptime } from 'node:os'
import { basename, join } from 'node:path'
import { projectsDir } from './paths'
import { groupAlive, isAlive, killTree } from './proctree'

/** `stop` ends a pid's process tree and reports whether all of it is gone (proctree killTree). */
export function createPidRegistry(dir: string, stop: (pid: number) => Promise<boolean> = killTree) {
  const file = join(dir, 'engines.json')
  // `startedAt`: the clock when the engine was registered, right after it started; 0.1.x and earlier
  // builds of this list have none
  const engines = new Map<number, { project: string | null; startedAt?: number }>()
  // A list that cannot be read may hide engines that are still running. It is kept aside, and every
  // start looks for them among the running processes (stillWorking) until a look finds none.
  const unreadable = join(dir, 'engines.unreadable.json')
  // Written whole or not at all: a crash mid-write must not leave a list the next start cannot read.
  const write = (): void => {
    const tmp = `${file}.${process.pid}.tmp`
    const fd = openSync(tmp, 'w')
    try {
      writeSync(fd, JSON.stringify([...engines].map(([pid, e]) => ({ pid, ...e }))))
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(tmp, file)
  }
  // On Windows the rename fails (EPERM, EBUSY, EACCES) while another program, such as a virus scanner or an
  // indexer, has engines.json open. The first attempt stays synchronous; a refused one is retried from a timer
  // with the latest list, so the main process never waits on the file. A newer save replaces a pending retry.
  // The schedule matches store.ts renameWithRetry: 40 retries, about 7 s in all.
  let retry: ReturnType<typeof setTimeout> | null = null
  const attempt = (tries: number): void => {
    try {
      write()
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? ''
      if (tries < 40 && ['EPERM', 'EBUSY', 'EACCES'].includes(code)) {
        retry = setTimeout(() => {
          retry = null
          attempt(tries + 1)
        }, Math.min(250, 10 + tries * 10))
        retry.unref?.()
      }
      /* otherwise best effort */
    }
  }
  const save = (): void => {
    if (retry) clearTimeout(retry)
    retry = null
    attempt(0)
  }
  return {
    add(pid: number, project: string | null): void {
      engines.set(pid, { project, startedAt: Date.now() })
      save()
    },
    remove(pid: number): void {
      engines.delete(pid)
      save()
    },
    /** Stops engines a previous run left behind. `stillRunning`: the projects of those that would not
     * stop, which stay registered for the next start. While the list cannot be read, or names an
     * engine with no video (`unknown`), it also has every project a running engine or ffmpeg names. */
    async reap(): Promise<{ stopped: number; stillRunning: string[]; unknown: boolean }> {
      let old: { pid: number; project: string | null; startedAt?: number }[] = []
      let unknown = existsSync(unreadable)
      try {
        // a plain pid list was written by 0.1.x
        old = JSON.parse(readFileSync(file, 'utf8')).map((e: number | { pid: number; project: string | null; startedAt?: number }) => (typeof e === 'number' ? { pid: e, project: null } : e))
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
          unknown = true
          try {
            renameSync(file, unreadable)
          } catch {
            /* looked for at this start only */
          }
        }
      }
      let stopped = 0
      const stillRunning: string[] = []
      for (const { pid, project, startedAt } of old) {
        if (!(typeof pid === 'number' && pid > 0)) continue
        const left = await leftRunning(pid, typeof startedAt === 'number' ? startedAt : undefined)
        if (left === 'gone') continue
        if (left === 'ours' && (await stop(pid))) {
          stopped++
          continue
        }
        engines.set(pid, typeof startedAt === 'number' ? { project, startedAt } : { project })
        // a 0.1.x list names no video, and a group that may not be ours is never stopped: which video
        // either writes to is as unknown as with an unreadable list
        if (project && left === 'ours') stillRunning.push(project)
        else unknown = true
      }
      save()
      if (!unknown) return { stopped, stillRunning, unknown }
      const folders = projectFolders()
      const working = await stillWorking(folders)
      if (working && !working.length) {
        try {
          rmSync(unreadable, { force: true })
        } catch {
          // on Windows another program (a scanner, an indexer) may have it open: the next start looks once more
        }
      }
      // with no process list nothing says which videos are safe: none opens at this start
      return { stopped, stillRunning: [...new Set([...stillRunning, ...(working ?? folders)])], unknown }
    }
  }
}

export function projectFolders(): string[] {
  try {
    return readdirSync(projectsDir(), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => join(projectsDir(), e.name))
  } catch {
    return []
  }
}

/** The folders a running engine or ffmpeg names in its arguments (an engine gets `--project`, its
 * ffmpeg the files it reads and writes there), or null when the processes cannot be listed. This only
 * reads: such a process may be an engine someone ran by hand, which is not the app's to stop. */
async function stillWorking(folders: string[]): Promise<string[] | null> {
  const procs = await processList()
  if (!procs) return null
  const working = procs.filter((p) => p.pid !== process.pid && (isOurEngine(p.cmdline) || FFMPEG.test(p.cmdline)))
  // the engine names the folder as the app gave it; its ffmpeg names the real path the engine resolved,
  // which differs when the storage folder is reached through a symlink or a junction
  return folders.filter((dir) => [dir, realPath(dir)].some((name) => working.some((p) => namesFolder(p.cmdline, name))))
}

function realPath(dir: string): string {
  try {
    return realpathSync.native(dir)
  } catch {
    return dir
  }
}

const FFMPEG = /(^|[\\/"\s])ff(mpeg|probe)(\.exe)?("|\s|$)/i

/** `dir` appears in the command line as a whole path: `.../bread` never matches `.../bread-rolls`, and
 * `/var/x` never matches `/private/var/x`. An argument starts it, or `=`, `:` or `,` inside one. */
function namesFolder(cmdline: string, dir: string): boolean {
  const norm = (s: string): string => (process.platform === 'win32' ? s.replace(/\//g, '\\').toLowerCase() : s)
  const line = norm(cmdline)
  const folder = norm(dir).replace(/[\\/]+$/, '')
  for (let i = line.indexOf(folder); i >= 0; i = line.indexOf(folder, i + 1)) {
    const before = i === 0 ? undefined : line[i - 1]
    const next = line[i + folder.length]
    if ((before === undefined || /["'\s=:,]/.test(before)) && (next === undefined || /[\\/"'\s]/.test(next))) return true
  }
  return false
}

/** Every running process with its full command line, or null when the list cannot be read. */
function processList(): Promise<{ pid: number; cmdline: string }[] | null> {
  return new Promise((resolve) => {
    const parse = (err: Error | null, out: string): void =>
      resolve(err ? null : out.split(/\r?\n/).flatMap((line) => {
        const m = /^\s*(\d+)\s+(.*\S)/.exec(line)
        return m ? [{ pid: Number(m[1]), cmdline: m[2] }] : []
      }))
    const big = 64 * 1024 * 1024
    if (process.platform === 'win32') {
      const list = '[Console]::OutputEncoding = [Text.Encoding]::UTF8; Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.CommandLine)" }'
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', list], { windowsHide: true, timeout: 30000, maxBuffer: big }, parse)
    } else {
      execFile('ps', ['-A', '-ww', '-o', 'pid=,args='], { env: psEnv(), timeout: 30000, maxBuffer: big }, parse)
    }
  })
}

/** Without a UTF-8 locale (an app opened from the Finder has none) macOS ps escapes every non-ASCII
 * byte, and "Zoë" would never match the folder it names. */
function psEnv(): NodeJS.ProcessEnv {
  return { ...process.env, LC_ALL: process.platform === 'darwin' ? 'en_US.UTF-8' : 'C.UTF-8' }
}

/** macOS/Linux: the processes in process group `pgid`, or null when they cannot be listed. */
function groupMembers(pgid: number): Promise<{ pid: number; cmdline: string }[] | null> {
  return new Promise((resolve) => {
    execFile('ps', ['-A', '-ww', '-o', 'pgid=,pid=,args='], { env: psEnv(), timeout: 30000, maxBuffer: 64 * 1024 * 1024 }, (err, out) =>
      resolve(err ? null : out.split(/\r?\n/).flatMap((line) => {
        const m = /^\s*(\d+)\s+(\d+)\s+(.*\S)/.exec(line)
        return m && Number(m[1]) === pgid ? [{ pid: Number(m[2]), cmdline: m[3] }] : []
      })))
  })
}

/** A process an engine of ours starts or is, judged by the program it runs (`ps -o comm`), never by
 * words in its arguments: `worker.py --encoder ffmpeg` is not ffmpeg. False once it has exited. */
async function isOursByProgram(p: { pid: number; cmdline: string }): Promise<boolean> {
  const program = basename((await processName(p.pid)) ?? '').toLowerCase()
  return /^ff(mpeg|probe)$/.test(program) || (/^python/.test(program) && isOurEngine(p.cmdline))
}

/** How far apart the clock when an engine was registered and the start time the system reports for
 * it may be: ps reports whole seconds, and the app registers the engine right after spawning it. */
const SAME_START_MS = 10_000

/** What a previous run's engine left running from this pid, judged by when it started, never by its
 * command line alone (a command line can say anything):
 * - nothing outlives a restart of the computer, and after one the number can belong to anyone;
 * - a live process with that pid is ours only if it is our engine and started when ours did (pid reuse
 *   is routine on Windows);
 * - on macOS/Linux, a process group with that number whose leader died is the group our engine led:
 *   neither system hands out a number while a group still holds it. Its members are checked too.
 * 'unsure' (left alone, kept on the list, and the scan decides which video stays closed): the members
 * hold something else, or the start time cannot be read. Entries from 0.1.x have no start time and are
 * judged by their command line as before. */
async function leftRunning(pid: number, startedAt?: number): Promise<'ours' | 'unsure' | 'gone'> {
  if (startedAt !== undefined && startedAt < Date.now() - uptime() * 1000 - 60_000) return 'gone'
  if (isAlive(pid)) {
    const p = await processInfo(pid)
    if (!p || !isOurEngine(p.cmdline)) return 'gone'
    if (startedAt === undefined) return 'ours'
    if (p.startedAt === null) return 'unsure'
    return Math.abs(p.startedAt - startedAt) <= SAME_START_MS ? 'ours' : 'gone'
  }
  if (process.platform === 'win32' || !groupAlive(pid)) return 'gone'
  const members = await groupMembers(pid)
  if (!members) return 'unsure'
  if (!members.length) return 'gone'
  return (await Promise.all(members.map(isOursByProgram))).every(Boolean) ? 'ours' : 'unsure'
}

/** Our engine is always started as `python [interpreter options] -m reelengine <command>` (engine.ts).
 * Only interpreter options may stand between python and `-m reelengine`: `python3 worker.py -m reelengine`
 * runs worker.py, which merely gets those words as arguments. */
export function isOurEngine(cmdline: string | null): boolean {
  const m = cmdline ? /\s-m\s+reelengine(\s|$)/.exec(cmdline) : null
  if (!cmdline || !m) return false
  let head = cmdline.slice(0, m.index).trimEnd()
  // interpreter options, from the end: flags (-s -E -B -u, or -sE), and -X / -W with their value,
  // attached (-Xutf8) or not (-X utf8), quoted when it has spaces
  for (let prev = ''; prev !== head; ) {
    prev = head
    head = head.replace(/\s+-[XW]\s*(?:"[^"]*"|'[^']*'|\S+)$/, '').replace(/\s+-[A-Za-z]+$/, '')
  }
  // What is left is the program. Its path may hold spaces (an app bundle, a quoted Windows path), so it
  // is the words up to the first one that names a python, and nothing may follow that one: in
  // `python3 /srv/python -m reelengine`, python3 runs a script.
  const words = head.trim().split(/\s+/)
  const first = words.findIndex((w) => /^python[\d.]*(\.exe)?$/i.test(w.replace(/["']/g, '').split(/[\\/]/).pop() ?? ''))
  return first >= 0 && first === words.length - 1
}

/** A running process's command line and the clock time it started (null when the system won't say), or
 * null if it is gone or cannot be read. */
function processInfo(pid: number): Promise<{ cmdline: string; startedAt: number | null } | null> {
  return new Promise((resolve) => {
    const id = Math.floor(pid)
    if (process.platform === 'win32') {
      // labelled lines: a start time Windows won't give leaves only the command line
      const script = `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${id}"; if ($p) { try { 'T:' + ([DateTimeOffset]$p.CreationDate).ToUnixTimeMilliseconds() } catch {}; 'C:' + $p.CommandLine }`
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 15000 }, (_err, out) => {
        const lines = (out ?? '').split(/\r?\n/)
        const cmdline = lines.find((l) => l.startsWith('C:'))?.slice(2).trim()
        const at = Number(lines.find((l) => l.startsWith('T:'))?.slice(2).trim())
        resolve(cmdline ? { cmdline, startedAt: Number.isFinite(at) && at > 0 ? at : null } : null)
      })
    } else {
      // etime: how long it has run, [[dd-]hh:]mm:ss
      execFile('ps', ['-p', String(id), '-o', 'etime=,args='], (err, out) => {
        const m = err ? null : /^\s*(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)\s+(.*\S)/.exec(out)
        if (!m) return resolve(null)
        const [, d, h, mi, s, cmdline] = m
        const ran = (((Number(d ?? 0) * 24 + Number(h ?? 0)) * 60 + Number(mi)) * 60 + Number(s)) * 1000
        resolve({ cmdline, startedAt: Date.now() - ran })
      })
    }
  })
}

/** Full command line of a running process, or null if it is gone (or cannot be read). */
export function processCommandLine(pid: number): Promise<string | null> {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${Math.floor(pid)}").CommandLine`],
        { windowsHide: true, timeout: 15000 },
        (err, out) => resolve(err ? null : out.trim() || null)
      )
    } else {
      execFile('ps', ['-p', String(Math.floor(pid)), '-o', 'args='], (err, out) => resolve(err ? null : out.trim() || null))
    }
  })
}

export function processName(pid: number): Promise<string | null> {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      execFile('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { windowsHide: true }, (err, out) => {
        if (err) return resolve(null)
        const m = /^"([^"]+)","(\d+)"/m.exec(out)
        resolve(m && Number(m[2]) === pid ? m[1] : null)
      })
    } else {
      execFile('ps', ['-p', String(pid), '-o', 'comm='], (err, out) => resolve(err ? null : out.trim() || null))
    }
  })
}
