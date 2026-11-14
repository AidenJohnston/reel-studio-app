// What the AI is told about captions that follow the locked script (src/script-follow.ts): only the current
// script, the engine's mapping only while it was made from that script, and words as the captions draw them.
import { describe, expect, it } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { Project, Transcript, loadProject, saveProject } from '../src/project';
import { correctedWords, currentScript, mappingKey, scriptFollow, scriptSection } from '../src/script-follow';
import { makeProject, makeTranscript } from './helpers';

const LINE = 'We record with Nave every morning.';
const SCRIPT = 'We record with Neve every morning.';
const asData = (s: string) => s;

/** A project whose take says LINE, with `script` and the engine's mapping for SCRIPT (w3 drawn as "Neve"). */
async function setup(script: unknown) {
  const { dir, transcript } = await makeProject({ lines: [LINE] });
  const p = await loadProject(dir);
  if (script !== null) p.script = script;
  await saveProject(dir, p);
  const align = {
    version: 3, key: mappingKey(SCRIPT, transcript.words), script: SCRIPT,
    groups: [{ ids: ['w0'], words: ['We'] }, { ids: ['w3'], words: ['Neve'] }], spans: [['w0', 'w5']],
  };
  await fsp.writeFile(path.join(dir, 'work', 'script-align.json'), JSON.stringify(align));
  return { dir, t: transcript, p: await loadProject(dir) };
}

const section = async (dir: string, p: Project, t: Transcript) => {
  const f = await scriptFollow(dir, p, t);
  return f ? scriptSection(t, p, f, asData) : '';
};

