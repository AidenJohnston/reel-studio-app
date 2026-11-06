import { describe, it, expect } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { createAI, ModelProvider } from '../src';
import { NICHE_FILE, readNiche, readNicheTurn } from '../src/niche';
import { nicheFileData } from '../../app/src/shared/niche';
import { FakeHost, ScriptedModel, call, makeProject, tmpDir } from './helpers';

const NICHE = { who: 'Nurses on night shifts', promise: 'Ten minute meals that survive a 3am break', angles: ['A meal I made at work', 'The snack mistake', 'What I pack on Sunday'], avoid: ['hack', 'clean eating'] };
const ai = (root: string, model: ModelProvider) => createAI({ host: new FakeHost(root), settingsDir: tmpDir('settings '), providerOverride: model, finalRender: false });

describe('readNicheTurn', () => {
  // fails if the editor can keep asking, or a niche the page can't fill is taken as one
  it('takes a question only while questions are left, and a niche only with who, what they get and 3 angles', () => {
    expect(readNicheTurn({ question: 'Who do you picture watching?' }, 1)).toEqual({ kind: 'question', text: 'Who do you picture watching?' });
    expect(readNicheTurn({ question: 'And?' }, 2)).toBeNull();
    expect(readNicheTurn({ say: 'Aimed at nurses.', ...NICHE }, 2)).toEqual({ kind: 'niche', say: 'Aimed at nurses.', ...NICHE });
    expect(readNicheTurn({ ...NICHE, angles: ['one', 'two'] }, 0)).toBeNull();
    expect(readNicheTurn({ ...NICHE, who: ' ' }, 0)).toBeNull();
    const long = readNicheTurn({ ...NICHE, angles: ['1', '2', '3', '4', '5', '6'], avoid: Array.from({ length: 10 }, (_, i) => `w${i}`) }, 0);
    expect(long).toMatchObject({ angles: ['1', '2', '3', '4', '5'], avoid: ['w0', 'w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7'] });
  });
});

describe('the saved niche', () => {
  // fails if the niche the app saves never reaches the editor, or a removed one still does
  it('reaches the editor on every note and in the planning chat, and is gone once removed', async () => {
    const { root, dir } = await makeProject();
    const file = path.join(root, NICHE_FILE);
    // written the way the app writes it (app shared/niche.ts), so the two sides agree on the file
    await fsp.writeFile(file, JSON.stringify(nicheFileData({ ...NICHE, savedAt: '2026-11-06T00:00:00.000Z', from: 'chat' })));
    expect(await readNiche(root)).toEqual(NICHE);

    const note = new ScriptedModel([{ toolCalls: [call('finish', { summary_for_user: 'Done.' })] }]);
    await ai(root, note).applyNote(dir, 'tighten it', () => undefined);
    const system = note.requests[0].system;
    expect(system).toContain('Their reels are for: Nurses on night shifts');
    expect(system).toContain('What viewers get from them: Ten minute meals that survive a 3am break');
    expect(system).toContain('- The snack mistake');
    expect(system).toContain('"hack", "clean eating"');

    const plan = new ScriptedModel([{ text: '{"question":"Who is it for?"}' }]);
    await ai(root, plan).planTurn({ turns: [{ from: 'you', text: 'lunches' }], asked: 0, plan: null }, () => undefined);
    expect(plan.requests[0].system).toContain('Their reels are for: Nurses on night shifts');

    await fsp.rm(file);
    const after = new ScriptedModel([{ toolCalls: [call('finish', { summary_for_user: 'Done.' })] }]);
    await ai(root, after).applyNote(dir, 'tighten it', () => undefined);
    expect(after.requests[0].system).not.toContain("creator's niche");
    expect(after.requests[0].system).not.toContain('{{');
  });

  // fails if a hand-broken file stops every edit instead of being read as no niche
  it('reads a broken file as no niche', async () => {
    const root = tmpDir('niche ');
    await fsp.writeFile(path.join(root, NICHE_FILE), '{"niche": {"who": "nurses"');
    expect(await readNiche(root)).toBeNull();
  });
});

describe('nicheTurn', () => {
  // fails if the app's own opening question is sent as the editor's turn, or the chat asks past its two questions
  it('starts from the creator, and asks again for the niche once the questions are spent', async () => {
    const model = new ScriptedModel([{ text: '{"question":"Anything else?"}' }, { text: JSON.stringify({ say: 'Here it is.', ...NICHE }) }]);
    const r = await ai(tmpDir('niche '), model).nicheTurn({
      turns: [
        { from: 'editor', text: 'What do you make reels about?', kind: 'question' },
        { from: 'you', text: 'quick meals' },
        { from: 'editor', text: 'Who do you picture watching?', kind: 'question' },
        { from: 'you', text: 'nurses' },
        { from: 'editor', text: 'What do they get from you?', kind: 'question' },
        { from: 'you', text: 'food that survives a night shift' },
      ],
      asked: 2,
      niche: null,
    }, () => undefined);
    expect(r).toEqual({ kind: 'niche', say: 'Here it is.', ...NICHE });
    const first = model.requests[0];
    expect(first.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user']);
    expect(first.system).toMatch(/propose the niche now/);
    expect((model.requests[1].messages.at(-1) as any).content[0].text).toMatch(/No questions are left/);
  });
});
