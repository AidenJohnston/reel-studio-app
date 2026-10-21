// One writer per project at a time. <project>/work/.owner.lock holds the owner's token: the app's job
// lane (or the dev CLI) takes it, and everything working for that owner (the editor, engine commands)
// joins with the token instead of taking it again. engine/reelengine/owner.py has the same rules.
//
// Liveness is a heartbeat: the owner touches the file every OWNER_BEAT_MS, and a lock untouched for
// OWNER_STALE_MS has no live owner. Node has no OS file lock, a PID can be reused, and checking one
// with signal 0 sends Ctrl-C on Windows, so the file's own timestamp is the one portable signal (the
// approach proper-lockfile takes).
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AIError } from './types';

export const OWNER_LOCK = path.join('work', '.owner.lock');
export const OWNER_BEAT_MS = 5_000;
export const OWNER_STALE_MS = 30_000;

export interface ProjectOwner { token: string; release(): Promise<void> }

const busy = () => new AIError('busy', 'This video is being edited somewhere else right now. Try again when that finishes.');

export async function ownerToken(projectDir: string): Promise<string | null> {
  return fsp.readFile(path.join(projectDir, OWNER_LOCK), 'utf8').then((t) => t.trim(), () => null);
}

/** Takes the project, or throws `busy` while another owner is alive. A lock nobody has touched for
 * OWNER_STALE_MS belongs to a process that is gone, and is taken over. */
export async function ownProject(projectDir: string): Promise<ProjectOwner> {
  const lock = path.join(projectDir, OWNER_LOCK);
  await fsp.mkdir(path.dirname(lock), { recursive: true });
  const token = randomUUID();
  for (let attempt = 0; ; attempt++) {
    try {
      await fsp.writeFile(lock, token, { flag: 'wx' });
      break;
    } catch (e: any) {
      if (e?.code !== 'EEXIST') throw e;
      const touched = (await fsp.stat(lock).catch(() => null))?.mtimeMs;
      if (attempt > 0 || (touched !== undefined && Date.now() - touched < OWNER_STALE_MS)) throw busy();
      await fsp.rm(lock, { force: true });
    }
  }
  const beat = setInterval(() => {
    const now = new Date();
    void fsp.utimes(lock, now, now).catch(() => undefined);   // a lost lock is caught where it matters: requireOwner
  }, OWNER_BEAT_MS);
  beat.unref?.();
  return {
    token,
    async release() {
      clearInterval(beat);
      if (await ownerToken(projectDir) === token) await fsp.rm(lock, { force: true, recursive: true, maxRetries: 5 });
    },
  };
}

/** Throws `busy` unless `token` still owns the project. */
export async function requireOwner(projectDir: string, token: string): Promise<void> {
  if (await ownerToken(projectDir) !== token) throw busy();
}