describe('captions that follow the script, as the AI is told', () => {
  it('computes the mapping key exactly as the engine does', () => {
    // the same inputs and value as engine/tests/test_captions_follow_script.py
    const words = [{ id: 'w0', w: ' Nave' }, { id: 'w1', w: '今天。' }];
    expect(mappingKey('Use Neve, 4.0 — 今天。\n"quoted"', words)).toBe('1600ca474501091523e309c7b2bf0f1d69bc8bff38d7cf0709690a809cf2a28b');
  });

  it('shows the current script and each word drawn from it', async () => {
    const { dir, t, p } = await setup(SCRIPT);
    const out = await section(dir, p, t);
    expect(out).toContain(`<script_data>\n${SCRIPT}\n</script_data>`);
    expect(out).toContain('FOLLOWS THE SCRIPT: w0-w5');
    expect(out).toMatch(/\nw3: "Nave" -> "Neve"$/);
    expect(out).not.toContain('w0:');                       // drawn as heard: not a change
  });

  it('never shows a mapping made from another script', async () => {
    const { dir, t, p } = await setup('We record with SHURE every morning.');
    const out = await section(dir, p, t);
    expect(out).toContain('<script_data>\nWe record with SHURE every morning.\n</script_data>');
    expect(out).not.toContain('Neve');
    expect(out).toContain('worked out at the next caption build');
  });

  it('says nothing about a script that was removed or turned off', async () => {
    const removed = await setup(null);
    expect(await section(removed.dir, removed.p, removed.t)).toBe('');
    const off = await setup(SCRIPT);
    off.p.captions.followScript = false;
    expect(await section(off.dir, off.p, off.t)).toBe('');
    off.p.captions.followScript = true;                      // turned back on: the stored mapping is still this script's
    expect(await section(off.dir, off.p, off.t)).toContain('"Nave" -> "Neve"');
  });

  it('reports what a caption correction draws, not the script', async () => {
    const { dir, t, p } = await setup(SCRIPT);
    for (const [fix, shown] of [
      [{ from: 'Nave', to: 'CUSTOM' }, 'w3: "Nave" -> "CUSTOM"'],                     // a single word, everywhere
      [{ from: 'with Nave', to: 'with Rode' }, 'w2-w3: "with Nave" -> "with Rode"'],  // a phrase, over all its words
      [{ from: 'Nave', to: 'Nevé', at: 'w3' }, 'w3: "Nave" -> "Nevé"'],               // one word, from the subtitle list
    ] as const) {
      p.captions.corrections = [fix];
      expect(await section(dir, p, t)).toContain(`${shown} (a caption correction)`);
    }
    p.captions.corrections = [{ from: 'Nave', to: '', at: 'w3' }];        // taken off the captions
    expect(await section(dir, p, t)).toContain('w3: "Nave" -> "" (a caption correction)');
    p.captions.corrections = [{ from: 'Dave', to: 'X', at: 'w3' }];       // no longer heard as "Dave": no effect
    expect(await section(dir, p, t)).toMatch(/\nw3: "Nave" -> "Neve"$/);
  });

  it('reports a correction across several script groups once', async () => {
    const { dir, transcript: t } = await makeProject({ lines: ['We use Nave daily.'] });
    const p = await loadProject(dir);
    p.captions.corrections = [{ from: 'use Nave', to: 'record with Neve' }];
    const align = { key: '', script: '', spans: [], groups: [{ ids: ['w1'], words: ['use'] }, { ids: ['w2'], words: ['Neve'] }] };
    const out = scriptSection(t, p, { script: 'We use Neve daily.', align: align as never }, asData);
    expect(out.match(/record with Neve/g)).toHaveLength(1);
    expect(out).toContain('\nw1-w2: "use Nave" -> "record with Neve" (a caption correction)');
  });

  it('reports a script word only where the cut plays its whole group', async () => {
    const { dir, transcript: t } = await makeProject({ lines: ['Version four point oh ships today.'] });
    const p = await loadProject(dir);
    const align = { key: '', script: '', spans: [], groups: [{ ids: ['w1', 'w2', 'w3'], words: ['4.0'] }] };
    const follow = { script: 'Version 4.0 ships today.', align: align as never };
    p.cut.keep = [{ from: 'w0', to: 'w5' }];
    expect(scriptSection(t, p, follow, asData)).toContain('w1-w3: "four point oh" -> "4.0"');
    p.cut.keep = [{ from: 'w0', to: 'w2' }, { from: 'w4', to: 'w5' }];          // "oh" cut: captions keep "four point"
    expect(scriptSection(t, p, follow, asData)).not.toContain('4.0"');
  });

  it('applies corrections in the engine\'s order', () => {
    const t = makeTranscript(['type script and script']);
    const fixed = correctedWords(t, [{ from: 'script', to: 'TypeScript' }, { from: 'type script', to: 'TypeScript' }]);
    // the phrase claims "type script" first; the single word fixes only the "script" left over
    expect([...fixed]).toEqual([
      ['w0', { text: 'TypeScript', first: 'w0' }], ['w1', { text: 'TypeScript', first: 'w0' }],
      ['w3', { text: 'TypeScript', first: 'w3' }],
    ]);
  });

  it('reads script.txt with the newlines the engine reads', async () => {
    const { dir, transcript } = await makeProject({ lines: [LINE] });
    await fsp.writeFile(path.join(dir, 'script.txt'), 'Line one.\r\nLine two.\r\n');
    const p = await loadProject(dir);
    expect(await currentScript(dir, p)).toBe('Line one.\nLine two.\n');
    p.plan = { script: { draft: 'Draft.', rewrite: 'Mine.', locked: true } };
    expect(await currentScript(dir, p)).toBe('Mine.');
    expect(mappingKey(await currentScript(dir, p), transcript.words)).toHaveLength(64);
  });

  // the engine reads the same text (engine tests/test_captions_follow_script.py), which the mapping's key is made from
  it("reads a planned reel's {hook, script} as one script, the hook first unless the script holds it", async () => {
    const { dir } = await makeProject({ lines: [LINE] });
    const p = await loadProject(dir);
    p.script = { hook: 'Nobody tells you this about Neve.', script: 'I use Neve every day.', shots: ['desk'] };
    expect(await currentScript(dir, p)).toBe('Nobody tells you this about Neve.\nI use Neve every day.');
    p.script = { hook: 'Nobody tells you this.', script: 'Nobody tells you this.\nI use Neve every day.' };
    expect(await currentScript(dir, p)).toBe('Nobody tells you this.\nI use Neve every day.');
  });
});
