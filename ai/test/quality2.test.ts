import { describe, it, expect } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { createAI, loadProject, runAgent, newToolState, StyleStore, CompletionRequest } from '../src';
import { parseProtocolReply, parseXmlCalls } from '../src/providers/cli';
import { captionWithCredits, toolSchemas } from '../src/tools';
import { FakeHost, ScriptedModel, makeProject, call, tmpDir } from './helpers';

async function setup() {
  const { root, dir } = await makeProject();
  await fsp.writeFile(path.join(root, 'Library', 'Music', 'gentle.mp3'), 'x');
  const host = new FakeHost(root);
  return { root, dir, host, settingsDir: tmpDir('settings ') };
}

const ctxOf = (dir: string, host: FakeHost) => ({ projectDir: dir, host, style: new StyleStore(() => host.reelStudioRoot()), emit: () => undefined, state: newToolState(), supportsImages: true });
const garbled = { text: '<invoke name="x">\n</invoke>', malformed: true };

describe('agent loop: a flaky model (claude-cli garbles ~1 reply in 5)', () => {
  it('scattered bad replies never end the run: only CONSECUTIVE misses count', async () => {
    const { dir, host } = await setup();
    // 5 bad replies in all, never more than 2 in a row (the old cumulative counter stopped at 3)
    const model = new ScriptedModel([
      garbled, { toolCalls: [call('get_project')] },
      garbled, garbled, { toolCalls: [call('set_gap_cap', { seconds: 0.2 })] },
      { text: 'thinking out loud' }, { toolCalls: [call('get_transcript')] },
      garbled, { toolCalls: [call('finish', { summary_for_user: 'done' })] },
    ]);
    const r = await runAgent({ provider: model, system: 's', task: 't', ctx: ctxOf(dir, host), onEvent: () => undefined });
    expect(r.stoppedBy).toBe('finish');
    expect(r.finished).toBe('done');
  });

  it('a garbled reply gets a short FORMAT correction; plain prose gets the keep-going nudge', async () => {
    const { dir, host } = await setup();
    const seen: string[] = [];
    const lastUser = (req: CompletionRequest) => (req.messages.at(-1) as any).content[0].text as string;
    const model = new ScriptedModel([
      garbled,
      (req) => { seen.push(lastUser(req)); return { text: 'hmm' }; },
      (req) => { seen.push(lastUser(req)); return { toolCalls: [call('finish', { summary_for_user: 'ok' })] }; },
    ]);
    await runAgent({ provider: model, system: 's', task: 't', ctx: ctxOf(dir, host), onEvent: () => undefined });
    expect(seen[0]).toMatch(/could not be read[\s\S]*ONE JSON object[\s\S]*No XML/);
    expect(seen[1]).toMatch(/Keep going/);
  });

  it('stops after 4 misses in a row (a model that never answers in tools cannot loop forever)', async () => {
    const { dir, host } = await setup();
    const model = new ScriptedModel([{ toolCalls: [call('get_project')] }, garbled, garbled, garbled, garbled, { toolCalls: [call('finish', { summary_for_user: 'late' })] }]);
    const r = await runAgent({ provider: model, system: 's', task: 't', ctx: ctxOf(dir, host), onEvent: () => undefined });
    expect(r.stoppedBy).toBe('no_tools');
    expect(r.steps).toBe(5);
  });

  it('a first edit that stops early still writes the post kit (one short wrap-up run)', async () => {
    const { dir, host, settingsDir } = await setup();
    const model = new ScriptedModel([
      { toolCalls: [call('set_cut', { keep: [{ from: 'w16', to: 'w56' }] })] },
      garbled, garbled, garbled, garbled,
      // the wrap-up run: post (and cover) only
      (req) => {
        expect(req.tools.map((t) => t.name).sort()).toEqual(['cover_candidates', 'finish', 'get_transcript', 'set_cover', 'write_post']);
        expect((req.messages[0] as any).content[0].text).toMatch(/Only the post kit is missing[\s\S]*Post kit/);
        return { toolCalls: [call('set_cover', { atSourceTime: 8.5, source: null, text: null }), call('write_post', { caption: 'Bread takes patience', hashtags: ['a', 'b', 'c', 'd', 'e'], keywords: ['bread'] }), call('finish', { summary_for_user: 'post' })] };
      },
    ]);
    const r = await createAI({ host, settingsDir, providerOverride: model }).firstEdit(dir, () => undefined);
    const p = await loadProject(dir);
    expect(p.post.caption).toBe('Bread takes patience');
    expect(p.post.hashtags).toHaveLength(5);
    // still honest about the early stop
    expect(r.summary).toMatch(/ran out of time/);
  });

  it('a finished edit without a caption gets the wrap-up too; the main summary is kept', async () => {
    const { dir, host, settingsDir } = await setup();
    const model = new ScriptedModel([
      { toolCalls: [call('set_cut', { keep: [{ from: 'w16', to: 'w56' }] }), call('finish', { summary_for_user: 'I cut it tight.' })] },
      { toolCalls: [call('write_post', { caption: 'Waiting is the hardest part', hashtags: ['a', 'b', 'c', 'd', 'e'], keywords: ['bread'] }), call('finish', { summary_for_user: 'wrote the post' })] },
    ]);
    const r = await createAI({ host, settingsDir, providerOverride: model }).firstEdit(dir, () => undefined);
    expect(r.summary).toBe('I cut it tight.');
    expect((await loadProject(dir)).post.caption).toBe('Waiting is the hardest part');
  });
});

