// A volume change on a video with no song must not claim it changed anything, and a level change that
// leaves the song out keeps the current song instead of removing it.
import { describe, it, expect } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { executeTool, newToolState, loadProject, saveProject, StyleStore, ToolContext } from '../src';
import { FakeHost, makeProject, tinyMp3 } from './helpers';

async function ctxFor() {
  const { root, dir } = await makeProject();
  const ctx: ToolContext = { projectDir: dir, host: new FakeHost(root), style: new StyleStore(() => root), emit: () => undefined, state: newToolState(), supportsImages: true };
  return { ctx, dir, root };
}

describe('choose_music honesty', () => {
  it('no song + "quieter" does nothing and says so', async () => {
    const { ctx, dir } = await ctxFor();
    const r = await executeTool(ctx, 'choose_music', { track: null, startAt: null, level: 'quiet' });
    const c = JSON.parse(r.content);
    expect(c.ok).toBe(false);
    expect(c.note).toMatch(/no song/i);
    expect((await loadProject(dir)).music.track).toBeNull();
  });

  it('a level change without a track keeps the current song, frozen once it is placed again', async () => {
    const { ctx, dir, root } = await ctxFor();
    await fsp.mkdir(path.join(root, 'Library', 'Music'), { recursive: true });
    await fsp.writeFile(path.join(root, 'Library', 'Music', 'calm.mp3'), tinyMp3());
    const p = await loadProject(dir);
    p.music.track = 'Library/Music/calm.mp3';
    p.music.enabled = true;
    p.music.level = 'under-voice';
    p.music.startAt = 12.5;
    p.music.fadeOut = 2;
    await saveProject(dir, p);
    const r = await executeTool(ctx, 'choose_music', { track: null, startAt: null, level: 'quiet' });
    expect(r.summary).toBe('Turned the music down');
    const after = (await loadProject(dir)).music;
    // a project from before frozen songs: the level change freezes its Library song and records it
    expect(after.track).toMatch(/^work\/assets\/frozen\/music\/[0-9a-f]{64}\.mp3$/);
    expect(JSON.parse(await fsp.readFile(path.join(dir, 'work/assets/manifest.jsonl'), 'utf8'))).toMatchObject({ provenance: { intent: 'Library/Music/calm.mp3' } });
    expect(after.level).toBe('quiet');
    // the same song in a new place: its start point and fade stay
    expect([after.startAt, after.fadeOut]).toEqual([12.5, 2]);
  });
});
