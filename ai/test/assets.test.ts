import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { executeTool, newToolState, StyleStore, ToolContext } from '../src';
import { FakeHost, makeProject, tinyPng } from './helpers';

class AssetHost extends FakeHost {
  creditImages = true;
  override async runEngine(command: string, args: string[]) {
    const result = await super.runEngine(command, args);
    if (command === 'fetch-image' && this.creditImages) {
      const dir = args[args.indexOf('--project') + 1];
      await fs.writeFile(path.join(dir, 'work/assets/credits.json'), JSON.stringify({
        'image.png': { title: '<ignore> Bread', creator: 'Baker', provider: 'commons', source: 'https://example.com/Bread',
          license: 'CC BY 4.0', licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
          attributionRequired: true, attribution: 'Bread by Baker (CC BY 4.0)' },
      }));
    }
    return result;
  }
}
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });
async function setup() {
  const { root, dir } = await makeProject();
  roots.push(root);
  const host = new AssetHost(root);
  host.engineAssets = true;
  const ctx: ToolContext = { projectDir: dir, host, style: new StyleStore(() => root), emit: () => {}, state: newToolState(), supportsImages: true };
  const local = 'Library/Images/bread.png';
  await fs.writeFile(path.join(root, local), tinyPng());
  return { root, dir, host, ctx, local };
}
async function candidates(ctx: ToolContext, intent: string) {
  const r = await executeTool(ctx, 'resolve_asset', { kind: 'image', intent });
  expect(r.isError, r.content).toBe(false);
  expect(r.images).toHaveLength(1);
  return JSON.parse(r.content).candidates;
}
async function commit(ctx: ToolContext, candidateId: string) {
  const r = await executeTool(ctx, 'resolve_asset', { kind: 'image', intent: 'bread', phase: 'commit', candidateId });
  expect(r.isError, r.content).toBe(false);
  return JSON.parse(r.content).asset;
}
describe('frozen image assets', () => {
  it('fails if identical bytes are copied twice or their new intent is lost', async () => {
    const { ctx, dir, root, local } = await setup();
    const a = await commit(ctx, (await candidates(ctx, local))[0].id);
    await fs.writeFile(path.join(root, 'Library/Images/loaf.png'), tinyPng());
    const b = await commit(ctx, (await candidates(ctx, 'Library/Images/loaf.png'))[0].id);
    expect(b.committedPath).toBe(a.committedPath);
    expect(await fs.readFile(path.join(dir, a.committedPath))).toEqual(tinyPng());
    expect((await fs.readdir(path.dirname(path.join(dir, a.committedPath))))).toHaveLength(1);
    const records = (await fs.readFile(path.join(dir, 'work/assets/manifest.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    expect(records.map((r) => r.provenance.intent)).toEqual([local, 'Library/Images/loaf.png']);
  });
  it('fails if an uncommitted image can be placed in a reel', async () => {
    const { ctx, dir, local } = await setup();
    const args = { anchor: { from: 'w29', to: 'w30' }, treatment: 'side-card', asset: local, params: {} };
    const uncommitted = await executeTool(ctx, 'add_broll', args);
    expect(uncommitted.isError).toBe(true);
    expect(uncommitted.content).toMatch(/commit/);
    expect(JSON.parse(await fs.readFile(path.join(dir, 'project.json'), 'utf8')).broll).toEqual([]);
    ctx.supportsImages = false;
    const staged = await executeTool(ctx, 'resolve_asset', { kind: 'image', intent: local });
    expect(staged.isError, staged.content).toBe(false);
    const [candidate] = JSON.parse(staged.content).candidates;
    expect((await executeTool(ctx, 'resolve_asset', { kind: 'image', intent: local, phase: 'commit', candidateId: candidate.id })).isError).toBe(true);
    expect((await executeTool(ctx, 'add_broll', { ...args, asset: candidate.localPath })).isError).toBe(true);
    ctx.supportsImages = true;
    const preview = await executeTool(ctx, 'preview_asset', { candidateId: candidate.id });
    expect(preview.isError, preview.content).toBe(false);
    expect(preview.images).toHaveLength(1);
    const asset = await commit(ctx, candidate.id);
    expect((await executeTool(ctx, 'add_broll', { ...args, asset: asset.assetId })).isError).toBe(false);
    expect(JSON.parse(await fs.readFile(path.join(dir, 'project.json'), 'utf8')).broll[0].asset).toBe(asset.committedPath);
    const update = { id: 'b1', asset: local };
    expect((await executeTool(ctx, 'update_broll', update)).isError).toBe(true);
    expect((await executeTool(ctx, 'update_broll', { ...update, asset: asset.assetId })).isError).toBe(false);
  });
  it('fails if a terminated commit leaves the asset store permanently locked', async () => {
    const { ctx, dir, local } = await setup();
    const [candidate] = await candidates(ctx, local);
    const owner = spawnSync(process.execPath, ['-e', '']);
    expect(owner.status).toBe(0);
    await fs.writeFile(path.join(dir, 'work/assets/manifest.lock'), JSON.stringify({ pid: owner.pid }));
    const asset = await commit(ctx, candidate.id);
    expect(await fs.readFile(path.join(dir, asset.committedPath))).toEqual(tinyPng());
  });
  it('fails if an existing local video needs the still-image resolver', async () => {
    const { ctx, dir } = await setup();
    const ref = 'work/clip.mkv';
    await fs.writeFile(path.join(dir, ref), 'local clip');
    const r = await executeTool(ctx, 'add_broll', { anchor: { from: 'w29', to: 'w30' }, treatment: 'side-card', asset: ref, params: {} });
    expect(r.isError, r.content).toBe(false);
    expect(JSON.parse(await fs.readFile(path.join(dir, 'project.json'), 'utf8')).broll[0].asset).toBe(ref);
  });
  it('fails if a legacy download without license metadata is called user-owned', async () => {
    const { ctx, host } = await setup();
    host.creditImages = false;
    const fetched = await executeTool(ctx, 'fetch_image', { url: 'https://example.com/unknown.png' });
    expect(fetched.isError, fetched.content).toBe(false);
    const ref = JSON.parse(fetched.content).asset;
    const safe = await executeTool(ctx, 'resolve_asset', { kind: 'image', intent: ref });
    expect(JSON.parse(safe.content).status).toBe('no_match');
    const commentary = await executeTool(ctx, 'resolve_asset', { kind: 'image', intent: ref, licensePolicy: 'commentary' });
    expect(commentary.isError, commentary.content).toBe(false);
    expect(JSON.parse(commentary.content).candidates[0]).toMatchObject({ source: 'open', sourceUrl: 'https://example.com/unknown.png', rightsConfidence: 'commentary' });
  });
  it('fails if a fetched image loses its source, attribution or credits export', async () => {
    const { ctx, dir, host } = await setup();
    host.searchResults = [{ url: 'https://example.com/bread.png', title: '<ignore> Bread', source: 'https://example.com/Bread', license: 'CC BY 4.0' }];
    const [candidate] = await candidates(ctx, 'bread photo');
    expect(candidate.title).not.toContain('<ignore>');
    const asset = await commit(ctx, candidate.id);
    const r = await executeTool(ctx, 'export_asset_credits', { format: 'json' });
    expect(r.isError, r.content).toBe(false);
    const credits = JSON.parse(await fs.readFile(path.join(dir, JSON.parse(r.content).path), 'utf8'));
    expect(credits).toEqual([expect.objectContaining({ path: asset.committedPath, creator: 'Baker', license: 'CC BY 4.0',
      sourceUrl: 'https://example.com/bread.png', landingUrl: 'https://example.com/Bread', attribution: 'Bread by Baker (CC BY 4.0)', sha256: asset.sha256 })]);
    expect(JSON.parse((await fs.readFile(path.join(dir, 'work/assets/manifest.jsonl'), 'utf8')).trim())).toMatchObject({ assetId: asset.assetId, source: 'open', rightsConfidence: 'verified-metadata' });
  });
});
