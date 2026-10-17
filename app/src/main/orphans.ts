// Engine processes left running by a hard crash of the app (power cut, force quit) would keep
// rendering into a project the next app instance is about to resume. We record engine pids in a
// small file and, at startup, kill any that are still alive and are still our engine (command line).
import { execFile } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { killTree } from './proctree'

export function createPidRegistry(dir: string) {
  const file = join(dir, 'engines.json')
  const pids = new Set<number>()
  const save = (): void => {
    try {
      writeFileSync(file, JSON.stringify([...pids]))
    } catch {
      /* best effort */
    }
  }
  return {
    add(pid: number): void {
      pids.add(pid)
      save()
    },
    remove(pid: number): void {
      pids.delete(pid)
      save()
    },
    /** Kills engines left over from a previous run. Returns how many were killed. */
    async reap(): Promise<number> {
      let old: number[] = []
      try {
        old = JSON.parse(readFileSync(file, 'utf8'))
      } catch {
        return 0
      }
      let n = 0
      for (const pid of old) {
        if (typeof pid !== 'number' || pid <= 0) continue
        // After a crash the pid may already belong to someone else's python (pid reuse is routine on
        // Windows): only kill it if its command line is really our engine.
        if (isOurEngine(await processCommandLine(pid))) {
          await killTree(pid)
          n++
        }
      }
      save()
      return n
    }
  }
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
