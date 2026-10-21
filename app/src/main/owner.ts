// The running app is the only writer of its projects. Electron's single-instance lock (index.ts) is
// held by the OS until this process dies, so no second app can be running, and inside the app the job
// lane (jobs.ts) runs one job or manual edit per project at a time. work/.owner.lock does not decide
// any of that: it tells tools run by hand (the engine CLI, the AI dev CLI) that the app has the project
// open, and they refuse while it exists (engine/reelengine/owner.py, ai/src/owner.ts).
import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { projectsDir } from './paths'
import { writeJson } from './store'

export const OWNER_LOCK = join('work', '.owner.lock')

/** `token` goes to every engine command and AI edit the job runs (`--owner`). */
export interface ProjectOwner {
  token: string
  release(): Promise<void>
}

export async function claimProject(dir: string): Promise<ProjectOwner> {
  const token = randomUUID()
  const lock = join(dir, OWNER_LOCK)
  await fs.mkdir(dirname(lock), { recursive: true })
  await writeJson(lock, { app: 'Reel Studio', pid: process.pid, token })
  return { token, release: () => fs.rm(lock, { force: true }) }
}

/** At startup, before any job: every lock file was left by an app that has quit or crashed, since
 * this one holds the single-instance lock. */
export async function clearStaleLocks(): Promise<void> {
  const slugs = await fs.readdir(projectsDir()).catch(() => [] as string[])
  await Promise.all(slugs.map((slug) => fs.rm(join(projectsDir(), slug, OWNER_LOCK), { force: true })))
}
