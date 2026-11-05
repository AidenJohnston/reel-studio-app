// Engine processes left running by a hard crash of the app (power cut, force quit) would keep
// rendering into a project the next app instance is about to resume. We record each engine's pid and
// project in a small file, from its start until it and everything it started have exited, and at
// startup stop whatever of ours is still running. A project with something we could not stop stays
// closed until nothing of ours runs in it.
import { execFile } from 'node:child_process'
import { closeSync, existsSync, fsyncSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { projectsDir } from './paths'
import { groupAlive, isAlive, killTree } from './proctree'

/** `stop` ends a pid's process tree and reports whether all of it is gone (proctree killTree). */
export function createPidRegistry(dir: string, stop: (pid: number) => Promise<boolean> = killTree) {
  const file = join(dir, 'engines.json')
  const engines = new Map<number, string | null>()
  /** Engines of a previous run that reap could not stop, and the project each works in. */
  const leftover = new Map<number, string>()
  /** Projects reap kept closed only because the process scan found something working in them. */
  const scanned = new Set<string>()
  // A list that cannot be read may hide engines that are still running. It is kept aside, and every
  // start looks for them among the running processes (stillWorking) until a look finds none.
  const unreadable = join(dir, 'engines.unreadable.json')
  // Written whole or not at all: a crash mid-write must not leave a list the next start cannot read.
  const write = (): void => {
    const tmp = `${file}.${process.pid}.tmp`
    const fd = openSync(tmp, 'w')
    try {
      writeSync(fd, JSON.stringify([...engines].map(([pid, project]) => ({ pid, project }))))
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
      engines.set(pid, project)
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
      let old: { pid: number; project: string | null }[] = []
      let unknown = existsSync(unreadable)
      try {
        // a plain pid list was written by 0.1.x
        old = JSON.parse(readFileSync(file, 'utf8')).map((e: number | { pid: number; project: string | null }) => (typeof e === 'number' ? { pid: e, project: null } : e))
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
      for (const { pid, project } of old) {
        if (!(typeof pid === 'number' && pid > 0 && (await leftRunning(pid)))) continue
        if (await stop(pid)) {
          stopped++
          continue
        }
        engines.set(pid, project)
        if (project) leftover.set(pid, project)
        // a 0.1.x list names no video: which one it writes to is as unknown as with an unreadable list
        if (project) stillRunning.push(project)
        else unknown = true
      }
      save()
      if (!unknown) return { stopped, stillRunning, unknown }
      const folders = projectFolders()
      const working = await stillWorking(folders)
      if (working && !working.length) rmSync(unreadable, { force: true })
      for (const d of working ?? []) scanned.add(d)
      // with no process list nothing says which videos are safe: none opens at this start
      return { stopped, stillRunning: [...new Set([...stillRunning, ...(working ?? folders)])], unknown }
    },
    /** Resolves once nothing reap kept `project` closed for is still running (checked every `everyMs`):
     * every engine there that would not stop has exited, and the process scan, when it found something
     * there, finds nothing naming its folder any more. Null when reap did not keep it closed for either
     * (with no process list at all, nothing says when a video is safe again). */
    drained(project: string, everyMs = 2000): Promise<void> | null {
      const mine = (): number[] => [...leftover].filter(([, p]) => p === project).map(([pid]) => pid)
      if (!mine().length && !scanned.has(project)) return null
      const pause = (): Promise<void> => new Promise((r) => setTimeout(r, everyMs))
      return (async () => {
        while (mine().length) {
          for (const pid of mine()) {
            if (await mayStillRun(pid)) continue
            leftover.delete(pid)
            engines.delete(pid)
            save()
          }
          if (mine().length) await pause()
        }
        while (scanned.has(project)) {
          const working = await stillWorking([project])
          if (working && !working.length) scanned.delete(project)
          else await pause()
        }
      })()
    }
  }
}

function projectFolders(): string[] {
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
      // Without a UTF-8 locale (an app opened from the Finder has none) macOS ps escapes every
      // non-ASCII byte, and "Zoë" would never match the folder it names.
      const env = { ...process.env, LC_ALL: process.platform === 'darwin' ? 'en_US.UTF-8' : 'C.UTF-8' }
      execFile('ps', ['-A', '-ww', '-o', 'pid=,args='], { env, timeout: 30000, maxBuffer: big }, parse)
    }
  })
}

/** Something of ours still runs from this pid: the engine itself (after a crash the pid may belong to
 * someone else's python, pid reuse is routine on Windows, so only a command line that is really our
 * engine counts), or on macOS/Linux what is left in the process group of an engine that died. */
async function leftRunning(pid: number): Promise<boolean> {
  if (isAlive(pid)) return isOurEngine(await processCommandLine(pid))
  return process.platform !== 'win32' && groupAlive(pid)
}

/** For an engine reap already found to be ours: alive with a command line that can't be read (a slow
 * or failed `ps`/PowerShell) still counts as running, so its render slot is never freed early. */
async function mayStillRun(pid: number): Promise<boolean> {
  // what is left in a dead engine's process group (macOS/Linux) still counts, even when its pid now
  // shows another program
  const group = process.platform !== 'win32' && groupAlive(pid)
  if (!isAlive(pid)) return group
  const cmdline = await processCommandLine(pid)
  return cmdline === null || isOurEngine(cmdline) || group
}

/** Our engine is always started as `python ... -m reelengine <command>` (engine.ts). */
export function isOurEngine(cmdline: string | null): boolean {
  return !!cmdline && /python/i.test(cmdline) && /(^|\s)-m\s+reelengine(\s|$)/.test(cmdline)
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
