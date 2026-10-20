import { describe, it, expect } from 'vitest';
import { namesIn, unsureWords, unshownNames } from '../src/tools';
import { Transcript, withDefaults } from '../src';

function tx(text: string, probs: Record<number, number> = {}): Transcript {
  const words = text.split(' ').map((w, i) => ({ id: `w${i}`, source: 's1', s: i * 0.4, e: i * 0.4 + 0.3, w, p: probs[i] ?? 0.99 }));
  return { words };
}

function proj(t: Transcript) {
  const p = withDefaults({ title: 'x', slug: 'x', sources: [{ id: 's1', path: 'm.mp4', duration: 60, fps: 30, width: 1080, height: 1920, rotation: 0 }] });
  p.cut.keep = [{ from: 'w0', to: t.words.at(-1)!.id }];
  return p;
}

describe('unsure words: where mishearings hide', () => {
  it('lists low-confidence content words with their context, not sure ones or fillers', () => {
    const t = tx('I edit with a cool agent browser and um it works', { 4: 0.55, 8: 0.2, 10: 0.95 });
    const u = unsureWords(t);
    expect(u.map((x) => x.id)).toEqual(['w4']);           // "cool" unsure; "um" is a filler; "works" not unsure
    expect(u[0].context).toContain('[cool]');
  });

  it('a common little word only when the model was really unsure', () => {
    const t = tx('please for all along the way', { 1: 0.3, 4: 0.6 });
    expect(unsureWords(t).map((x) => x.id)).toEqual(['w1']);
  });

  it('skips words the vocabulary pass already respelled', () => {
    const t = tx('ask Mira about it', { 1: 0.5 });
    (t.words[1] as any).heard = 'Myra';
    expect(unsureWords(t)).toEqual([]);
  });
});

describe('names heard / named things not shown', () => {
  it('finds mid-sentence names, ALL-CAPS and camelCase, joined into one entry; ignores sentence starts and common words', () => {
    const t = tx('Then I opened Visual Studio and ran FFMPEG on my MacBook. And it was New York style', {});
    const names = namesIn(t.words, t).map((n) => n.name);
    expect(names).toEqual(['Visual Studio', 'FFMPEG', 'MacBook', 'New York']);
    expect(names).not.toContain('Then');
    expect(names).not.toContain('And');
  });

  it('a name under a b-roll is shown; a name with nothing on screen is listed', () => {
    const t = tx('we tried Spotify and then Netflix for a week');
    const p = proj(t);
    expect(unshownNames(p, t).map((n) => n.name)).toEqual(['Spotify', 'Netflix']);
    p.broll = [{ id: 'b1', anchor: { from: 'w2', to: 'w3' }, treatment: 'card-above-head', asset: 'work/assets/t.png', params: {} }];
    expect(unshownNames(p, t).map((n) => n.name)).toEqual(['Netflix']);
  });

  it('a name the user lower-cased with a correction is not a name', () => {
    const t = tx('it was Grate fun to watch');
    const p = proj(t);
    p.captions.corrections = [{ from: 'Grate', to: 'great' }];
    expect(unshownNames(p, t)).toEqual([]);
  });
});

