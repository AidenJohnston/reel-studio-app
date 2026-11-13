import { describe, it, expect } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { TOOLS, TOOL_NAMES, executeTool, newToolState, loadProject, StyleStore, ToolContext, AgentEvent } from '../src';
import { saveProject } from '../src/project';
import { effectiveStart, visibleChangeSinceRender } from '../src/tools';
import { isStrict, validate } from '../src/schema';
import { FakeHost, makeProject, tinyPng } from './helpers';

const SPEC_TOOLS = ['get_project', 'get_transcript', 'set_cut', 'set_gap_cap', 'set_caption_style', 'add_caption_correction', 'remove_caption_correction',
  'list_library', 'choose_music', 'set_music_automation', 'add_broll', 'update_broll', 'remove_broll', 'search_images',
  'fetch_image', 'capture_website', 'make_animation', 'set_zoom', 'set_sfx', 'set_sound_moments', 'set_mirror', 'cover_candidates', 'set_cover', 'write_post', 'add_style_rule', 'render_draft', 'look_at_frames', 'finish'];

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

  it('add_broll with a picture and no params places it', async () => {
    const { ctx, root, dir } = await ctxFor();
    await fsp.writeFile(path.join(root, 'Library', 'Images', 'flour.png'), tinyPng());
    const r = await executeTool(ctx, 'add_broll', { anchor: { from: 'w33', to: 'w34' }, treatment: 'card-above-head', asset: 'flour.png', search: null, animation: null });
    expect(r.isError, r.content).toBe(false);
    expect((await loadProject(dir)).broll[0]).toMatchObject({ asset: 'Library/Images/flour.png', params: {} });
  });

  it('sound effects: on a word, a b-roll or a cut that exist; an empty list leaves no trace', async () => {
    const { ctx, dir } = await ctxFor();
    await executeTool(ctx, 'set_cut', { keep: [{ from: 'w16', to: 'w40' }, { from: 'w44', to: 'w56' }] });
    const nullP = { tilt: null, scale: null, text: null };
    await executeTool(ctx, 'add_broll', { anchor: { from: 'w29', to: 'w30' }, treatment: 'text-pop', asset: null, search: null, animation: null, params: { ...nullP, text: '$20' } });
    const id = (await loadProject(dir)).broll[0].id;
    const none = { word: null, broll: null, cut: null };
    const ok = await executeTool(ctx, 'set_sfx', { sfx: [
      { sound: 'whoosh-soft', at: { ...none, cut: 'w44' }, gainDb: null },
      { sound: 'pop-plop', at: { ...none, broll: id }, gainDb: -3 },
      { sound: 'click-soft', at: { ...none, word: 'w53' }, gainDb: null },
    ] });
    expect(ok.isError).toBe(false);
    expect((await loadProject(dir)).sfx).toEqual([
      { at: { cut: 'w44' }, sound: 'whoosh-soft' }, { at: { broll: id }, sound: 'pop-plop', gainDb: -3 }, { at: { word: 'w53' }, sound: 'click-soft' },
    ]);
    for (const at of [{ ...none, cut: 'w45' }, { ...none, cut: 'w16' }, { ...none, broll: 'nope' }, { ...none, word: 'w53', cut: 'w44' }, none]) {
      expect((await executeTool(ctx, 'set_sfx', { sfx: [{ sound: 'pop-plop', at, gainDb: null }] })).isError).toBe(true);
    }
    expect((await loadProject(dir)).sfx).toHaveLength(3);
    await executeTool(ctx, 'set_sfx', { sfx: [] });
    expect('sfx' in JSON.parse(await fsp.readFile(path.join(dir, 'project.json'), 'utf8'))).toBe(false);
  });

  /** What a current engine's analyze-music returns as beatGrid for a song file holding `content`. */
  const gridOf = (content: string) => ({ fps: 30, frames: [15, 30, 45], seconds: 120, sha256: createHash('sha256').update(content).digest('hex') });
  const writeSongs = async (root: string, names: string[]) => {
    for (const f of names) await fsp.writeFile(path.join(root, 'Library', 'Music', f), f);
  };
  const none = { onBeat: null, drops: null, reverbThrow: null };

  it('sound moments: the beat grid is stored with the song, then cuts land on it, a line drops the music, the last word echoes', async () => {
    const { ctx, root, dir, host } = await ctxFor();
    await writeSongs(root, ['calm.mp3', 'other.mp3']);
    // no song: nothing to time to, and the reply must say so
    const bare = JSON.parse((await executeTool(ctx, 'set_sound_moments', { ...none, drops: [{ from: 'w3', to: 'w5' }] })).content);
    expect(bare.ok).toBe(false);
    expect((await loadProject(dir)).music.drops).toBeUndefined();

    host.engineAssets = true;
    host.songInfo = { ...host.songInfo, beatGrid: gridOf('calm.mp3') };
    await executeTool(ctx, 'choose_music', { track: 'calm.mp3', startAt: null, level: null });
    expect(host.calls.find((c) => c.command === 'analyze-music')!.args).toEqual(expect.arrayContaining(['--fps', '30']));
    expect((await loadProject(dir)).music).toMatchObject({ startAt: 7.5, beats: gridOf('calm.mp3') });

    const r = await executeTool(ctx, 'set_sound_moments', { onBeat: ['cuts', 'cuts', 'zooms'], drops: [{ from: 'w3', to: 'w5' }], reverbThrow: true });
    expect(r.isError, r.content).toBe(false);
    let p = await loadProject(dir);
    expect(p.music).toMatchObject({ onBeat: ['cuts', 'zooms'], drops: [{ from: 'w3', to: 'w5' }] });
    expect(p.voice).toEqual({ reverbThrow: true });
    expect((await executeTool(ctx, 'set_sound_moments', { ...none, drops: [{ from: 'w3', to: 'wX' }] })).isError).toBe(true);
    // null leaves each one alone; empty lists and false take them off without leaving keys behind
    await executeTool(ctx, 'set_sound_moments', { ...none, reverbThrow: false });
    p = await loadProject(dir);
    expect(p.music.onBeat).toEqual(['cuts', 'zooms']);
    await executeTool(ctx, 'set_sound_moments', { onBeat: [], drops: [], reverbThrow: null });
    const raw = JSON.parse(await fsp.readFile(path.join(dir, 'project.json'), 'utf8'));
    expect(['onBeat' in raw.music, 'drops' in raw.music, 'voice' in raw]).toEqual([false, false, false]);

    // another song drops the first one's beats; asking for the beat then listens to it once
    host.songInfo = { ...host.songInfo, beatGrid: undefined };
    await executeTool(ctx, 'choose_music', { track: 'other.mp3', startAt: 2, level: null });
    expect((await loadProject(dir)).music.beats).toBeUndefined();
    expect((await executeTool(ctx, 'set_sound_moments', { ...none, onBeat: ['broll'] })).isError).toBe(true);
    host.songInfo = { ...host.songInfo, beatGrid: gridOf('other.mp3') };
    expect((await executeTool(ctx, 'set_sound_moments', { ...none, onBeat: ['broll'] })).isError).toBe(false);
    expect((await loadProject(dir)).music).toMatchObject({ beats: gridOf('other.mp3'), onBeat: ['broll'], startAt: 2 });
  });

  it('sound moments: a drop on a song chosen before beats were stored listens for them, and keeps without them', async () => {
    const { ctx, root, dir, host } = await ctxFor();
    await writeSongs(root, ['calm.mp3']);
    await executeTool(ctx, 'choose_music', { track: 'calm.mp3', startAt: 1, level: null });   // an older engine: no grid
    expect((await loadProject(dir)).music.beats).toBeUndefined();
    host.engineAssets = true;
    expect((await executeTool(ctx, 'set_sound_moments', { ...none, drops: [{ from: 'w3', to: 'w5' }] })).isError).toBe(false);
    expect((await loadProject(dir)).music).toMatchObject({ drops: [{ from: 'w3', to: 'w5' }] });   // no beat: back after the line
    host.songInfo = { ...host.songInfo, beatGrid: gridOf('calm.mp3') };
    expect((await executeTool(ctx, 'set_sound_moments', { ...none, drops: [{ from: 'w4', to: 'w6' }] })).isError).toBe(false);
    expect((await loadProject(dir)).music.beats).toEqual(gridOf('calm.mp3'));
  });

  it('a song swapped by hand under the same name is measured again, never timed to the old one\'s beats', async () => {
    const { ctx, root, dir, host } = await ctxFor();
    await writeSongs(root, ['calm.mp3']);
    host.engineAssets = true;
    host.songInfo = { ...host.songInfo, beatGrid: gridOf('calm.mp3') };
    await executeTool(ctx, 'choose_music', { track: 'calm.mp3', startAt: null, level: null });
    const listens = () => host.calls.filter((c) => c.command === 'analyze-music').length;
    const before = listens();
    await executeTool(ctx, 'set_sound_moments', { ...none, onBeat: ['cuts'] });
    expect(listens()).toBe(before);                         // the stored grid is this file's: no listen
    await fsp.writeFile(path.join(root, 'Library', 'Music', 'calm.mp3'), 'a different song');
    host.songInfo = { ...host.songInfo, beatGrid: gridOf('a different song') };
    await executeTool(ctx, 'set_sound_moments', { ...none, onBeat: ['cuts', 'zooms'] });
    expect(listens()).toBe(before + 1);
    expect((await loadProject(dir)).music.beats).toEqual(gridOf('a different song'));
    // choose_music on the same name after a swap listens again too
    await fsp.writeFile(path.join(root, 'Library', 'Music', 'calm.mp3'), 'yet another song');
    host.songInfo = { ...host.songInfo, beatGrid: gridOf('yet another song') };
    await executeTool(ctx, 'choose_music', { track: 'calm.mp3', startAt: null, level: null });
    expect((await loadProject(dir)).music.beats).toEqual(gridOf('yet another song'));
  });

  it('the model sees the beat grid as a tempo and a count, never the frames', async () => {
    const { ctx, root, host } = await ctxFor();
    await writeSongs(root, ['calm.mp3']);
    host.engineAssets = true;
    host.songInfo = { ...host.songInfo, beatGrid: { ...gridOf('calm.mp3'), frames: Array.from({ length: 400 }, (_, i) => 15 * i) } };
    await executeTool(ctx, 'set_cut', { keep: [{ from: 'w0', to: 'w8' }] });
    const chose = JSON.parse((await executeTool(ctx, 'choose_music', { track: 'calm.mp3', startAt: 0, level: null })).content);
    expect(chose.music.beats).toEqual({ bpm: 120, count: 400 });
    await executeTool(ctx, 'set_sound_moments', { ...none, drops: [{ from: 'w3', to: 'w5' }] });
    const seen = JSON.parse((await executeTool(ctx, 'get_project', {})).content);
    expect(seen.music.beats).toEqual({ bpm: 120, count: 400 });
    expect(seen.music.drops[0]).toMatchObject({ from: 'w3', to: 'w5', backOnBeatAtSec: expect.any(Number) });
    expect(JSON.stringify(seen)).not.toMatch(/frames|sha256/);
  });

  it('a drop on a song started too near its end comes back on the beat of the song played from the top', async () => {
    const { ctx, root, host } = await ctxFor();
    await writeSongs(root, ['calm.mp3']);
    host.engineAssets = true;
    // 120 bpm over the 120 s song; a start at 119.3 s plays it from the top (as the engine does)
    host.songInfo = { ...host.songInfo, beatGrid: { ...gridOf('calm.mp3'), frames: Array.from({ length: 240 }, (_, i) => 15 * i) } };
    await executeTool(ctx, 'set_cut', { keep: [{ from: 'w0', to: 'w8' }] });
    await executeTool(ctx, 'choose_music', { track: 'calm.mp3', startAt: 119.3, level: null });
    await executeTool(ctx, 'set_sound_moments', { ...none, drops: [{ from: 'w3', to: 'w5' }] });
    const back = JSON.parse((await executeTool(ctx, 'get_project', {})).content).music.drops[0].backOnBeatAtSec;
    expect(back).not.toBeNull();
    expect((back * 2) % 1).toBeCloseTo(0, 5);              // on the half-second grid of the song from 0 s
    expect(effectiveStart(119.3, 120)).toBe(0);
    expect(effectiveStart(30, 120)).toBe(30);
  });

  it('get_project shows the saved sound effects, so a later note can keep them', async () => {
    const { ctx, dir } = await ctxFor();
    await executeTool(ctx, 'set_cut', { keep: [{ from: 'w0', to: 'w8' }] });
    expect(JSON.parse((await executeTool(ctx, 'get_project', {})).content).sfx).toBeUndefined();
    const at = { word: 'w4', broll: null, cut: null };
    await executeTool(ctx, 'set_sfx', { sfx: [{ sound: 'pop-plop', at, gainDb: null }] });
    expect(JSON.parse((await executeTool(ctx, 'get_project', {})).content).sfx).toEqual((await loadProject(dir)).sfx);
  });

  it('a song change is a visible change when edits land on its beats, and only heard when none do', async () => {
    const { ctx, root, host } = await ctxFor();
    await writeSongs(root, ['a.mp3', 'b.mp3']);
    host.engineAssets = true;
    const pick = async (track: string | null, startAt: number | null) => {
      ctx.state.dirty = new Set();
      await executeTool(ctx, 'choose_music', { track, startAt, level: null });
      return visibleChangeSinceRender(ctx);
    };
    host.songInfo = { ...host.songInfo, beatGrid: gridOf('a.mp3') };
    expect(await pick('a.mp3', null)).toBe(false);
    await executeTool(ctx, 'set_sound_moments', { ...none, onBeat: ['cuts'] });
    expect(await pick('a.mp3', null)).toBe(false);          // the same song, the same start: nothing moves
    expect(await pick('a.mp3', 3)).toBe(true);              // another start point moves the grid
    host.songInfo = { ...host.songInfo, beatGrid: gridOf('b.mp3') };
    expect(await pick('b.mp3', null)).toBe(true);           // another song's beats
    expect(await pick(null, null)).toBe(true);              // no song, nothing on the beat

    // a song whose beats couldn't be heard, under edits still set on the beat: a drop that restores the
    // grid moves the picture too
    host.songInfo = { ...host.songInfo, beatGrid: undefined };
    await pick('a.mp3', null);
    host.songInfo = { ...host.songInfo, beatGrid: gridOf('a.mp3') };
    ctx.state.dirty = new Set();
    await executeTool(ctx, 'set_sound_moments', { ...none, drops: [{ from: 'w3', to: 'w5' }] });
    expect(visibleChangeSinceRender(ctx)).toBe(true);
  });

  it('offers exactly the sounds the engine ships', () => {
    execFileSync(process.execPath, [path.resolve(__dirname, '..', 'scripts', 'gen-sfx.mjs'), '--check']);
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
    const { ctx, root, events } = await ctxFor();
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
    expect((await executeTool(ctx, 'set_caption_style', { enabled: null, preset: null, size: 70, maxWords: 2, case: null, color: null, position: 0.72 })).isError).toBe(false);
    const seeded = await loadProject(ctx.projectDir);
    seeded.captions.corrections = [{ from: 'flower', to: 'Flower', at: 'w20' }];
    await saveProject(ctx.projectDir, seeded);
    expect((await executeTool(ctx, 'add_caption_correction', { from: 'flower', to: 'flour' })).isError).toBe(false);
    await executeTool(ctx, 'remove_caption_correction', { from: 'flower' });
    // the person's fix of one word in the Subtitles list outlives the editor's whole-reel corrections
    expect((await loadProject(ctx.projectDir)).captions.corrections).toEqual([{ from: 'flower', to: 'Flower', at: 'w20' }]);
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
