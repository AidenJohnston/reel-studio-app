// versions/vN/ai-run.json: what the AI runs that made version N ran on and used, one entry per answered model call.
import * as fsp from 'node:fs/promises';
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

/** The calls already recorded for a version; none when there is no record or it can't be read. */
async function recorded(file: string): Promise<CallProvenance[]> {
  try {
    const calls = JSON.parse(await fsp.readFile(file, 'utf8'))?.calls;
    return Array.isArray(calls) ? calls : [];
  } catch {
    return [];
  }
}

/** Writes the record next to the version's snapshot. Nothing when no model call was answered (the fast path,
 * the no-AI edit). A note that leaves the video as it was (only the post caption changed) keeps the current
 * version, so its calls are added to that version's record and the totals cover both runs. A failed write
 * only loses the measurement: it never fails or rolls back the edit. */
export async function writeAiRun(projectDir: string, version: number, runCalls: CallProvenance[]): Promise<void> {
  if (!runCalls.length) return;
  const file = path.join(versionDir(projectDir, version), AI_RUN_FILE);
  const calls = [...(await recorded(file)), ...runCalls];
  const record: AiRunRecord = {
    calls,
    usage: { input: total(calls, 'input'), output: total(calls, 'output'), cacheRead: total(calls, 'cacheRead'), cacheWrite: total(calls, 'cacheWrite') },
  };
  await writeFileAtomic(file, JSON.stringify(record, null, 2) + '\n').catch(() => undefined);
}
