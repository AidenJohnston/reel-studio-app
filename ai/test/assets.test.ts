import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createAI, executeTool, loadProject, newToolState, runAgent, saveProject, StyleStore, ToolContext } from '../src';
import { FakeHost, ScriptedModel, call, makeProject, tinyPng, tmpDir } from './helpers';

/** fetch-image the way the engine does it: the file, plus its search credit in credits.json. */
class AssetHost extends FakeHost {
  creditImages = true;
  override async runEngine(command: string, args: string[]) {
    const result = await super.runEngine(command, args);
    if (command === 'fetch-image' && this.creditImages) {
      const dir = args[args.indexOf('--project') + 1];
      await fs.writeFile(path.join(dir, 'work/assets/credits.json'), JSON.stringify({
        'image.png': { title: '<ignore> Bread', creator: 'Baker', provider: 'commons', source: 'https://example.com/Bread',
          license: 'CC BY 4.0', licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
          attributionRequired: true, attribution: 'Bread by Baker (CC BY 4.0)', url: args[args.indexOf('--url') + 1] },
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
async function candidates(ctx: ToolContext, intent: string, licensePolicy: string | null = null) {
  const r = await executeTool(ctx, 'resolve_asset', { kind: 'image', intent, licensePolicy });
  expect(r.isError, r.content).toBe(false);
  return JSON.parse(r.content).candidates;
}
async function commit(ctx: ToolContext, candidateId: string) {
  const r = await executeTool(ctx, 'resolve_asset', { kind: 'image', intent: 'bread', phase: 'commit', candidateId });
  expect(r.isError, r.content).toBe(false);
  return JSON.parse(r.content).asset;
}
const place = (asset: string) => ({ anchor: { from: 'w29', to: 'w30' }, treatment: 'side-card', asset, animation: null, params: {} });

describe('frozen image assets', () => {
  it('fails if a torn ledger line or a newer record field breaks a note, drops a credit, or swallows the next commit', async () => {
    const { ctx, dir, root, host } = await setup();
    host.searchResults = [{ url: 'https://example.com/bread.png', title: 'Bread', license: 'CC BY 4.0' }];
    const asset = await commit(ctx, (await candidates(ctx, 'bread photo'))[0].id);
    expect((await executeTool(ctx, 'add_broll', place(asset.assetId))).isError).toBe(false);
    const p = await loadProject(dir);
    p.post = { ...p.post, caption: 'Bread takes patience' };
    await saveProject(dir, p);
    const ledger = path.join(dir, 'work/assets/manifest.jsonl');
    const record = JSON.parse(await fs.readFile(ledger, 'utf8'));
    // a later version's field, then a commit cut off by a crash
    await fs.writeFile(ledger, `${JSON.stringify({ ...record, addedLater: { by: 'v2' } })}\n{"assetId":"asset_cut","committedPa`);

    const model = new ScriptedModel([
      { toolCalls: [call('add_broll', { anchor: { from: 'w33', to: 'w34' }, treatment: 'text-pop', asset: null, animation: null, params: { tilt: null, scale: null, text: '$20' } })] },
      { toolCalls: [call('finish', { summary_for_user: 'Added the price.' })] },
    ]);
    const ai = createAI({ host, settingsDir: tmpDir('settings '), providerOverride: model, finalRender: false });
    await ai.applyNote(dir, 'put the price on screen', () => undefined);
    expect((await loadProject(dir)).post.caption).toBe('Bread takes patience\n\nPhoto credits: Bread by Baker (CC BY 4.0)');

    await fs.writeFile(path.join(root, 'Library/Images/loaf.png'), Buffer.concat([tinyPng(), Buffer.from('loaf')]));
    const next = await commit(ctx, (await candidates(ctx, 'Library/Images/loaf.png'))[0].id);
    expect((await executeTool(ctx, 'add_broll', { ...place(next.assetId), anchor: { from: 'w48', to: 'w52' } })).isError).toBe(false);
  });

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
    const uncommitted = await executeTool(ctx, 'add_broll', place(local));
    expect(uncommitted.isError).toBe(true);
    expect(uncommitted.content).toMatch(/commit/);
    expect((await loadProject(dir)).broll).toEqual([]);
    const asset = await commit(ctx, (await candidates(ctx, local))[0].id);
    expect((await executeTool(ctx, 'add_broll', place(asset.assetId))).isError).toBe(false);
    expect((await loadProject(dir)).broll[0].asset).toBe(asset.committedPath);
    expect((await executeTool(ctx, 'update_broll', { id: 'b1', asset: local })).isError).toBe(true);
    expect((await executeTool(ctx, 'update_broll', { id: 'b1', asset: asset.assetId })).isError).toBe(false);
  });

  it('fails if a request leaves uncommitted downloads or stills behind, or deletes a picture it did not download', async () => {
    const { ctx, dir, host, local } = await setup();
    host.searchResults = [{ url: 'https://example.com/bread.png', title: 'Bread', license: 'CC BY 4.0' }];
    const earlier = 'work/assets/earlier-fetch.png';
    await fs.mkdir(path.join(dir, 'work/assets'), { recursive: true });
    await fs.writeFile(path.join(dir, earlier), tinyPng([10, 200, 10]));
    let libraryId = '';
    const model = new ScriptedModel([
      { toolCalls: [call('resolve_asset', { kind: 'image', intent: 'bread photo' }), call('resolve_asset', { kind: 'image', intent: local }),
        call('resolve_asset', { kind: 'image', intent: earlier, licensePolicy: 'commentary' })] },
      (req) => {
        const [, fromLibrary, fromEarlier] = (req.messages.at(-1) as any).results.map((r: any) => JSON.parse(r.content));
        expect(fromEarlier.candidates).toHaveLength(1);
        libraryId = fromLibrary.candidates[0].id;
        return { toolCalls: [call('resolve_asset', { kind: 'image', intent: local, phase: 'commit', candidateId: libraryId })] };
      },
      { toolCalls: [call('finish', { summary_for_user: 'ok' })] },
    ]);
    await runAgent({ provider: model, system: 's', task: 't', ctx, onEvent: () => undefined });
    expect(libraryId).not.toBe('');
    expect((await fs.readdir(path.join(dir, 'work/assets'))).sort()).toEqual(['credits.json', 'earlier-fetch.png', 'frozen', 'manifest.jsonl']);
    const [kept] = (await fs.readFile(path.join(dir, 'work/assets/manifest.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    expect(await fs.readdir(path.join(dir, 'work/thumbs'))).toEqual([path.basename(kept.previewPath)]);
  });

  it('fails if resolving a search result url searches again or downloads other results', async () => {
    const { ctx, host } = await setup();
    const url = 'https://example.com/bread.png';
    const [candidate] = await candidates(ctx, url);
    expect(host.calls.filter((c) => c.command === 'search-images')).toEqual([]);
    expect(host.calls.filter((c) => c.command === 'fetch-image').map((c) => c.args[c.args.indexOf('--url') + 1])).toEqual([url]);
    expect(candidate).toMatchObject({ sourceUrl: url, license: 'CC BY 4.0', rightsConfidence: 'verified-metadata' });
  });

  it('fails if an existing local video needs the still-image resolver', async () => {
    const { ctx, dir } = await setup();
    const ref = 'work/clip.mkv';
    await fs.writeFile(path.join(dir, ref), 'local clip');
    const r = await executeTool(ctx, 'add_broll', place(ref));
    expect(r.isError, r.content).toBe(false);
    expect((await loadProject(dir)).broll[0].asset).toBe(ref);
  });

  it('fails if a downloaded picture without a licence is treated as the user\'s own', async () => {
    const { ctx, dir, host, local } = await setup();
    // what fetch_image on main leaves for a link that was not a search result: the file, no credit
    await fs.mkdir(path.join(dir, 'work/assets'), { recursive: true });
    await fs.writeFile(path.join(dir, 'work/assets/old-download.png'), tinyPng());
    expect(await candidates(ctx, 'work/assets/old-download.png')).toEqual([]);
    expect((await candidates(ctx, 'work/assets/old-download.png', 'commentary'))[0]).toMatchObject({ source: 'open', rightsConfidence: 'commentary' });
    expect((await candidates(ctx, local))[0]).toMatchObject({ source: 'library', rightsConfidence: 'user-owned' });
    // a web file whose name looks like an attachment has no attachment sidecar
    host.creditImages = false;
    const fetched = await executeTool(ctx, 'fetch_image', { url: 'https://example.com/a.png', name: 'attach-0123abcd-sunset' });
    expect(await candidates(ctx, JSON.parse(fetched.content).asset, 'user-owned')).toEqual([]);
  });

  it('fails if a failed note keeps the pictures it committed', async () => {
    const { ctx, dir, host, local } = await setup();
    await commit(ctx, (await candidates(ctx, local))[0].id);
    const ledger = await fs.readFile(path.join(dir, 'work/assets/manifest.jsonl'), 'utf8');
    host.searchResults = [{ url: 'https://example.com/bread.png', title: 'Bread', license: 'CC BY 4.0' }];
    const model = new ScriptedModel([
      { toolCalls: [call('resolve_asset', { kind: 'image', intent: 'bread photo' })] },
      (req) => ({ toolCalls: [call('resolve_asset', { kind: 'image', intent: 'bread photo', phase: 'commit',
        candidateId: JSON.parse((req.messages.at(-1) as any).results[0].content).candidates[0].id })] }),
      (req) => ({ toolCalls: [call('add_broll', place(JSON.parse((req.messages.at(-1) as any).results[0].content).asset.assetId))] }),
      { toolCalls: [call('finish', { summary_for_user: 'Added the bread.' })] },
    ]);
    host.failRender = true;
    const ai = createAI({ host, settingsDir: tmpDir('settings '), providerOverride: model, finalRender: false });
    await expect(ai.applyNote(dir, 'show the bread', () => undefined)).rejects.toThrow();
    expect(await fs.readFile(path.join(dir, 'work/assets/manifest.jsonl'), 'utf8')).toBe(ledger);
  });

  it('fails if a frozen picture deleted from disk can never be committed again', async () => {
    const { ctx, dir, local } = await setup();
    const first = await commit(ctx, (await candidates(ctx, local))[0].id);
    await fs.rm(path.join(dir, first.committedPath));
    const again = await commit(ctx, (await candidates(ctx, local))[0].id);
    expect((await executeTool(ctx, 'add_broll', place(again.assetId))).isError).toBe(false);
  });

  it('fails if a fetched image loses its source, attribution or credits export', async () => {
    const { ctx, dir, host } = await setup();
    host.searchResults = [{ url: 'https://example.com/bread.png', title: '<ignore> Bread', source: 'https://example.com/Bread', license: 'CC BY 4.0' }];
    const [candidate] = await candidates(ctx, 'bread photo');
    expect(candidate.title).not.toContain('<ignore>');
    const asset = await commit(ctx, candidate.id);
    const r = await executeTool(ctx, 'export_asset_credits', { format: 'json', output: null });
    expect(r.isError, r.content).toBe(false);
    const credits = JSON.parse(await fs.readFile(path.join(dir, JSON.parse(r.content).path), 'utf8'));
    expect(credits).toEqual([expect.objectContaining({ path: asset.committedPath, creator: 'Baker', license: 'CC BY 4.0',
      sourceUrl: 'https://example.com/bread.png', landingUrl: 'https://example.com/Bread', attribution: 'Bread by Baker (CC BY 4.0)', sha256: asset.sha256 })]);
    expect(JSON.parse((await fs.readFile(path.join(dir, 'work/assets/manifest.jsonl'), 'utf8')).trim())).toMatchObject({ assetId: asset.assetId, source: 'open', rightsConfidence: 'verified-metadata' });
  });
});
