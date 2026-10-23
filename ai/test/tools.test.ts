import { describe, it, expect } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { TOOLS, TOOL_NAMES, executeTool, newToolState, loadProject, StyleStore, ToolContext, AgentEvent } from '../src';
import { saveProject } from '../src/project';
import { isStrict, validate } from '../src/schema';
import { FakeHost, makeProject, tinyPng } from './helpers';

const SPEC_TOOLS = ['get_project', 'get_transcript', 'set_cut', 'set_gap_cap', 'set_caption_style', 'add_caption_correction', 'remove_caption_correction',
  'list_library', 'choose_music', 'set_music_automation', 'add_broll', 'update_broll', 'remove_broll', 'search_images',
  'fetch_image', 'capture_website', 'make_animation', 'set_zoom', 'cover_candidates', 'set_cover', 'write_post', 'add_style_rule', 'render_draft', 'look_at_frames', 'finish'];

async function ctxFor(): Promise<{ ctx: ToolContext; host: FakeHost; dir: string; root: string; events: AgentEvent[] }> {
  const { root, dir } = await makeProject();
  const host = new FakeHost(root);
  const events: AgentEvent[] = [];
  const ctx: ToolContext = { projectDir: dir, host, style: new StyleStore(() => root), emit: (e) => events.push(e), state: newToolState(), supportsImages: true, lookupImpl: async () => ['93.184.215.14'] };
  return { ctx, host, dir, root, events };
}

describe('tool schemas', () => {
  it('cover the docs/architecture.md section 6 set', () => {
    expect([...TOOL_NAMES].sort()).toEqual([...SPEC_TOOLS].sort());
  });
  it.each(TOOLS.map((t) => [t.name, t]))('%s is strict-mode valid', (_n, t: any) => {
    expect(t.parameters.type).toBe('object');
    expect(isStrict(t.parameters)).toEqual([]);
    expect(t.description.length).toBeGreaterThan(10);
    expect(t.description).not.toMatch(/—/);
  });
  it('validator catches bad args', () => {
    const setCut = TOOLS.find((t) => t.name === 'set_cut')!;
    expect(validate(setCut.parameters, { keep: [{ from: 'w1' }] }).join()).toMatch(/to: missing/);
    expect(validate(setCut.parameters, { keep: [{ from: 'w1', to: 'w2', x: 1 }] }).join()).toMatch(/unknown field/);
    const post = TOOLS.find((t) => t.name === 'write_post')!;
    expect(validate(post.parameters, { caption: 'x', hashtags: ['a', 'b'], keywords: [] }).join()).toMatch(/at least 5/);
  });
  it('explains when a correction word was cut', async () => {
    const { ctx } = await ctxFor();
    await executeTool(ctx, 'set_cut', { keep: [{ from: 'w27', to: 'w56' }] });
    const result = await executeTool(ctx, 'add_caption_correction', { from: 'Nobody', to: 'Someone' });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('was cut');
    expect(result.content).not.toContain('not in the transcript');
  });
});

