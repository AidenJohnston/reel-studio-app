import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { executeTool, loadProject, newToolState, StyleStore, ToolContext } from '../src';
import { discardAssetCandidates } from '../src/tools';
import { FakeHost, makeProject } from './helpers';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });
async function setup() {
  const { root, dir } = await makeProject();
  roots.push(root);
  const video = 'Library/B-roll/clip.mp4', music = 'Library/Music/song.wav';
  await fs.writeFile(path.join(root, video), Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(20)]));
  const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVEfmt '), Buffer.alloc(32)]);
  await fs.writeFile(path.join(root, music), wav);
  // the same clip and song attached to a note: in the project, not the user's Library
  await fs.mkdir(path.join(dir, 'work/attachments'), { recursive: true });
  await fs.copyFile(path.join(root, video), path.join(dir, 'work/attachments/clip.mp4'));
  await fs.copyFile(path.join(root, music), path.join(dir, 'work/attachments/song.wav'));
  const host = new FakeHost(root);
  const ctx: ToolContext = { projectDir: dir, host, style: new StyleStore(() => root), emit: () => {}, state: newToolState(), supportsImages: true };
  return { root, dir, ctx, host, video, music, wav };
}
async function resolve(ctx: ToolContext, kind: string, intent: string) {
  const result = await executeTool(ctx, 'resolve_asset', { kind, intent });
  expect(result.isError, result.content).toBe(false);
  const candidate = JSON.parse(result.content).candidates[0];
  expect(candidate).toBeDefined();
  return candidate;
}
const place = (asset: string) => ({ anchor: { from: 'w29', to: 'w30' }, treatment: 'side-card', asset, params: {} });