describe('CLI replies in claude\'s native XML call format are read, not wasted', () => {
  const tools = toolSchemas();

  it('reads well-formed calls with typed arguments', () => {
    const reply = '\n<invoke name="set_cut">\n<parameter name="keep">[{"from":"w0","to":"w9"}]</parameter>\n</invoke>\n'
      + '<invoke name="set_cover">\n<parameter name="atSourceTime">9.02</parameter>\n<parameter name="source">null</parameter>\n<parameter name="text">123</parameter>\n</invoke>\n'
      + '<invoke name="write_post">\n<parameter name="caption">Why I quit: {not json}</parameter>\n<parameter name="hashtags">["a","b","c","d","e"]</parameter>\n<parameter name="keywords">[]</parameter>\n</invoke>\n</invoke>\n</invoke>';
    const r = parseProtocolReply(reply, tools);
    expect(r.repaired).toBe('xml');
    expect(r.toolCalls.map((c) => c.name)).toEqual(['set_cut', 'set_cover', 'write_post']);
    expect(r.toolCalls[0].args).toEqual({ keep: [{ from: 'w0', to: 'w9' }] });
    expect(r.toolCalls[1].args).toEqual({ atSourceTime: 9.02, source: null, text: '123' });   // a string param stays a string
    expect(r.toolCalls[2].args.caption).toBe('Why I quit: {not json}');
  });

  it('prefers a JSON answer that follows an XML false start', () => {
    const reply = '<invoke name="set_gap_cap">\n<parameter name="seconds">0.3</parameter>\n</invoke>\nWait, JSON only:\n{"thought":"x","tool_calls":[{"name":"set_gap_cap","arguments":{"seconds":0.12}}]}';
    const r = parseProtocolReply(reply, tools);
    expect(r.repaired).toBeUndefined();
    expect(r.toolCalls[0].args).toEqual({ seconds: 0.12 });
  });

  it('drops unknown tools, cut-off calls, empty calls to tools that take input, and exact repeats', () => {
    expect(parseXmlCalls('<invoke name="x">\n</invoke>', tools)).toEqual([]);
    expect(parseXmlCalls('<invoke name="choose_music">\n</invoke>', tools)).toEqual([]);   // would remove the music
    expect(parseXmlCalls('<invoke name="fetch_image">\n<parameter name="url">https://a/b.png\n</invoke>', tools)).toEqual([]);
    const twice = '<invoke name="remove_broll"><parameter name="id">b2</parameter></invoke><invoke name="render_draft">\n</invoke>';
    expect(parseXmlCalls(twice + '\n\n' + twice, tools).map((c) => c.name)).toEqual(['remove_broll', 'render_draft']);
  });

  it('a dump of empty calls (the tool catalog) runs nothing and is flagged for a correction', () => {
    const dump = ['add_broll', 'render_draft', 'look_at_frames', 'finish', 'get_project'].map((n) => `<invoke name="${n}">\n</invoke>`).join('\n');
    const r = parseProtocolReply(dump, tools);
    expect(r.toolCalls).toEqual([]);
    expect(r.malformed).toBe(true);
    expect(parseProtocolReply('I think the cut is fine.', tools).malformed).toBeUndefined();
  });
});

