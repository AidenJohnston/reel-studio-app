// Changed moments first (src/moments.ts) through a whole note: what the engine's `moments` command is
// asked to do around the AI's replies, what reaches the app, and that no two renders of one project
// ever overlap.
import { describe, it, expect } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { createAI, AgentEvent, EngineProgress } from '../src';
import { FakeHost, ScriptedModel, makeProject, call, tmpDir } from './helpers';

/** A FakeHost whose `moments` command behaves like the engine's: --mark records the base; a run reports a
 * still and the window as they are made and ends with the draft. The first `hang` runs stop only when
 * cancelled, like a draft still encoding when the next edit lands. Every command is logged as it starts
 * and ends, so overlapping renders show. */
class MomentsHost extends FakeHost {
  log: string[] = [];
  marks: any[] = [];
  runs: { signal?: AbortSignal; captionSize: number; sizeWhenStopped?: number }[] = [];
  hang = 0;

  override async runEngine(command: string, args: string[], onProgress?: (p: EngineProgress) => void, signal?: AbortSignal): Promise<any> {
    const dir = args[args.indexOf('--project') + 1];
    const p = JSON.parse(await fsp.readFile(path.join(dir, 'project.json'), 'utf8'));
    if (command !== 'moments') {
      const name = command === 'render' ? (args.includes('--draft') ? 'draft' : 'final') : command;
      this.log.push(`start ${name}`);
      try { return await super.runEngine(command, args, onProgress); } finally { this.log.push(`end ${name}`); }
    }
    if (args.includes('--mark')) { this.marks.push(p); return { base: path.join(dir, 'work', 'moments', 'base.json') }; }
    const n = this.runs.length;
    this.runs.push({ signal, captionSize: p.captions.style.size });
    this.log.push(`start moments ${n}`);
    const preview = path.join(dir, 'versions', 'preview');
    if (n < this.hang) {
      return new Promise((_, reject) => abortable(signal!, async () => {
        this.runs[n].sizeWhenStopped = JSON.parse(await fsp.readFile(path.join(dir, 'project.json'), 'utf8')).captions.style.size;
        // a line the engine wrote just before it was killed must not reach the app
        onProgress?.({ stage: 'moments', pct: 30, message: 'x', ready: { kind: 'still', t: 9.9, file: path.join(preview, 'stale.png') } });
        const exited = new Promise<void>((r) => setTimeout(() => { this.log.push(`end moments ${n}`); r(); }, 20));
        reject({ code: 'CANCELLED', userMessage: 'Stopped.', exited });
      }));
    }
    onProgress?.({ stage: 'moments', pct: 30, message: "Here's your change", ready: { kind: 'still', t: 1.2, file: path.join(preview, 'moments', 'still_000036.png') } });
    onProgress?.({ stage: 'moments', pct: 60, message: "Here's your change", ready: { kind: 'window', from: 0.2, to: 2.2, file: path.join(preview, 'window_0.2-2.2.mp4') } });
    await fsp.mkdir(preview, { recursive: true });
    await fsp.writeFile(path.join(preview, 'draft.mp4'), 'moments draft');
    this.log.push(`end moments ${n}`);
    return { intervals: [[0, 12.3]], stills: [], window: null,
      draft: { version: 1, preview: true, draft: true, file: path.join(preview, 'draft.mp4'), duration: 12.3, verify: { ok: true } } };
  }
}

/** Runs `fn` once `signal` aborts, at once if it already has (as the app's engine runner checks it). */
function abortable(signal: AbortSignal, fn: () => void): void {
  if (signal.aborted) fn();
  else signal.addEventListener('abort', fn, { once: true });
}

async function setup(hang = 0) {
  const { root, dir } = await makeProject();
  const host = new MomentsHost(root);
  host.hang = hang;
  return { dir, host, settingsDir: tmpDir('settings ') };
}

async function until(ok: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 10));
}

/** No two renders of the project at once: every start comes after the previous command's end. */
function serial(log: string[]): boolean {
  let open = 0;
  for (const l of log) {
    if (l.startsWith('start ')) { if (open) return false; open++; } else open--;
  }
  return open === 0;
}

