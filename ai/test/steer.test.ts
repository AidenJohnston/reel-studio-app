// Words added to a note while it runs (steer.ts): the model reads them with its next tool result, and the note
// cannot finish until it has.
import { describe, expect, it } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { createAI, type NoteSteer } from '../src';
import type { CompletionRequest } from '../src/types';
import { FakeHost, ScriptedModel, call, firstVersion, makeProject, tmpDir } from './helpers';

/** The app's side, as main/steer.ts behaves: words wait until taken; a seal refuses new ones. */
class Box implements NoteSteer {
  waiting: string[] = [];
  sealed = false;
  add(w: string): boolean {
    if (this.sealed) return false;
    this.waiting.push(w);
    return true;
  }
  take(): string[] {
    return this.waiting.splice(0);
  }
  seal(): boolean {
    if (this.waiting.length) return false;
    this.sealed = true;
    return true;
  }
  unseal(): void {
    this.sealed = false;
  }
}

async function setup() {
  const { root, dir } = await makeProject();
  const host = new FakeHost(root);
  await firstVersion(dir, host);
  return { dir, host, settingsDir: tmpDir('steer settings ') };
}

const lastToolText = (req: CompletionRequest): string => {
  const m = [...req.messages].reverse().find((x) => x.role === 'tool');
  return m && m.role === 'tool' ? m.results.map((r) => r.content).join('\n') : '';
};
const saved = async (dir: string) => JSON.parse(await fsp.readFile(path.join(dir, 'project.json'), 'utf8'));

describe('adding to a running note', () => {
  it('words added during a step reach the model with that step\'s result and are saved with the note', async () => {
    const { dir, host, settingsDir } = await setup();
    const box = new Box();
    const model = new ScriptedModel([
      () => {
        box.add('and make the captions bigger');
        return { toolCalls: [call('set_gap_cap', { seconds: 0.5 })] };
      },
      { toolCalls: [call('set_caption_style', { size: 130 })] },
      { toolCalls: [call('finish', { summary_for_user: 'Tighter pauses and bigger captions.' })] },
    ]);
    const r = await createAI({ host, settingsDir, providerOverride: model }).applyNote(dir, 'tighten the pauses', () => undefined, undefined, { steer: box });
    expect(lastToolText(model.requests[1])).toContain('"and make the captions bigger"');
    expect(r.version).toBe(2);
    const note = (await saved(dir)).notes.at(-1);
    expect(note.text).toBe('tighten the pauses\nand make the captions bigger');
    expect(box.sealed).toBe(true);
  });

  it('finish is refused while added words are unread, and accepted once the model has them', async () => {
    const { dir, host, settingsDir } = await setup();
    const box = new Box();
    const model = new ScriptedModel([
      { toolCalls: [call('set_gap_cap', { seconds: 0.5 })] },
      () => {
        // the person adds a line while the model writes its finish
        box.add('also bigger captions');
        return { toolCalls: [call('finish', { summary_for_user: 'Tighter pauses.' })] };
      },
      { toolCalls: [call('set_caption_style', { size: 130 })] },
      { toolCalls: [call('finish', { summary_for_user: 'Tighter pauses and bigger captions.' })] },
    ]);
    const r = await createAI({ host, settingsDir, providerOverride: model }).applyNote(dir, 'tighten the pauses', () => undefined, undefined, { steer: box });
    const refusal = lastToolText(model.requests[2]);
    expect(refusal).toContain('also bigger captions');
    expect(refusal).toMatch(/Not finished yet/);
    expect(model.requests).toHaveLength(4);
    const p = await saved(dir);
    expect(p.captions.style.size).toBe(130);
    expect(p.notes.at(-1).text).toBe('tighten the pauses\nalso bigger captions');
    expect(r.summary).toBe('Tighter pauses and bigger captions.');
    // sealed with the note: a later word is the next note's
    expect(box.add('one more thing')).toBe(false);
  });

  it('a direct change ("smaller captions") with words already added lets the model read them instead', async () => {
    const { dir, host, settingsDir } = await setup();
    const box = new Box();
    box.add('and cut the first pause');
    const model = new ScriptedModel([
      { toolCalls: [call('set_caption_style', { size: 80 }), call('set_gap_cap', { seconds: 0.4 })] },
      { toolCalls: [call('finish', { summary_for_user: 'Smaller captions, and the first pause is gone.' })] },
    ]);
    await createAI({ host, settingsDir, providerOverride: model }).applyNote(dir, 'smaller captions', () => undefined, undefined, { steer: box });
    // the added words came with the preloaded project, before the first model turn
    const task = model.requests[0].messages[0];
    expect(task.role === 'user' && task.content.map((c) => (c.type === 'text' ? c.text : '')).join('')).toContain('and cut the first pause');
    expect((await saved(dir)).notes.at(-1).text).toBe('smaller captions\nand cut the first pause');
  });

  it('a direct change with nothing added seals the box and runs without the model', async () => {
    const { dir, host, settingsDir } = await setup();
    const box = new Box();
    const model = new ScriptedModel([]);
    await createAI({ host, settingsDir, providerOverride: model }).applyNote(dir, 'smaller captions', () => undefined, undefined, { steer: box });
    expect(model.requests).toHaveLength(0);
    expect(box.add('too late')).toBe(false);
  });
});