describe('parallel tool calls', () => {
  class SlowHost extends FakeHost {
    live = 0; peak = 0; order: string[] = [];
    async runEngine(command: string, args: string[], onProgress?: any): Promise<any> {
      if (command === 'search-images' || command === 'fetch-image') {
        this.live++; this.peak = Math.max(this.peak, this.live);
        await new Promise((r) => setTimeout(r, 60));
        this.live--;
      }
      this.order.push(command);
      return super.runEngine(command, args, onProgress);
    }
  }

  it('searches and downloads in one reply run together (limit 4), results keep the model\'s order; edits run alone', async () => {
    const { root, dir } = await makeProject();
    const host = new SlowHost(root);
    host.engineAssets = true;
    host.searchResults = [{ url: 'https://example.com/a.png', title: 'a' }];
    let results: any[] = [];
    const model = new ScriptedModel([
      { toolCalls: [
        ...['bread', 'flour', 'oven', 'fridge', 'loaf', 'brick'].map((q) => call('search_images', { query: q })),
        call('set_gap_cap', { seconds: 0.2 }),
        call('fetch_image', { url: 'https://example.com/a.png', name: 'one' }), call('fetch_image', { url: 'https://example.com/a.png', name: 'two' }),
      ] },
      (req) => { results = (req.messages.at(-1) as any).results; return { toolCalls: [call('finish', { summary_for_user: 'ok' })] }; },
    ]);
    await runAgent({ provider: model, system: 's', task: 't', ctx: ctxOf(dir, host), onEvent: () => undefined });
    // 4 slow calls were in flight at once (it would be 1 if they ran one by one). Counted, not timed: a wall-clock
    // limit failed on a busy machine.
    expect(host.peak).toBe(4);
    expect(results.map((r) => r.name)).toEqual([...Array(6).fill('search_images'), 'set_gap_cap', 'fetch_image', 'fetch_image']);
    expect(results.every((r) => !r.isError)).toBe(true);
    // the edit between the two runs of searches/downloads did not overlap either of them
    const gap = host.order.indexOf('fetch-image');
    expect(host.order.slice(0, gap).filter((c) => c === 'search-images')).toHaveLength(6);
  });
});

describe('post caption credits', () => {
  it('credits the CC BY pictures the edit uses, and drops a credit when its picture goes', async () => {
    const { dir, host, settingsDir } = await setup();
    await fsp.mkdir(path.join(dir, 'work', 'assets'), { recursive: true });
    await fsp.writeFile(path.join(dir, 'work', 'assets', 'oven.jpg'), 'x');
    await fsp.writeFile(path.join(dir, 'work', 'assets', 'logo.png'), 'x');
    await fsp.writeFile(path.join(dir, 'work', 'assets', 'credits.json'), JSON.stringify({
      'oven.jpg': { attributionRequired: true, attribution: '"Old oven" by Jo, CC BY 2.0, via Openverse' },
      'logo.png': { attributionRequired: false, attribution: 'Bread via Simple Icons (CC0)' },
    }));
    const pop = { tilt: null, scale: null, text: null };
    const model = new ScriptedModel([
      { toolCalls: [
        call('add_broll', { anchor: { from: 'w29', to: 'w30' }, treatment: 'card-above-head', asset: 'work/assets/oven.jpg', search: null, animation: null, params: pop }),
        call('add_broll', { anchor: { from: 'w48', to: 'w52' }, treatment: 'card-above-head', asset: 'work/assets/logo.png', search: null, animation: null, params: pop }),
        call('write_post', { caption: 'Bread takes patience', hashtags: ['a', 'b', 'c', 'd', 'e'], keywords: ['bread'] }),
      ] },
      (req) => {
        expect((req.messages.at(-1) as any).results[2].content).toMatch(/credit line/);
        return { toolCalls: [call('remove_broll', { id: 'b1' }), call('finish', { summary_for_user: 'ok' })] };
      },
    ]);
    const ai = createAI({ host, settingsDir, providerOverride: model });
    await ai.firstEdit(dir, () => undefined);
    const p = await loadProject(dir);
    expect(p.post.caption).toBe('Bread takes patience');               // the oven card was removed: no credit left
    // while the oven picture was in the edit, the caption carried its credit (and never the CC0 logo's)
    const mid = await captionWithCredits(dir, { ...p, broll: [{ id: 'b9', anchor: { from: 'w1', to: 'w2' }, treatment: 'card-above-head', asset: 'work/assets/oven.jpg', params: {} }, ...p.broll] } as any, 'Hi');
    expect(mid).toBe('Hi\n\nPhoto credits: "Old oven" by Jo, CC BY 2.0, via Openverse');
    expect(await captionWithCredits(dir, p, mid)).toBe('Hi');
  });
});

