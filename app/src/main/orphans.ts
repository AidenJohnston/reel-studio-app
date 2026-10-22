// Engine processes left running by a hard crash of the app (power cut, force quit) would keep
// rendering into a project the next app instance is about to resume. We record each engine's pid and
// project in a small file, from its start until it and everything it started have exited, and at
// startup stop whatever of ours is still running. A project with something we could not stop stays
// closed, its lock file kept (owner.ts), until nothing of ours runs in it.
import { execFile } from 'node:child_process'
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from 'node:fs'
import { uptime } from 'node:os'
import { join } from 'node:path'
import { lockedProjects } from './owner'
import { groupAlive, isAlive, killTree } from './proctree'

/** `stop` ends a pid's process tree and reports whether all of it is gone (proctree killTree). */
export function createPidRegistry(dir: string, stop: (pid: number) => Promise<boolean> = killTree) {
  const file = join(dir, 'engines.json')
  const engines = new Map<number, string | null>()
  // A list that cannot be read may hide engines that are still running: it is kept aside, and every
  // project left locked stays closed, until the computer has restarted since it was written.
  const unreadable = join(dir, 'engines.unreadable.json')
  // Written whole or not at all: a crash mid-write must not leave a list the next start cannot read.
  const save = (): void => {
    const tmp = `${file}.${process.pid}.tmp`
    try {
      const fd = openSync(tmp, 'w')
      try {
        writeSync(fd, JSON.stringify([...engines].map(([pid, project]) => ({ pid, project }))))
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      renameSync(tmp, file)
    } catch {
      /* best effort */
    }
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
     * stop, which stay registered for the next start, and while the list was unreadable (`unknown`)
     * every project still locked. */
    async reap(): Promise<{ stopped: number; stillRunning: string[]; unknown: boolean }> {
      let old: { pid: number; project: string | null }[] = []
      let unknown = false
      try {
        // a plain pid list was written by 0.1.x
        old = JSON.parse(readFileSync(file, 'utf8')).map((e: number | { pid: number; project: string | null }) => (typeof e === 'number' ? { pid: e, project: null } : e))
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
          unknown = true
          try {
            renameSync(file, unreadable) // keeps its time: when the last run last wrote it
          } catch {
            /* closed for this start only */
          }
        }
      }
      try {
        if (statSync(unreadable).mtimeMs > Date.now() - uptime() * 1000) unknown = true
        else rmSync(unreadable)
      } catch {
        /* nothing kept aside */
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
        // a 0.1.x list names no video: which one it writes to is as unknown as with an unreadable list
        if (project) stillRunning.push(project)
        else unknown = true
      }
      save()
      return { stopped, stillRunning: unknown ? [...new Set([...stillRunning, ...(await lockedProjects())])] : stillRunning, unknown }
    }
  }
}

/** Something of ours still runs from this pid: the engine itself (after a crash the pid may belong to
 * someone else's python, pid reuse is routine on Windows, so only a command line that is really our
 * engine counts), or on macOS/Linux what is left in the process group of an engine that died. */
async function leftRunning(pid: number): Promise<boolean> {
  if (isAlive(pid)) return isOurEngine(await processCommandLine(pid))
  return process.platform !== 'win32' && groupAlive(pid)
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
