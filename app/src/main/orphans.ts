// Engine processes left running by a hard crash of the app (power cut, force quit) would keep
// rendering into a project the next app instance is about to resume. We record each engine's pid and
// project in a small file, from its start until it and everything it started have exited, and at
// startup stop whatever of ours is still running. A project with something we could not stop stays
// closed, its lock file kept (owner.ts), until nothing of ours runs in it.
import { execFile } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { groupAlive, isAlive, killTree } from './proctree'

/** `stop` ends a pid's process tree and reports whether all of it is gone (proctree killTree). */
export function createPidRegistry(dir: string, stop: (pid: number) => Promise<boolean> = killTree) {
  const file = join(dir, 'engines.json')
  const engines = new Map<number, string | null>()
  const save = (): void => {
    try {
      writeFileSync(file, JSON.stringify([...engines].map(([pid, project]) => ({ pid, project }))))
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
     * stop, which stay registered for the next start. */
    async reap(): Promise<{ stopped: number; stillRunning: string[] }> {
      let old: { pid: number; project: string | null }[] = []
      try {
        // a plain pid list was written by 0.1.x
        old = JSON.parse(readFileSync(file, 'utf8')).map((e: number | { pid: number; project: string | null }) => (typeof e === 'number' ? { pid: e, project: null } : e))
      } catch {
        return { stopped: 0, stillRunning: [] }
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
        if (project) stillRunning.push(project)
      }
      save()
      return { stopped, stillRunning }
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
