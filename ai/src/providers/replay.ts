// Record/replay of model responses, so CI and macOS tests can drive the real agent loop with no
// network or login. A fixture = the ordered list of model replies of one recorded session.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { AIError, CompletionRequest, CompletionResponse, ModelProvider } from '../types';
import { writeFileAtomic } from '../project';

export interface Fixture {
  version: 1;
  recordedWith: { provider: string; model?: string };
  task: string;
  createdAt: string;
  steps: { response: { text: string; toolCalls: { id: string; name: string; args: Record<string, unknown> }[]; repaired?: string; malformed?: boolean }; lastMessage?: string; /** how long the model took to answer */ ms?: number }[];
}

/** An argument a tool minted during the session (resolve_asset's candidateId and assetId are random UUIDs).
 * The fixture stores where it came from, `{ "$result": "<callId>", "path": "candidates.0.id" }`, and the
 * replay reads it from that call's result in this run. */
export interface ResultRef { $result: string; path: string }
const MINTED = /^(asset_)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const isRef = (v: unknown): v is ResultRef => !!v && typeof v === 'object' && !Array.isArray(v)
  && Object.keys(v).sort().join() === '$result,path' && typeof (v as any).$result === 'string' && typeof (v as any).path === 'string';

function toolResults(messages: CompletionRequest['messages']) {
  return messages.flatMap((m) => (m.role === 'tool' ? m.results : []));
}
function parsed(content: string): unknown {
  try { return JSON.parse(content); } catch { return undefined; }
}
function findPath(v: unknown, want: string, at: string[] = []): string[] | null {
  if (v === want) return at;
  if (!v || typeof v !== 'object') return null;
  for (const [k, child] of Object.entries(v)) {
    const hit = findPath(child, want, [...at, k]);
    if (hit) return hit;
  }
  return null;
}
/** Recording: a minted string found in an earlier result becomes a ResultRef (newest result first). */
export function refsForMinted(args: unknown, messages: CompletionRequest['messages']): unknown {
  if (typeof args === 'string' && MINTED.test(args)) {
    for (const r of toolResults(messages).reverse()) {
      const at = findPath(parsed(r.content), args);
      if (at) return { $result: r.callId, path: at.join('.') } satisfies ResultRef;
    }
    return args;
  }
  if (Array.isArray(args)) return args.map((a) => refsForMinted(a, messages));
  if (args && typeof args === 'object') return Object.fromEntries(Object.entries(args).map(([k, v]) => [k, refsForMinted(v, messages)]));
  return args;
}
/** Replay: each ResultRef becomes the value at its path in this run's result of that call. */
export function fillRefs(args: unknown, messages: CompletionRequest['messages']): unknown {
  if (isRef(args)) {
    const result = toolResults(messages).find((r) => r.callId === args.$result);
    if (!result) throw new AIError('replay_ref', 'The recorded session refers to a tool result this run does not have.', { detail: `no result for ${args.$result}` });
    let v: unknown = parsed(result.content);
    for (const key of args.path.split('.')) v = v && typeof v === 'object' ? (v as Record<string, unknown>)[key] : undefined;
    if (typeof v !== 'string') {
      throw new AIError('replay_ref', 'The recorded session refers to a tool result this run does not have.', { detail: `${args.$result} has no string at ${args.path}: ${result.content.slice(0, 300)}` });
    }
    return v;
  }
  if (Array.isArray(args)) return args.map((a) => fillRefs(a, messages));
  if (args && typeof args === 'object') return Object.fromEntries(Object.entries(args).map(([k, v]) => [k, fillRefs(v, messages)]));
  return args;
}

export class RecordingProvider implements ModelProvider {
  readonly id: ModelProvider['id'];
  readonly supportsImages: boolean;
  readonly model?: string;
  private fixture: Fixture;
  constructor(private readonly inner: ModelProvider, private readonly file: string, task: string) {
    this.id = inner.id; this.supportsImages = inner.supportsImages; this.model = inner.model;
    this.fixture = { version: 1, recordedWith: { provider: inner.id, model: inner.model }, task, createdAt: new Date().toISOString(), steps: [] };
  }
  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const t0 = Date.now();
    const res = await this.inner.complete(req);
    const last = req.messages.at(-1);
    this.fixture.steps.push({
      response: { text: res.text, toolCalls: res.toolCalls.map(({ id, name, args }) => ({ id, name, args: refsForMinted(args, req.messages) as Record<string, unknown> })),
        ...(res.repaired ? { repaired: res.repaired } : {}), ...(res.malformed ? { malformed: true } : {}) },
      ms: Date.now() - t0,
      lastMessage: last ? (last.role === 'tool' ? last.results.map((r) => r.name).join(',') : last.role) : undefined,
    });
    await writeFileAtomic(this.file, JSON.stringify(this.fixture, null, 2) + '\n');
    return res;
  }
}

export class ReplayProvider implements ModelProvider {
  readonly id = 'replay' as const;
  readonly supportsImages: boolean;
  readonly model?: string;
  private i = 0;
  private fixture: Fixture;
  constructor(fixtureOrFile: Fixture | string, opts: { supportsImages?: boolean } = {}) {
    this.fixture = typeof fixtureOrFile === 'string' ? JSON.parse(fs.readFileSync(fixtureOrFile, 'utf8')) : fixtureOrFile;
    this.model = this.fixture.recordedWith?.model;
    this.supportsImages = opts.supportsImages ?? true;
  }
  get remaining(): number { return this.fixture.steps.length - this.i; }
  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const step = this.fixture.steps[this.i++];
    if (!step) throw new AIError('replay_exhausted', 'The recorded session has no more replies.', { detail: `step ${this.i}` });
    return { text: step.response.text, toolCalls: step.response.toolCalls.map((c) => ({ ...c, args: fillRefs(c.args, req.messages) as Record<string, unknown> })) };
  }
}

export function fixturePath(dir: string, name: string): string {
  return path.join(dir, `${name.replace(/[^a-z0-9-]+/gi, '-')}.json`);
}
