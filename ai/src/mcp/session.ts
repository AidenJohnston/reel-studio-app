import { randomUUID } from 'node:crypto';
import { AIError, ModelProvider } from '../types';
import { Harness, HarnessRun, loopHarness } from '../harness';
import { RunAgentResult } from '../agent';
import { newToolState } from '../tools';

/** One readiness decision per app session and harness selection. A failed probe never sees the
 * note or its editing tools, so the text provider can safely start the note from scratch. */
export class SessionHarness implements Harness {
  readonly id;
  readonly supportsImages;
  private readiness?: Promise<string | null>;
  /** `onFallback`: the probe failed and this session's notes run on the text-protocol loop instead; called once per
   * failed readiness decision with its reason ("claude_cli: MCP refused"), so Settings can say so afterwards. */
  constructor(private readonly native: Harness, private readonly provider: () => ModelProvider, private readonly onFallback?: (reason: string) => void) {
    this.id = native.id;
    this.supportsImages = native.supportsImages;
  }

  async run(o: HarnessRun): Promise<RunAgentResult> {
    if (o.signal?.aborted) throw new AIError('cancelled', 'Stopped.');
    this.readiness ??= this.probe(o).catch((e: unknown) => {
      // A cancelled first note does not disable MCP for the next note.
      if (o.signal?.aborted) { this.readiness = undefined; throw e; }
      if (!(e instanceof AIError)) return 'probe_failed';
      if (/unknown option|unrecognized|unexpected argument/i.test(e.message)) return `${e.code}: unsupported CLI flags`;
      if (/MCP.*refus/i.test(e.message)) return `${e.code}: MCP refused`;
      return `${e.code}: ${e.userMessage}`;
    }).then((reason) => {
      if (reason) this.onFallback?.(reason);
      return reason;
    });
    const reason = await this.readiness;
    if (!reason) return this.native.run(o);
    o.onEvent({ type: 'status', phase: 'edit', message: `${this.id} self-test failed (${reason}). Using the text-protocol provider for this session.` });
    // A cached readiness decision must not share a CLI conversation between concurrent reels.
    return loopHarness(this.provider()).run(o);
  }

  private async probe(o: HarnessRun): Promise<string | null> {
    const nonce = randomUUID();
    const ctx = { ...o.ctx, state: newToolState(), emit: () => undefined };
    let reached = false;
    const signal = AbortSignal.any([...(o.signal ? [o.signal] : []), AbortSignal.timeout(60_000)]);
    await this.native.run({
      system: 'Check the MCP connection. Call harness_probe with the exact nonce in the task. Do nothing else.',
      task: `Call harness_probe with nonce ${nonce}.`, ctx, tools: ['harness_probe'], maxSteps: 1,
      tokenBudget: 2000, maxMisses: 1, signal, onEvent: () => undefined,
      customTools: [{
        schema: { name: 'harness_probe', description: 'Return the supplied nonce to verify a tool round-trip.', parameters: { type: 'object', properties: { nonce: { type: 'string' } }, required: ['nonce'], additionalProperties: false } },
        execute: async (args) => {
          if (!args || typeof args !== 'object' || !('nonce' in args) || args.nonce !== nonce) return { content: 'Wrong nonce.', isError: true };
          reached = true;
          ctx.state.finished = nonce;
          return { content: nonce, isError: false };
        },
      }],
    });
    return reached ? null : 'no_roundtrip';
  }
}