describe('tool implementations', () => {
  it('set_cut validates ids and reports duration', async () => {
    const { ctx, dir, events } = await ctxFor();
    const bad = await executeTool(ctx, 'set_cut', { keep: [{ from: 'w0', to: 'w999' }] });
    expect(bad.isError).toBe(true);
    expect(bad.content).toMatch(/unknown word id/);
    const ok = await executeTool(ctx, 'set_cut', { keep: [{ from: 'w16', to: 'w26' }, { from: 'w27', to: 'w56' }] });
    expect(ok.isError).toBe(false);
    expect(JSON.parse(ok.content).approxDurationSec).toBeGreaterThan(10);
    expect((await loadProject(dir)).cut.keep).toHaveLength(2);
    expect(events).toContainEqual({ type: 'tool', name: 'set_cut', summary: 'Picked your best takes' });
    expect(ctx.state.changed.has('cut')).toBe(true);
  });

  it('fails if possessive correction rules differ from the engine', async () => {
    const { ctx, dir } = await ctxFor();
    const file = path.join(dir, 'work', 'transcript.json');
    const transcript = JSON.parse(await fsp.readFile(file, 'utf8'));
    transcript.words[0].w = "Claude’s";
    await fsp.writeFile(file, JSON.stringify(transcript));
    await executeTool(ctx, 'set_cut', { keep: [{ from: 'w0', to: 'w56' }] });
    const result = await executeTool(ctx, 'add_caption_correction', { from: 'Claude', to: 'Claud' });
    expect(result.isError).toBe(false);
    expect((await loadProject(dir)).captions.corrections).toEqual([{ from: 'Claude', to: 'Claud' }]);
    const before = await fsp.readFile(path.join(dir, 'project.json'));
    expect((await executeTool(ctx, 'add_caption_correction', { from: 'Claude', to: 'the assistant' })).isError).toBe(true);
    expect(await fsp.readFile(path.join(dir, 'project.json'))).toEqual(before);
  });

  it.each([
    ['size', 301], ['maxWords', 0],
    ['color', 'garbage'], ['case', 'sentence'],
  ])('fails if invalid caption %s=%s is saved', async (field, value) => {
    const { ctx, dir } = await ctxFor();
    const before = await fsp.readFile(path.join(dir, 'project.json'));
    const result = await executeTool(ctx, 'set_caption_style', { [field]: value });
    expect(result.isError).toBe(true);
    expect(result.content).toContain(field);
    expect(await fsp.readFile(path.join(dir, 'project.json'))).toEqual(before);
    expect([...ctx.state.changed]).toEqual([]);
    expect(ctx.state.summaries).toEqual([]);
  });

  it('fails if a fully shadowed correction is saved or reported as fixed', async () => {
    const { ctx, dir, events } = await ctxFor();
    const file = path.join(dir, 'work', 'transcript.json');
    const transcript = JSON.parse(await fsp.readFile(file, 'utf8'));
    transcript.words[0].w = "Claude’s";
    transcript.words[1].w = "Claude";
    await fsp.writeFile(file, JSON.stringify(transcript));
    await executeTool(ctx, 'set_cut', { keep: [{ from: 'w0', to: 'w0' }] });
    expect((await executeTool(ctx, 'add_caption_correction', { from: "Claude’s", to: 'the assistant' })).isError).toBe(false);
    const before = await fsp.readFile(path.join(dir, 'project.json'));
    const summaries = [...ctx.state.summaries];
    const eventCount = events.length;
    const result = await executeTool(ctx, 'add_caption_correction', { from: 'Claude', to: 'Claud' });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Claude’s");
    expect(result.summary).toBeUndefined();
    expect(await fsp.readFile(path.join(dir, 'project.json'))).toEqual(before);
    expect(ctx.state.summaries).toEqual(summaries);
    expect(events).toHaveLength(eventCount);
    await executeTool(ctx, 'set_cut', { keep: [{ from: 'w0', to: 'w1' }] });
    expect((await executeTool(ctx, 'add_caption_correction', { from: 'Claude', to: 'Claud' })).isError).toBe(false);
    expect((await loadProject(dir)).captions.corrections).toContainEqual({ from: 'Claude', to: 'Claud' });
  });

  it('fails if an update saves a missing b-roll asset', async () => {
    const { ctx, dir } = await ctxFor();
    const p = await loadProject(dir);
    p.broll = [{ id: 'b1', anchor: { from: 'w0', to: 'w8' }, treatment: 'side-card', asset: 'work/missing.png', params: {} }];
    await saveProject(dir, p);
    const before = await fsp.readFile(path.join(dir, 'project.json'));
    const result = await executeTool(ctx, 'update_broll', { id: 'b1', params: { tilt: 2 } });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('asset not found');
    expect(await fsp.readFile(path.join(dir, 'project.json'))).toEqual(before);
    expect(ctx.state.summaries).toEqual([]);
  });

  it('fails if corrections ignore the cut or accept removed words', async () => {
    const { ctx, dir } = await ctxFor();
    const file = path.join(dir, 'work', 'transcript.json');
    const transcript = JSON.parse(await fsp.readFile(file, 'utf8'));
    ['type', 'uh', 'script'].forEach((word, i) => { transcript.words[i].w = word; });
    await fsp.writeFile(file, JSON.stringify(transcript));
    await executeTool(ctx, 'set_cut', { keep: [{ from: 'w0', to: 'w0' }, { from: 'w2', to: 'w2' }] });
    const result = await executeTool(ctx, 'add_caption_correction', { from: 'type script', to: 'TypeScript' });
    expect(result.isError).toBe(false);
    expect((await loadProject(dir)).captions.corrections).toEqual([{ from: 'type script', to: 'TypeScript' }]);
    const before = await fsp.readFile(path.join(dir, 'project.json'));
    expect((await executeTool(ctx, 'add_caption_correction', { from: 'uh', to: 'um' })).isError).toBe(true);
    expect(await fsp.readFile(path.join(dir, 'project.json'))).toEqual(before);
  });

  it('fails if unrelated missing assets block b-roll removal', async () => {
    const { ctx, dir } = await ctxFor();
    const p = await loadProject(dir);
    p.broll = ['b1', 'b2'].map((id) => ({
      id, anchor: { from: 'w0', to: 'w8' }, treatment: 'side-card',
      asset: `work/${id}-missing.png`, params: {},
    }));
    await saveProject(dir, p);
    expect((await executeTool(ctx, 'remove_broll', { id: 'b1' })).isError).toBe(false);
    expect((await loadProject(dir)).broll.map((b) => b.id)).toEqual(['b2']);
    expect((await executeTool(ctx, 'remove_broll', { id: 'b2' })).isError).toBe(false);
    expect((await loadProject(dir)).broll).toEqual([]);
  });

  it('fails if a split-number correction is rejected', async () => {
    const { ctx, dir } = await ctxFor();
    const file = path.join(dir, 'work', 'transcript.json');
    const transcript = JSON.parse(await fsp.readFile(file, 'utf8'));
    transcript.words[0].w = '3';
    transcript.words[1].w = ',000';
    await fsp.writeFile(file, JSON.stringify(transcript));
    await executeTool(ctx, 'set_cut', { keep: [{ from: 'w0', to: 'w56' }] });
    const result = await executeTool(ctx, 'add_caption_correction', { from: '3,000', to: 'three thousand' });
    expect(result.isError).toBe(false);
    expect((await loadProject(dir)).captions.corrections).toEqual([{ from: '3,000', to: 'three thousand' }]);
  });

  it('fails if a missing generated animation is saved', async () => {
    const { ctx, dir, host } = await ctxFor();
    host.renderAnimation = async (_template, _params, out) => out;
    const before = await fsp.readFile(path.join(dir, 'project.json'));
    const result = await executeTool(ctx, 'add_broll', {
      anchor: { from: 'w29', to: 'w30' }, treatment: 'animation',
      animation: { template: 'stat-count-up', params: { text: 'hours', value: '18' } }, params: {},
    });
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/asset not found/);
    expect(await fsp.readFile(path.join(dir, 'project.json'))).toEqual(before);
  });

  it('fails if a stale search-result asset is saved', async () => {
    const { ctx, dir, host } = await ctxFor();
    host.searchResults = [{ url: 'https://example.com/x.png', path: 'work/assets/missing.png', title: 'bread' }];
    const before = await fsp.readFile(path.join(dir, 'project.json'));
    const result = await executeTool(ctx, 'add_broll', { anchor: { from: 'w0', to: 'w8' }, treatment: 'side-card', search: 'bread', params: {} });
    expect(result.isError).toBe(true);
    expect(await fsp.readFile(path.join(dir, 'project.json'))).toEqual(before);
    expect([...ctx.state.changed]).toEqual([]);
    expect(ctx.state.summaries).toEqual([]);
  });

  it('get_transcript shows ids, retake groups and the cut', async () => {
    const { ctx } = await ctxFor();
    const r = await executeTool(ctx, 'get_transcript', {});
    expect(r.content).toMatch(/w0:Nobody/);
    expect(r.content).toMatch(/RETAKE GROUPS/);
    expect(r.content).toMatch(/r1: #1 w0-w8/);
    expect(r.content).not.toMatch(/RESPELLED/);
  });

  it('get_transcript lists the words the engine respelled from the user\'s own vocabulary', async () => {
    const { ctx, dir } = await ctxFor();
    const tp = path.join(dir, 'work', 'transcript.json');
    const t = JSON.parse(await fsp.readFile(tp, 'utf8'));
    t.vocab = { terms: { title: 1 }, replacements: [{ id: 'w1', heard: 'Nave', written: 'Neve', source: 'title' }] };
    await fsp.writeFile(tp, JSON.stringify(t));
    const r = await executeTool(ctx, 'get_transcript', {});
    expect(r.content).toMatch(/RESPELLED FROM THE USER'S OWN WORDS[^\n]*\nw1: "Nave" -> "Neve" \[title\]/);
  });

  it('music: list, choose by path or bare name, automation anchors', async () => {
    const { ctx, root, dir } = await ctxFor();
    await fsp.writeFile(path.join(root, 'Library', 'Music', 'calm piano.mp3'), 'x');
    const lib = JSON.parse((await executeTool(ctx, 'list_library', { kind: 'music' })).content);
    expect(lib.files).toEqual(['Library/Music/calm piano.mp3']);
    expect((await executeTool(ctx, 'choose_music', { track: 'nope.mp3', startAt: null, level: null })).isError).toBe(true);
    const r = await executeTool(ctx, 'choose_music', { track: 'calm piano.mp3', startAt: 4, level: 'quiet' });
    expect(r.summary).toBe('Added the song "calm piano"');
    const p = await loadProject(dir);
    expect(p.music).toMatchObject({ track: 'Library/Music/calm piano.mp3', startAt: 4, level: 'quiet', enabled: true });
    expect((await executeTool(ctx, 'set_music_automation', { automation: [{ fromWord: 'w0', toWord: 'wX', gainDb: -6 }] })).isError).toBe(true);
    expect((await executeTool(ctx, 'set_music_automation', { automation: [{ fromWord: 'w0', toWord: 'w8', gainDb: -6 }] })).isError).toBe(false);
    // CLI-style call with missing nullable fields is accepted
    expect((await executeTool(ctx, 'choose_music', { track: null })).isError).toBe(false);
    expect((await loadProject(dir)).music.enabled).toBe(false);
  });

  it('b-roll: text-pop, library asset, animation, search, update, remove', async () => {
    const { ctx, root, dir, host } = await ctxFor();
    await fsp.writeFile(path.join(root, 'Library', 'Images', 'flour.png'), tinyPng());
    const nullP = { tilt: null, scale: null, text: null };
    const a = await executeTool(ctx, 'add_broll', { anchor: { from: 'w29', to: 'w30' }, treatment: 'text-pop', asset: null, search: null, animation: null, params: { ...nullP, text: '$20' } });
    expect(a.isError).toBe(false);
    expect(a.summary).toBe('Added a visual on "twenty bucks"');
    const b = await executeTool(ctx, 'add_broll', { anchor: { from: 'w33', to: 'w34' }, treatment: 'card-above-head', asset: 'flour.png', search: null, animation: null, params: { ...nullP, tilt: -2.5 } });
    expect(JSON.parse(b.content).asset).toBe('Library/Images/flour.png');
    const c = await executeTool(ctx, 'add_broll', { anchor: { from: 'w48', to: 'w52' }, treatment: 'full-frame', asset: null, search: null, animation: { template: 'stat-count-up', params: { text: 'hours', value: '18', items: null } }, params: nullP });
    expect(c.isError).toBe(false);
    expect(host.animations[0]).toMatchObject({ template: 'stat-count-up', params: { text: 'hours', value: '18' } });
    // search: engine returns a local path result
    const img = path.join(dir, 'work', 'found.png');
    await fsp.writeFile(img, tinyPng());
    host.searchResults = [{ url: 'https://example.com/x.png', path: 'work/found.png', title: 'x' }];
    const d = await executeTool(ctx, 'add_broll', { anchor: { from: 'w39', to: 'w41' }, treatment: 'side-card', asset: null, search: 'bread brick', animation: null, params: nullP });
    expect(d.isError).toBe(false);
    const noAsset = await executeTool(ctx, 'add_broll', { anchor: { from: 'w39', to: 'w41' }, treatment: 'side-card', asset: null, search: null, animation: null, params: nullP });
    expect(noAsset.isError).toBe(true);
    let p = await loadProject(dir);
    expect(p.broll.map((x) => x.id)).toEqual(['b1', 'b2', 'b3', 'b4']);
    expect(p.broll[0].params).toEqual({ text: '$20' });
    expect((await executeTool(ctx, 'update_broll', { id: 'b2', anchor: null, treatment: 'side-card', asset: null, params: { tilt: 0, scale: null, text: null } })).isError).toBe(false);
    expect((await executeTool(ctx, 'remove_broll', { id: 'b9' })).isError).toBe(true);
    expect((await executeTool(ctx, 'remove_broll', { id: 'b1' })).isError).toBe(false);
    p = await loadProject(dir);
    expect(p.broll.map((x) => x.id)).toEqual(['b2', 'b3', 'b4']);
    expect(p.broll[0]).toMatchObject({ treatment: 'side-card', params: { tilt: 0 } });
  });

  it('fetch_image downloads images only', async () => {
    const { ctx, dir } = await ctxFor();
    ctx.fetchImpl = (async (url: string) => url.endsWith('.png')
      ? new Response(tinyPng(), { headers: { 'content-type': 'image/png' } })
      : new Response('<html>', { headers: { 'content-type': 'text/html' } })) as any;
    const ok = JSON.parse((await executeTool(ctx, 'fetch_image', { url: 'https://example.com/a/Logo File.png', name: null })).content);
    expect(ok.asset).toBe('work/assets/logo-20file.png');
    await fsp.access(path.join(dir, ok.asset));
    expect((await executeTool(ctx, 'fetch_image', { url: 'https://example.com/page', name: null })).content).toMatch(/not an image/);
    expect((await executeTool(ctx, 'fetch_image', { url: 'file:///etc/passwd', name: null })).isError).toBe(true);
  });

  it('fetch_image goes through the engine and passes its plain-English errors on', async () => {
    const { ctx, dir, host } = await ctxFor();
    host.engineAssets = true;
    const ok = JSON.parse((await executeTool(ctx, 'fetch_image', { url: 'https://example.com/a.png', name: 'logo' })).content);
    expect(ok.asset).toBe('work/assets/logo.png');
    await fsp.access(path.join(dir, ok.asset));
    expect(host.calls.find((c) => c.command === 'fetch-image')?.args).toContain('https://example.com/a.png');
    const bad = await executeTool(ctx, 'fetch_image', { url: 'https://example.com/page', name: null });
    expect(bad.isError).toBe(true);
    expect(bad.content).toMatch(/web page, not a picture/);
  });

  it('choose_music asks the engine where a new song should start', async () => {
    const { ctx, root, dir, host } = await ctxFor();
    host.engineAssets = true;
    await fsp.writeFile(path.join(root, 'Library', 'Music', 'calm piano.mp3'), 'x');
    const r = JSON.parse((await executeTool(ctx, 'choose_music', { track: 'calm piano.mp3', startAt: null, level: null })).content);
    expect(r.song).toMatchObject({ bpm: 92, energy: 'calm', suggestedStartAt: 7.5 });
    expect(r.song.curve).toBeUndefined();
    expect((await loadProject(dir)).music.startAt).toBe(7.5);
    // an explicit start wins, and re-choosing the same song does not re-analyze
    const n = host.calls.filter((c) => c.command === 'analyze-music').length;
    await executeTool(ctx, 'choose_music', { track: 'calm piano.mp3', startAt: 3, level: 'quiet' });
    expect((await loadProject(dir)).music.startAt).toBe(3);
    expect(host.calls.filter((c) => c.command === 'analyze-music').length).toBe(n);
  });

  it('render_draft reports b-roll the engine had to show differently', async () => {
    const { ctx, host } = await ctxFor();
    host.renderExtra = { broll: [{ id: 'b1', treatment: 'side-card', fallback: 'no room on the left of the face', shownAs: 'split-top' }] };
    const r = JSON.parse((await executeTool(ctx, 'render_draft', {})).content);
    expect(r.brollShownDifferently).toEqual([{ id: 'b1', treatment: 'side-card', shownAs: 'split-top', why: 'no room on the left of the face' }]);
    expect(r.note).toMatch(/do not retry/);
  });

  it('render_draft turns an animation the cut moved onto the face into an actionable remake', async () => {
    const { ctx, host, dir } = await ctxFor();
    const p = await loadProject(dir);
    p.broll.push({ id: 'b7', anchor: { from: 'w29', to: 'w30' }, treatment: 'animation', asset: 'work/assets/anim-big-quote-1.mov', params: {} } as any);
    await saveProject(dir, p);
    host.renderExtra = { broll: [{ id: 'b7', treatment: 'animation', remake: 'This animation now covers your face because the edit changed after it was made. Make it again for these words.', clash: ['face'] }] };
    const r = JSON.parse((await executeTool(ctx, 'render_draft', {})).content);
    expect(r.remakeAnimations).toEqual([{ id: 'b7', problem: expect.stringMatching(/covers your face/), covers: ['face'],
      fix: { tool: 'update_broll', args: { id: 'b7', anchor: { from: 'w29', to: 'w30' } } } }]);
    expect(r.brollShownDifferently).toBeUndefined();          // not a placement the AI should leave alone
    expect(r.note).toMatch(/Remake each one now/);
  });

  it('search_images degrades gracefully when the engine has no search', async () => {
    const { ctx, host } = await ctxFor();
    host.runEngine = async () => { throw { code: 'UNKNOWN_COMMAND', userMessage: 'no search' }; };
    const r = await executeTool(ctx, 'search_images', { query: 'flour' });
    expect(r.isError).toBe(false);
    expect(r.content).toMatch(/not available/);
  });

  it('post kit enforces exactly 5 distinct hashtags and strips em dashes', async () => {
    const { ctx, dir } = await ctxFor();
    expect((await executeTool(ctx, 'write_post', { caption: 'x', hashtags: ['a', 'a', 'b', 'c', 'd'], keywords: [] })).isError).toBe(true);
    const r = await executeTool(ctx, 'write_post', { caption: 'Bread — finally', hashtags: ['sourdough', '#breadtok', 'baking ', 'homebaker', 'slowfood'], keywords: ['sourdough tips'] });
    expect(r.isError).toBe(false);
    const p = await loadProject(dir);
    expect(p.post.hashtags).toEqual(['#sourdough', '#breadtok', '#baking', '#homebaker', '#slowfood']);
    expect(p.post.caption).not.toMatch(/—/);
  });

  it('render, frames (images attached), cover, zoom, captions, style, finish', async () => {
    const { ctx, root, dir, events } = await ctxFor();
    expect((await executeTool(ctx, 'look_at_frames', { times: [1], words: null })).content).toMatch(/render_draft first/);
    await executeTool(ctx, 'set_cut', { keep: [{ from: 'w16', to: 'w56' }] });
    const rd = JSON.parse((await executeTool(ctx, 'render_draft', {})).content);
    expect(rd.version).toBe(1);
    expect(events).toContainEqual({ type: 'render', version: 1, draft: true });
    const f = await executeTool(ctx, 'look_at_frames', { times: [1.0], words: ['w29'] });
    expect(f.images).toHaveLength(2);
    expect(f.images![0].mime).toBe('image/png');
    expect((await executeTool(ctx, 'set_zoom', { zooms: [{ anchor: { from: 'w53', to: 'w56' }, scale: 1.12 }] })).isError).toBe(false);
    expect((await executeTool(ctx, 'set_cover', { atSourceTime: 6.2, source: null, text: 'Bread' })).isError).toBe(false);
    expect((await executeTool(ctx, 'set_cover', { atSourceTime: 6.2, source: 's9', text: null })).isError).toBe(true);
    expect((await executeTool(ctx, 'set_caption_style', { size: 70, maxWords: 2, case: 'title', color: '#AABBCC88', position: 0.72 })).isError).toBe(false);
    expect((await loadProject(dir)).captions.style).toMatchObject({ size: 70, maxWords: 2, case: 'title', color: '#AABBCC88', position: 0.72 });
    expect((await executeTool(ctx, 'add_caption_correction', { from: 'flour', to: 'flower' })).isError).toBe(false);
    // no note asking to remember: proposed once (deduped), nothing saved
    await executeTool(ctx, 'add_style_rule', { rule: 'keep music quieter under talking' });
    const again = await executeTool(ctx, 'add_style_rule', { rule: 'Keep music quieter under talking.' });
    expect(again.content).toMatch(/NOT saved/);
    expect(ctx.state.styleSuggestions).toEqual(['Keep music quieter under talking.']);
    expect(ctx.state.styleRulesAdded).toEqual([]);
    await expect(fsp.access(path.join(root, 'My style.json'))).rejects.toBeTruthy();
    // the user's note says "from now on": saved straight away, once
    ctx.userNote = 'from now on keep the music quieter when I talk';
    await executeTool(ctx, 'add_style_rule', { rule: 'keep music quieter under talking' });
    const dup = await executeTool(ctx, 'add_style_rule', { rule: 'Keep music quieter under talking.' });
    expect(dup.content).toMatch(/alreadySaved/);
    expect(ctx.state.styleRulesAdded).toEqual(['Keep music quieter under talking.']);
    expect(JSON.parse(await fsp.readFile(path.join(root, 'My style.json'), 'utf8')).rules).toHaveLength(1);
    ctx.userNote = undefined;
    await executeTool(ctx, 'finish', { summary_for_user: 'I cut it — nice and tight.' });
    expect(ctx.state.finished).toBe('I cut it, nice and tight.');
    expect((await executeTool(ctx, 'nope', {})).content).toMatch(/unknown tool/);
    // namespaced name is accepted
    expect((await executeTool(ctx, 'reel_editor.get_project', {})).isError).toBe(false);
  });

  it('engine errors come back as readable tool errors', async () => {
    const { ctx, host } = await ctxFor();
    host.failRender = true;
    const r = await executeTool(ctx, 'render_draft', {});
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/could not be made/);
  });
});

describe('preview cap', () => {
  it('render_draft refuses after maxDraftRenders and tells the model to finish', async () => {
    const { ctx } = await ctxFor();
    ctx.maxDraftRenders = 1;
    expect((await executeTool(ctx, 'render_draft', {})).isError).toBe(false);
    const second = await executeTool(ctx, 'render_draft', {});
    expect(second.isError).toBe(true);
    expect(second.content).toMatch(/Call finish now/);
  });
});
