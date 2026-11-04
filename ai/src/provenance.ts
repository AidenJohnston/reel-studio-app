// versions/vN/ai-run.json: what the AI run that made version N ran on and used, one entry per answered model call.
import * as path from 'node:path';
import { CallProvenance, NOT_REPORTED, Reported } from './types';
import { versionDir, writeFileAtomic } from './project';

const AI_RUN_FILE = 'ai-run.json';

interface AiRunRecord {
  calls: CallProvenance[];
  /** a count is summed only when every call reported it: a partial sum would read as the whole cost */
  usage: CallProvenance['usage'];
}

function total(calls: CallProvenance[], key: keyof CallProvenance['usage']): Reported<number> {
  let sum = 0;
  for (const c of calls) {
    const v = c.usage[key];
    if (v === NOT_REPORTED) return NOT_REPORTED;
    sum += v;
  }
  return sum;
}

/** Writes the record next to the version's snapshot. Nothing when no model call was answered (the fast path,
 * the no-AI edit). A failed write only loses the measurement: it never fails or rolls back the edit. */
export async function writeAiRun(projectDir: string, version: number, calls: CallProvenance[]): Promise<void> {
  if (!calls.length) return;
  const record: AiRunRecord = {
    calls,
    usage: { input: total(calls, 'input'), output: total(calls, 'output'), cacheRead: total(calls, 'cacheRead'), cacheWrite: total(calls, 'cacheWrite') },
  };
  await writeFileAtomic(path.join(versionDir(projectDir, version), AI_RUN_FILE), JSON.stringify(record, null, 2) + '\n').catch(() => undefined);
}
