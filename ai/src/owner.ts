// Reel Studio (the app) is the only writer of a project while it has it open: it runs one job per
// project and passes the job's token to the edit (`owner`), which never decides ownership itself.
// The app also writes work/.owner.lock; an edit run without a token (the dev CLI) refuses while that
// file exists and never takes the project over. app/src/main/owner.ts has the app's side.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { AIError } from './types';

export const OWNER_LOCK = path.join('work', '.owner.lock');

/** For an edit run without Reel Studio's token: throws while the app has the project open. */
export function refuseIfOpen(projectDir: string): void {
  const lock = path.join(projectDir, OWNER_LOCK);
  if (fs.existsSync(lock)) {
    throw new AIError('project_open', `Reel Studio may be using this project. Close it, or delete ${lock} if it isn't running.`);
  }
}
