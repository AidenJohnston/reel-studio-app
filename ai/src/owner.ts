// One writer per project, shared with Reel Studio (the app) and the engine (engine/reelengine/owner.py).
// work/.owner.lock names the writer. An app job writes it and passes its token to the edit (`owner`), which
// goes ahead only while the lock holds that token. An edit run without one (the dev CLI) claims the lock
// itself for the edit, created exclusively, and passes its own token to the engine commands it runs, so it
// never starts while the app or a command run by hand has the project, and neither starts while it does.
// app/src/main/owner.ts has the app's side.
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

/** The dev CLI's claim on the project for one edit. */
export async function claimProject(projectDir: string): Promise<{ token: string; release(): Promise<void> }> {
  const lock = path.join(projectDir, OWNER_LOCK);
  const token = randomUUID();
  await fsp.mkdir(path.dirname(lock), { recursive: true });
  let fh: fsp.FileHandle;
  try { fh = await fsp.open(lock, 'wx'); } catch (e: any) {
    if (e?.code === 'EEXIST') throw projectOpen(lock);
    throw e;
  }
  try {
    await fh.writeFile(JSON.stringify({ app: 'reelstudio-ai', pid: process.pid, token }));
    await fh.sync();
  } finally {
    await fh.close();
  }
  return {
    token,
    async release() {
      const held = await fsp.readFile(lock, 'utf8').then((t) => JSON.parse(t)?.token, () => null);
      if (held === token) await fsp.rm(lock, { force: true });
    },
  };
}
