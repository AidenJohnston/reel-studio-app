// versions/vN/ai-run.json: what the AI run that made version N ran on and used, one entry per answered model call.
// A run that ends on a version it did not make writes work/ai-runs/<id>.json instead (writeKeptAiRun).
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { CallProvenance, NOT_REPORTED, ProviderId, Reported } from './types';
import { versionDir, writeFileAtomic } from './project';

const AI_RUN_FILE = 'ai-run.json';

/** A token count as the provider's answer carried it, or NOT_REPORTED: a missing count never reads as 0. */
export function reportedTokens(v: unknown): Reported<number> {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : NOT_REPORTED;
}

/** OpenAI's usage (Codex, Chat Completions) counts cached reads, and cache writes when it reports them, inside the
 * input count; the record counts input as Anthropic does, without them. Input whose cached part went unreported
 * stays whole. */
export function uncachedInput(total: Reported<number>, cacheRead: Reported<number>, cacheWrite: Reported<number>): Reported<number> {
  return total === NOT_REPORTED || cacheRead === NOT_REPORTED ? total
    : Math.max(0, total - cacheRead - (cacheWrite === NOT_REPORTED ? 0 : cacheWrite));
}

/** One call over an HTTP API (an Anthropic key, the person's own server, the CLIProxyAPI hub). The answer names the
 * model that replied; no CLI ran, so there is no CLI version. */
export function apiProvenance(o: { provider: ProviderId; requestedModel: string; reportedModel: unknown; effort?: string; usage: CallProvenance['usage'] }): CallProvenance {
  return {
    provider: o.provider, requestedModel: o.requestedModel,
    reportedModels: typeof o.reportedModel === 'string' && o.reportedModel ? [o.reportedModel] : NOT_REPORTED,
    cliVersion: NOT_REPORTED, effort: o.effort ?? null, usage: o.usage,
  };
}

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

const record = (calls: CallProvenance[]): AiRunRecord => ({
  calls,
  usage: { input: total(calls, 'input'), output: total(calls, 'output'), cacheRead: total(calls, 'cacheRead'), cacheWrite: total(calls, 'cacheWrite') },
});

/** Writes the record into the folder of the version this run made, as part of making it. Only for a new version:
 * a run that got a saved version back calls writeKeptAiRun. Nothing when no model call was answered (the fast
 * path, the no-AI edit). A failed write only loses the measurement: it never fails or rolls back the edit. */
export async function writeAiRun(projectDir: string, version: number, calls: CallProvenance[]): Promise<void> {
  if (!calls.length) return;
  await writeFileAtomic(path.join(versionDir(projectDir, version), AI_RUN_FILE), JSON.stringify(record(calls), null, 2) + '\n').catch(() => undefined);
}

/** The record of a run that ended on a version it did not make (a note that changed only the post caption, a first
 * edit run again that got its saved version back): work/ai-runs/<id>.json, naming that version. A saved version's
 * folder is never rewritten (docs/versions.md), so its ai-run.json stays the record of the run that made it, and
 * this run's calls are kept beside the project instead of replacing or joining it. */
export async function writeKeptAiRun(projectDir: string, id: string, version: number, calls: CallProvenance[]): Promise<void> {
  if (!calls.length) return;
  const file = path.join(projectDir, 'work', 'ai-runs', `${id}.json`);
  await fsp.mkdir(path.dirname(file), { recursive: true })
    .then(() => writeFileAtomic(file, JSON.stringify({ version, ...record(calls) }, null, 2) + '\n'))
    .catch(() => undefined);
}
