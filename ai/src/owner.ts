// One writer per project, shared with Reel Studio (the app) and the engine (docs/ownership.md).
// work/.owner.lock names the writer. An app job claims it and passes its token to the edit (`owner`), which goes
// ahead only while the lock holds that token. An edit run without one (the dev CLI) claims the lock itself for the
// edit, recording the engines it starts, and passes its own token to them, so it never starts while the app or a
// command run by hand has the project, and neither starts while it does. app/src/main/owner.ts has the app's side.
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AIError } from './types';

export const OWNER_LOCK = path.join('work', '.owner.lock');

const projectOpen = (lock: string) =>
  new AIError('project_open', `Reel Studio may be using this project. Close it, or delete ${lock} if it isn't running.`);

/** For an edit run without Reel Studio's token: throws while the app has the project open. */
export function refuseIfOpen(projectDir: string): void {
  const lock = path.join(projectDir, OWNER_LOCK);
  if (fs.existsSync(lock)) throw projectOpen(lock);
}

/** Throws unless the project's lock holds `token`: a job that has let go, or a token that never held it, never
 * writes the project. */
export function assertOwner(projectDir: string, token: string): void {
  const lock = path.join(projectDir, OWNER_LOCK);
  let held: unknown;
  try { held = JSON.parse(fs.readFileSync(lock, 'utf8'))?.token; } catch { held = undefined; }
  if (held !== token) {
    throw new AIError('not_owner', 'Reel Studio no longer has this video open for this edit, so I stopped. Try again.', { detail: `the token does not match ${lock}` });
  }
}

/** `text` written to a file of its own, synced, at a fresh name beside `file`. */
async function staged(file: string, text: string): Promise<string> {
  const tmp = `${file}.${randomUUID()}.tmp`;
  const fh = await fsp.open(tmp, 'wx');
  try { await fh.writeFile(text); await fh.sync(); } finally { await fh.close(); }
  return tmp;
}

/** The dev CLI's claim on the project for one edit, made whole: its identity becomes the lock by a hard link that
 * fails if a lock exists (an exclusive create on a disk with no hard links). `addEngine` records an engine it
 * started, so the app waits for that engine before it takes over the project of a dev CLI that was killed. */
export async function claimProject(projectDir: string): Promise<{ token: string; addEngine(pid: number): Promise<void>; release(): Promise<void> }> {
  const lock = path.join(projectDir, OWNER_LOCK);
  const token = randomUUID();
  const identity = { app: 'reelstudio-ai', pid: process.pid, started: Math.round(Date.now() - process.uptime() * 1000), token, engines: [] as { pid: number; started: number }[] };
  await fsp.mkdir(path.dirname(lock), { recursive: true });
  const tmp = await staged(lock, JSON.stringify(identity));
  try {
    await fsp.link(tmp, lock);
  } catch (e: any) {
    if (e?.code === 'EEXIST') throw projectOpen(lock);
    // no hard links on this disk (each system names it differently); a real failure fails this create too
    try { await fsp.writeFile(lock, JSON.stringify(identity), { flag: 'wx' }); } catch (err: any) {
      if (err?.code === 'EEXIST') throw projectOpen(lock);
      throw err;
    }
  } finally {
    await fsp.rm(tmp, { force: true });
  }
  const ours = async () => (await fsp.readFile(lock, 'utf8').then((t) => JSON.parse(t)?.token, () => null)) === token;
  // one rewrite at a time, each with every engine so far, so a slow one never puts back a shorter list
  let writes: Promise<void> = Promise.resolve();
  return {
    token,
    addEngine(pid) {
      identity.engines.push({ pid, started: Date.now() });
      writes = writes.then(async () => {
        // replaced whole, so a reader sees the old identity or the new one; one that can't be replaced (Windows,
        // while another program reads it) leaves that engine to the app's scan for engines naming the project
        if (!(await ours())) return;
        const next = await staged(lock, JSON.stringify(identity));
        await fsp.rename(next, lock).catch(() => fsp.rm(next, { force: true }));
      }).catch(() => undefined);
      return writes;
    },
    async release() {
      await writes;
      if (await ours()) await fsp.rm(lock, { force: true });
    },
  };
}