describe('the caption proofread pass', () => {
  async function setup(unsure: boolean) {
    const { createAI } = await import('../src');
    const { makeProject, FakeHost, tmpDir } = await import('./helpers');
    const fsp = await import('node:fs/promises');
    const path = await import('node:path');
    const { root, dir, transcript } = await makeProject();
    if (unsure) {
      transcript.words[30].p = 0.5;     // "bucks" in "I spent twenty bucks on a fancy flour"
      transcript.words[33].p = 0.3;     // "fancy"
      await fsp.writeFile(path.join(dir, 'work', 'transcript.json'), JSON.stringify(transcript));
    }
    const host = new FakeHost(root);
    return { createAI, dir, host, settingsDir: tmpDir('settings ') };
  }

  it('runs after the edit when the cut has unsure words, with only the caption tools, and its fixes are saved', async () => {
    const { ScriptedModel, call } = await import('./helpers');
    const { loadProject } = await import('../src');
    const { createAI, dir, host, settingsDir } = await setup(true);
    const model = new ScriptedModel([
      { toolCalls: [call('set_cut', { keep: [{ from: 'w16', to: 'w56' }] }), call('add_caption_correction', { from: 'flour', to: 'flower' }),
        call('write_post', { caption: 'Bread', hashtags: ['a', 'b', 'c', 'd', 'e'], keywords: [] }), call('finish', { summary_for_user: 'Cut it.' })] },
      (req) => {
        expect(req.tools.map((t) => t.name).sort()).toEqual(['add_caption_correction', 'finish', 'remove_caption_correction']);
        const text = (req.messages[0] as any).content[0].text as string;
        expect(text).toMatch(/proofread/i);
        expect(text).toContain('fancy(?)');
        expect(text).toContain('"flour" -> "flower"');
        expect(text).not.toContain('okay wait');          // only the kept words
        return { toolCalls: [call('remove_caption_correction', { from: 'flour' }), call('add_caption_correction', { from: 'fancy', to: 'Fancy' }), call('finish', { summary_for_user: 'done' })] };
      },
    ]);
    const r = await createAI({ host, settingsDir, providerOverride: model }).firstEdit(dir, () => undefined);
    expect(r.summary).toBe('Cut it.');                     // the main summary is kept
    expect((await loadProject(dir)).captions.corrections).toEqual([{ from: 'fancy', to: 'Fancy' }]);
  });

  it('does not run when nothing in the cut was unsure (no extra AI turn)', async () => {
    const { ScriptedModel, call } = await import('./helpers');
    const { createAI, dir, host, settingsDir } = await setup(false);
    const model = new ScriptedModel([
      { toolCalls: [call('set_cut', { keep: [{ from: 'w16', to: 'w56' }] }),
        call('write_post', { caption: 'Bread', hashtags: ['a', 'b', 'c', 'd', 'e'], keywords: [] }), call('finish', { summary_for_user: 'Cut it.' })] },
    ]);
    await createAI({ host, settingsDir, providerOverride: model }).firstEdit(dir, () => undefined);
    expect(model.requests).toHaveLength(1);
  });
});

describe('pictures clumped in one half', () => {
  it('zooms do not count when looking for stretches with no picture', async () => {
    const { faceOnlyStretches } = await import('../src/tools');
    const { makeTranscript, SAMPLE_LINES } = await import('./helpers');
    const t = makeTranscript([...SAMPLE_LINES, ...SAMPLE_LINES], 0.05);
    const p = proj(t);
    p.cut.gapCap = 0.1;
    p.zooms = [{ anchor: { from: 'w10', to: 'w100' }, scale: 1.1 }];
    expect(faceOnlyStretches(p, t, 10)).toEqual([]);                 // a zoom fills it for the bare-face check
    expect(faceOnlyStretches(p, t, 10, false).length).toBe(1);        // but there is no picture anywhere
    p.broll = [{ id: 'b1', anchor: { from: 'w20', to: 'w40' }, treatment: 'card-above-head', asset: 'work/assets/a.jpg', params: {} },
      { id: 'b2', anchor: { from: 'w60', to: 'w70' }, treatment: 'card-above-head', asset: 'work/assets/b.jpg', params: {} },
      { id: 'b3', anchor: { from: 'w90', to: 'w100' }, treatment: 'card-above-head', asset: 'work/assets/c.jpg', params: {} }];
    expect(faceOnlyStretches(p, t, 10, false)).toEqual([]);
  });
});

describe('word cards are counted, titles and labels are not', () => {
  it('popCards lists only plain text-pops in the pop style', async () => {
    const { popCards } = await import('../src/tools');
    const t = tx('one two three four five six');
    const p = proj(t);
    const a = { from: 'w0', to: 'w1' };
    p.broll = [
      { id: 'b1', anchor: a, treatment: 'text-pop', asset: null, params: { text: 'Hook title', style: 'label' } },
      { id: 'b2', anchor: a, treatment: 'text-pop', asset: null, params: { text: 'Wow' } },
      { id: 'b3', anchor: a, treatment: 'text-pop', asset: null, params: { text: 'Big', style: 'pop' } },
      { id: 'b4', anchor: a, treatment: 'card-above-head', asset: 'work/assets/a.jpg', params: {} },
    ];
    expect(popCards(p).map((c) => c.id)).toEqual(['b2', 'b3']);
  });
});

describe('a placeholder finish in a repaired XML reply is dropped', () => {
  it('drops finish "x", keeps a real summary and the other calls', async () => {
    const { parseProtocolReply } = await import('../src/providers/cli');
    const { toolSchemas } = await import('../src/tools');
    const tools = toolSchemas();
    const bad = '<invoke name="render_draft">\n</invoke>\n<invoke name="finish">\n<parameter name="summary_for_user">x</parameter>\n</invoke>';
    const r = parseProtocolReply(bad, tools);
    expect(r.toolCalls.map((c) => c.name)).toEqual(['render_draft']);
    const good = '<invoke name="finish">\n<parameter name="summary_for_user">I cut the pauses and added music.</parameter>\n</invoke>';
    expect(parseProtocolReply(good, tools).toolCalls.map((c) => c.name)).toEqual(['finish']);
  });
});
