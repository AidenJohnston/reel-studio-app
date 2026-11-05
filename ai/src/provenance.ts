// versions/vN/ai-run.json: what the AI run that made version N ran on and used, one entry per answered model call.
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
