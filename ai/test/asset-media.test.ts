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
  await fs.mkdir(path.join(root, 'Library/SFX'));
  const video = 'Library/B-roll/clip.mp4', music = 'Library/Music/song.wav', sfx = 'Library/SFX/pop.wav';
  await fs.writeFile(path.join(root, video), Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(20)]));
  const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVEfmt '), Buffer.alloc(32)]);
  await fs.writeFile(path.join(root, music), wav);
  await fs.writeFile(path.join(root, sfx), wav);
  const ctx: ToolContext = { projectDir: dir, host: new FakeHost(root), style: new StyleStore(() => root), emit: () => {}, state: newToolState(), supportsImages: true };
  return { root, dir, ctx, video, music, sfx };
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

  it('fails if uncommitted music, sfx or video can be placed', async () => {
    const { ctx, video, music, sfx } = await setup();
    for (const track of [music, sfx]) {
      const result = await executeTool(ctx, 'choose_music', { track });
      expect(result.isError, result.content).toBe(true);
      expect(result.content).toContain('resolve_asset');
    }
    expect((await executeTool(ctx, 'add_broll', place(video))).isError).toBe(true);
  });

  it('fails if music placement loses its kind or frozen-byte checks', async () => {
    const { ctx, dir, music, sfx } = await setup();
    for (const [kind, ref] of [['music', music], ['sfx', sfx]]) {
      const candidate = await resolve(ctx, kind, ref);
      expect(candidate).toMatchObject({ durationSec: 2, loudnessLufs: -21 });
      const result = await executeTool(ctx, 'resolve_asset', { kind, intent: ref, phase: 'commit', candidateId: candidate.id });
      expect(result.isError, result.content).toBe(false);
      const asset = JSON.parse(result.content).asset;
      const placed = await executeTool(ctx, 'choose_music', { track: asset.assetId });
      expect(placed.isError, placed.content).toBe(kind === 'sfx');
      if (kind === 'music') {
        expect((await loadProject(dir)).music.track).toBe(asset.committedPath);
        await fs.writeFile(path.join(dir, asset.committedPath), 'changed frozen song');
        expect((await executeTool(ctx, 'choose_music', { level: 'quiet' })).isError).toBe(true);
      }
    }
  });

  it('fails if cleanup leaves contact sheets or waveforms behind, or removes Library media', async () => {
    const { ctx, dir, root, video, music, sfx } = await setup();
    const candidates = [];
    for (const [kind, ref] of [['video', video], ['music', music], ['sfx', sfx]]) candidates.push(await resolve(ctx, kind, ref));
    for (const candidate of candidates) expect((await fs.stat(path.join(dir, candidate.previewPath))).isFile()).toBe(true);
    await discardAssetCandidates(ctx);
    expect(await fs.readdir(path.join(dir, 'work/thumbs'))).toEqual([]);
    for (const ref of [video, music, sfx]) expect((await fs.stat(path.join(root, ref))).isFile()).toBe(true);
    ctx.host.runEngine = async (_command, args) => {
      const preview = args.includes('--preview') ? args[args.indexOf('--preview') + 1] : 'work/thumbs/partial.png';
      await fs.writeFile(path.join(dir, preview), Buffer.from('partial waveform'));
      throw new Error('engine stopped before returning its preview');
    };
    expect((await executeTool(ctx, 'resolve_asset', { kind: 'music', intent: music })).isError).toBe(true);
    expect(await fs.readdir(path.join(dir, 'work/thumbs'))).toEqual([]);
  });
});