describe('media assets', () => {
  it('fails if a video commit does not freeze its bytes and ledger before placement', async () => {
    const { ctx, root, dir, video } = await setup();
    const candidate = await resolve(ctx, 'video', video);
    const bytes = await fs.readFile(path.join(root, video));
    const result = await executeTool(ctx, 'resolve_asset', { kind: 'video', intent: video, phase: 'commit', candidateId: candidate.id });
    expect(result.isError, result.content).toBe(false);
    const asset = JSON.parse(result.content).asset;
    await fs.writeFile(path.join(root, video), 'changed source');
    expect(await fs.readFile(path.join(dir, asset.committedPath))).toEqual(bytes);
    expect(asset.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    const record = JSON.parse((await fs.readFile(path.join(dir, 'work/assets/manifest.jsonl'), 'utf8')).trim());
    expect(record.assetId).toBe(asset.assetId);
    expect(record.provenance.intent).toBe(video);
    expect((await executeTool(ctx, 'add_broll', place(asset.assetId))).isError).toBe(false);
    expect((await loadProject(dir)).broll[0].asset).toBe(asset.committedPath);
  });

  it('fails if a clip or song from outside the Library can be placed without a commit', async () => {
    const { ctx } = await setup();
    const song = await executeTool(ctx, 'choose_music', { track: 'work/attachments/song.wav' });
    expect(song.isError, song.content).toBe(true);
    expect(song.content).toContain('resolve_asset');
    expect((await executeTool(ctx, 'add_broll', place('work/attachments/clip.mp4'))).isError).toBe(true);
  });

  it('fails if a Library clip or song placed by its path needs a commit turn, or lands without a frozen copy and its record', async () => {
    const { ctx, dir, root, host, video, music } = await setup();
    const clip = await executeTool(ctx, 'add_broll', place(video));
    expect(clip.isError, clip.content).toBe(false);
    const song = await executeTool(ctx, 'choose_music', { track: music });
    expect(song.isError, song.content).toBe(false);
    const p = await loadProject(dir);
    expect(p.broll[0].asset).toMatch(/^work\/assets\/frozen\/video\/[0-9a-f]{64}\.mp4$/);
    // the song keeps its Library path, which the app names and checks it by; the engine plays the frozen copy
    expect(p.music.track).toBe(music);
    expect(p.music.frozen).toEqual({ track: music, path: expect.stringMatching(/^work\/assets\/frozen\/music\/[0-9a-f]{64}\.wav$/) });
    expect(await fs.readFile(path.join(dir, p.music.frozen!.path))).toEqual(await fs.readFile(path.join(root, music)));
    const records = (await fs.readFile(path.join(dir, 'work/assets/manifest.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    expect(records.map((r) => [r.kind, r.provenance.intent, r.rightsConfidence])).toEqual([['video', video, 'user-owned'], ['music', music, 'user-owned']]);
    expect(host.calls.filter((c) => c.command.startsWith('inspect-'))).toEqual([]);
    // the edit keeps its copy when the Library file changes
    const before = await fs.readFile(path.join(root, video));
    await fs.writeFile(path.join(root, video), 'edited later');
    expect(await fs.readFile(path.join(dir, String(p.broll[0].asset)))).toEqual(before);
  });

  it('fails if music placement loses its kind or frozen-byte checks', async () => {
    const { ctx, dir, video, music: ref } = await setup();
    const candidate = await resolve(ctx, 'music', ref);
    expect(candidate).toMatchObject({ durationSec: 2, loudnessLufs: -21 });
    const result = await executeTool(ctx, 'resolve_asset', { kind: 'music', intent: ref, phase: 'commit', candidateId: candidate.id });
    expect(result.isError, result.content).toBe(false);
    const asset = JSON.parse(result.content).asset;
    expect((await executeTool(ctx, 'add_broll', place(asset.assetId))).isError).toBe(true);
    const placed = await executeTool(ctx, 'choose_music', { track: asset.assetId });
    expect(placed.isError, placed.content).toBe(false);
    expect((await loadProject(dir)).music).toMatchObject({ track: ref, frozen: { track: ref, path: asset.committedPath } });
    await fs.writeFile(path.join(dir, asset.committedPath), 'changed frozen song');
    expect((await executeTool(ctx, 'choose_music', { level: 'quiet' })).isError).toBe(true);
    expect((await executeTool(ctx, 'choose_music', { track: video })).isError).toBe(true);
  });

  it('fails if a Library song committed through resolve_asset puts its frozen path in music.track', async () => {
    const { ctx, dir, music } = await setup();
    const commit = async (ref: string) => {
      // a project file has no licence of its own: only the commentary policy offers it
      const staged = await executeTool(ctx, 'resolve_asset', { kind: 'music', intent: ref, licensePolicy: 'commentary' });
      const candidate = JSON.parse(staged.content).candidates[0];
      const result = await executeTool(ctx, 'resolve_asset', { kind: 'music', intent: ref, phase: 'commit', candidateId: candidate.id });
      expect(result.isError, result.content).toBe(false);
      return JSON.parse(result.content).asset;
    };
    const asset = await commit(music);
    for (const track of [asset.assetId, asset.committedPath]) {
      const placed = await executeTool(ctx, 'choose_music', { track, startAt: 3 });
      expect(placed.isError, placed.content).toBe(false);
      expect((await loadProject(dir)).music).toMatchObject({ track: music, frozen: { track: music, path: asset.committedPath } });
    }
    // a song from outside the Library has no Library path: its frozen path stays in track (the app names it by its ledger title)
    const other = await commit('work/attachments/song.wav');
    expect((await executeTool(ctx, 'choose_music', { track: other.assetId })).isError).toBe(false);
    const after = (await loadProject(dir)).music;
    expect([after.track, after.frozen]).toEqual([other.committedPath, undefined]);
  });

  it('fails if every placement of a frozen file reads it again, or a changed file keeps its old hash', async () => {
    const { ctx, dir, host, music, wav } = await setup();
    expect((await executeTool(ctx, 'choose_music', { track: music })).isError).toBe(false);
    const [record] = (await fs.readFile(path.join(dir, 'work/assets/manifest.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    const hashes = () => host.calls.filter((c) => c.command === 'hash-asset').length;
    for (const level of ['quiet', 'under-voice', 'quiet']) expect((await executeTool(ctx, 'choose_music', { level })).isError).toBe(false);
    expect(hashes()).toBe(1);
    // same size, new bytes and a new modification time
    const frozen = path.join(dir, record.committedPath);
    await fs.writeFile(frozen, Buffer.concat([wav.subarray(0, wav.length - 1), Buffer.from([1])]));
    await fs.utimes(frozen, new Date(), new Date(Date.now() + 5000));
    expect((await executeTool(ctx, 'choose_music', { level: 'under-voice' })).isError).toBe(true);
    expect(hashes()).toBe(2);
  });

  it('fails if sound effects can still be resolved before anything places them', async () => {
    const { ctx, music } = await setup();
    const r = await executeTool(ctx, 'resolve_asset', { kind: 'sfx', intent: music });
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/invalid arguments/);
  });

  it('fails if cleanup leaves contact sheets or waveforms behind, or removes Library media', async () => {
    const { ctx, dir, root, video, music } = await setup();
    const candidates = [];
    for (const [kind, ref] of [['video', video], ['music', music]]) candidates.push(await resolve(ctx, kind, ref));
    for (const candidate of candidates) expect((await fs.stat(path.join(dir, candidate.previewPath))).isFile()).toBe(true);
    await discardAssetCandidates(ctx);
    expect(await fs.readdir(path.join(dir, 'work/thumbs'))).toEqual([]);
    for (const ref of [video, music]) expect((await fs.stat(path.join(root, ref))).isFile()).toBe(true);
    ctx.host.runEngine = async (_command, args) => {
      const preview = args.includes('--preview') ? args[args.indexOf('--preview') + 1] : 'work/thumbs/partial.png';
      await fs.writeFile(path.join(dir, preview), Buffer.from('partial waveform'));
      throw new Error('engine stopped before returning its preview');
    };
    expect((await executeTool(ctx, 'resolve_asset', { kind: 'music', intent: music })).isError).toBe(true);
    expect(await fs.readdir(path.join(dir, 'work/thumbs'))).toEqual([]);
  });
});
