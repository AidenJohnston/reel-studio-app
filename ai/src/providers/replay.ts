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
      response: { text: res.text, toolCalls: res.toolCalls.map(({ id, name, args }) => ({ id, name, args })),
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
  async complete(_req: CompletionRequest): Promise<CompletionResponse> {
    const step = this.fixture.steps[this.i++];
    if (!step) throw new AIError('replay_exhausted', 'The recorded session has no more replies.', { detail: `step ${this.i}` });
    return { text: step.response.text, toolCalls: step.response.toolCalls.map((c) => ({ ...c, args: structuredClone(c.args) })) };
  }
}

export function fixturePath(dir: string, name: string): string {
  return path.join(dir, `${name.replace(/[^a-z0-9-]+/gi, '-')}.json`);
}
