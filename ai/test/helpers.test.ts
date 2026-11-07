// Helpers (helpers.ts): a note can hand searches to a second AI. They run at the same time, report back to the
// editor, are recorded with the note's model calls, and can never change the edit.
import { describe, expect, it } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { applyNote, EditorDeps } from '../src/editor';
import { Prompts } from '../src/prompts';
import { StyleStore } from '../src/style';
import { loadProject } from '../src/project';
import type { CallProvenance, CompletionRequest, ModelProvider } from '../src/types';
import { FakeHost, ScriptedModel, call, firstVersion, makeProject } from './helpers';

const finish = (summary: string) => ({ toolCalls: [call('finish', { summary_for_user: summary })] });
const provenance = (model: string): CallProvenance => ({
  provider: 'codex-cli', requestedModel: null, reportedModels: [model], cliVersion: 'test', effort: null,
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
});

async function setup() {
  const { root, dir } = await makeProject();
  const host = new FakeHost(root);
  await firstVersion(dir, host);
  const deps: EditorDeps = { host, prompts: new Prompts(), style: new StyleStore(() => root), fastNotes: false };
  return { dir, deps };
}

const toolNames = (req: CompletionRequest) => req.tools.map((t) => t.name);
const lastToolText = (req: CompletionRequest): string => {
  const m = [...req.messages].reverse().find((x) => x.role === 'tool');
  return m && m.role === 'tool' ? m.results.map((r) => r.content).join('\n') : '';
};

describe('helpers that look things up for a note', () => {
  it('look_up is offered only when a helper exists', async () => {
    const { dir, deps } = await setup();
    const editor = new ScriptedModel([{ toolCalls: [call('set_gap_cap', { seconds: 0.5 })] }, finish('Done.')]);
    await applyNote(deps, editor, dir, 'tighter pauses', () => undefined);
    expect(toolNames(editor.requests[0])).not.toContain('look_up');

    const again = new ScriptedModel([{ toolCalls: [call('set_gap_cap', { seconds: 0.6 })] }, finish('Done.')]);
    await applyNote({ ...deps, helper: { label: 'Helper', make: async () => new ScriptedModel([]) } }, again, dir, 'a bit tighter', () => undefined);
    expect(toolNames(again.requests[0])).toContain('look_up');
  });

  it('two helpers run at the same time, the editor gets both answers, and their calls are recorded with the note', async () => {
    const { dir, deps } = await setup();
    // each helper's first turn waits until the other has started: this only finishes if they run together
    let started = 0;
    let both!: () => void;
    const together = new Promise<void>((r) => { both = r; });
    const helperModel = (thing: string): ModelProvider => {
      const steps = new ScriptedModel([
        async () => {
          if (++started === 2) both();
          await together;
          return { toolCalls: [call('get_transcript', {})], provenance: provenance(`helper-${thing}`) };
        },
        { ...finish(`For ${thing}: nothing better than the Library photo.`), provenance: provenance(`helper-${thing}`) },
      ]);
      return { id: 'fake', supportsImages: true, complete: (req) => steps.complete(req) };
    };
    const things = ['the bakery', 'a croissant'];
    let made = 0;
    deps.helper = { label: 'Your Codex app', make: async () => helperModel(things[made++]) };
    const editor = new ScriptedModel([
      { toolCalls: [call('look_up', { things })], provenance: provenance('editor') },
      { toolCalls: [call('set_gap_cap', { seconds: 0.5 })], provenance: provenance('editor') },
      { ...finish('Tighter pauses.'), provenance: provenance('editor') },
    ]);
    const r = await applyNote(deps, editor, dir, 'tighter pauses and find pictures', () => undefined);
    expect(r.version).toBe(2);
    const answer = lastToolText(editor.requests[1]);
    expect(answer).toContain('For the bakery: nothing better than the Library photo.');
    expect(answer).toContain('For a croissant: nothing better than the Library photo.');
    const run = JSON.parse(await fsp.readFile(path.join(dir, 'versions', 'v2', 'ai-run.json'), 'utf8'));
    const models = JSON.stringify(run);
    expect(models).toContain('helper-the bakery');
    expect(models).toContain('helper-a croissant');
  });

  it('a helper that tries to change the edit is refused, and the note saves only the editor\'s change', async () => {
    const { dir, deps } = await setup();
    const sneaky = new ScriptedModel([{ toolCalls: [call('set_caption_style', { size: 200 })] }, finish('Done looking.')]);
    deps.helper = { label: 'Helper', make: async () => sneaky };
    const editor = new ScriptedModel([
      { toolCalls: [call('look_up', { things: ['a sunset'] })] },
      { toolCalls: [call('set_gap_cap', { seconds: 0.5 })] },
      finish('Tighter pauses.'),
    ]);
    const before = (await loadProject(dir)).captions.style.size;
    await applyNote(deps, editor, dir, 'tighter pauses', () => undefined);
    expect(lastToolText(sneaky.requests[1])).toMatch(/not available in this task/);
    const p = await loadProject(dir);
    expect(p.captions.style.size).toBe(before);
    expect(p.cut.gapCap).toBe(0.5);
  });
});