describe('face-only stretches are named in the preview result', () => {
  it('counts b-roll and zooms, not the opening hook title, and gives the words of each gap', async () => {
    const { faceOnlyStretches } = await import('../src/tools');
    const { makeTranscript, SAMPLE_LINES } = await import('./helpers');
    const { withDefaults } = await import('../src');
    const t = makeTranscript([...SAMPLE_LINES, ...SAMPLE_LINES], 0.05);
    const p = withDefaults({ title: 'x', slug: 'x', sources: [{ id: 's1', path: 'm.mp4', duration: 60, fps: 30, width: 1080, height: 1920, rotation: 0 }] });
    const last = t.words.at(-1)!.id;
    p.cut.keep = [{ from: 'w0', to: last }];
    p.cut.gapCap = 0.1;
    p.broll = [{ id: 'b1', anchor: { from: 'w0', to: 'w8' }, treatment: 'text-pop', asset: null, params: { text: 'Hook' } }];
    // only the hook title: the whole video is one bare stretch
    expect(faceOnlyStretches(p, t)).toEqual([expect.objectContaining({ from: 'w0', to: last })]);
    p.broll.push({ id: 'b2', anchor: { from: 'w27', to: 'w34' }, treatment: 'card-above-head', asset: 'work/assets/a.jpg', params: {} });
    p.zooms = [{ anchor: { from: 'w48', to: 'w56' }, scale: 1.1 }, { anchor: { from: 'w70', to: 'w80' }, scale: 1.1 }];
    const gaps = faceOnlyStretches(p, t);
    expect(gaps.map((g) => [g.from, g.to])).toEqual([['w0', 'w26'], ['w35', 'w47'], ['w57', 'w69'], ['w81', last]]);
    p.zooms.push({ anchor: { from: 'w40', to: 'w42' }, scale: 1.1 });          // a fill zoom in the middle splits that gap
    expect(faceOnlyStretches(p, t).map((g) => g.from)).toEqual(['w0', 'w57', 'w81']);
    expect(gaps.every((g) => g.seconds > 4.5)).toBe(true);
  });
});

describe('My style: the AI proposes, the user decides (novice test grandma2 #10)', () => {
  it('only a note that asks to remember saves a rule', async () => {
    const { noteAsksToRemember } = await import('../src/style');
    for (const n of ['Always keep the music quiet', 'from now on use yellow captions', 'remember I like big captions', 'do this in every video', 'next time make it shorter'])
      expect(noteAsksToRemember(n)).toBe(true);
    for (const n of ['music too loud at the start', 'bigger words', 'slower', 'take out the picture on mom', undefined])
      expect(noteAsksToRemember(n)).toBe(false);
  });

  it('a first edit never saves a rule: it comes back as a suggestion', async () => {
    const { root, dir, host, settingsDir } = await setup();
    const model = new ScriptedModel([
      { toolCalls: [call('add_style_rule', { rule: 'Use big captions' }), call('finish', { summary_for_user: 'Done.' })] },
    ]);
    const r = await createAI({ host, settingsDir, providerOverride: model }).firstEdit(dir, () => undefined);
    expect(r.styleSuggestions).toEqual(['Use big captions.']);
    expect(r.styleRulesAdded).toEqual([]);
    expect(r.summary).not.toMatch(/My style/);
    expect(await new StyleStore(() => root).list()).toEqual([]);
  });

  it('a note that only yields a proposal still returns it (no new version needed)', async () => {
    const { dir, host, settingsDir } = await setup();
    const model = new ScriptedModel([{ toolCalls: [call('add_style_rule', { rule: 'Keep music quieter under talking' }), call('finish', { summary_for_user: 'Got it.' })] }]);
    const r = await createAI({ host, settingsDir, providerOverride: model, finalRender: false }).applyNote(dir, 'I like quiet music', () => undefined);
    expect(r.changed).toEqual([]);
    expect(r.styleSuggestions).toEqual(['Keep music quieter under talking.']);
  });
});