describe('changed moments first', () => {
  it('shows the stills and window of a reply at once, and render_draft takes the draft that run made', async () => {
    const { dir, host, settingsDir } = await setup();
    const model = new ScriptedModel([
      { toolCalls: [call('set_caption_style', { size: 90 })] },
      { toolCalls: [call('render_draft')] },
      { toolCalls: [call('finish', { summary_for_user: 'Smaller captions.' })] },
    ]);
    const events: AgentEvent[] = [];
    const ai = createAI({ host, settingsDir, providerOverride: model, moments: true });
    await ai.applyNote(dir, 'do what we said earlier', (e) => events.push(e));

    expect(host.marks.map((p) => p.captions.style.size)).toEqual([105]);   // the base is the project before the edit
    expect(host.runs.map((r) => r.captionSize)).toEqual([90]);
    expect(host.log.filter((l) => l.startsWith('start'))).toEqual(['start moments 0', 'start final']);   // no second draft
    const shown = events.filter((e) => e.type === 'moment' || e.type === 'render');
    expect(shown).toEqual([
      { type: 'moment', kind: 'still', t: 1.2, file: expect.stringMatching(/still_000036\.png$/) },
      { type: 'moment', kind: 'window', from: 0.2, to: 2.2, file: expect.stringMatching(/window_0\.2-2\.2\.mp4$/) },
      { type: 'render', version: 1, draft: true, file: expect.stringMatching(/draft\.mp4$/) },
      expect.objectContaining({ type: 'render', draft: false }),
    ]);
    // the model was shown that preview as its own render_draft result
    const draftResult = (model.requests[2].messages.at(-1) as any).results[0].content;
    expect(JSON.parse(draftResult)).toMatchObject({ ok: true, duration: 12.3, verify: { ok: true } });
  });

  it('an edit that lands while a run is going stops it, and the next run starts only once it is gone', async () => {
    const { dir, host, settingsDir } = await setup(1);
    const model = new ScriptedModel([
      { toolCalls: [call('set_caption_style', { size: 90 })] },
      { toolCalls: [call('set_caption_style', { size: 120 })] },
      // the model's next turn takes seconds: long enough for the new run to finish
      async () => { await until(() => host.log.includes('end moments 1')); return { toolCalls: [call('finish', { summary_for_user: 'Bigger captions.' })] }; },
    ]);
    const events: AgentEvent[] = [];
    await createAI({ host, settingsDir, providerOverride: model, moments: true }).applyNote(dir, 'do what we said earlier', (e) => events.push(e));

    expect(host.runs.map((r) => r.captionSize)).toEqual([90, 120]);
    expect(host.runs[0].signal?.aborted).toBe(true);
    expect(host.runs[0].sizeWhenStopped).toBe(90);        // stopped before the next save, not after the reply
    expect(serial(host.log)).toBe(true);
    expect(host.log.indexOf('end moments 0')).toBeLessThan(host.log.indexOf('start moments 1'));
    expect(events.some((e) => e.type === 'moment' && e.file.endsWith('stale.png'))).toBe(false);
  });

  it('a final render stops a run still going, and waits for it to end', async () => {
    const { dir, host, settingsDir } = await setup(1);
    const model = new ScriptedModel([
      { toolCalls: [call('set_caption_style', { size: 90 })] },
      { toolCalls: [call('finish', { summary_for_user: 'Smaller captions.' })] },
    ]);
    await createAI({ host, settingsDir, providerOverride: model, moments: true }).applyNote(dir, 'do what we said earlier', () => undefined);
    expect(host.runs[0].signal?.aborted).toBe(true);
    expect(host.log).toEqual(['start moments 0', 'end moments 0', 'start final', 'end final']);
  });

  it('a reply that only changes the music starts no run', async () => {
    const { dir, host, settingsDir } = await setup();
    const model = new ScriptedModel([
      { toolCalls: [call('choose_music', { track: null, startAt: null, level: 'quiet' })] },
      { toolCalls: [call('finish', { summary_for_user: 'Quieter music.' })] },
    ]);
    await createAI({ host, settingsDir, providerOverride: model, moments: true }).applyNote(dir, 'do what we said earlier', () => undefined);
    expect(host.runs).toEqual([]);
  });
});
