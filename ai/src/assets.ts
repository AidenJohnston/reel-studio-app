import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { safeResolve, sniffImage } from './safety';
import { S, validate } from './schema';

export const STILL_KINDS = ['image', 'logo', 'icon', 'website_screenshot'] as const;
export type AssetKind = typeof STILL_KINDS[number] | 'video' | 'music' | 'sfx';
export interface AssetCandidate {
  id: string;
  kind: AssetKind;
  source: 'library' | 'open' | 'capture' | 'generated';
  provider: string;
  title: string;
  landingUrl?: string;
  sourceUrl?: string;
  localPath: string;
  previewPath: string;
  width?: number;
  height?: number;
  mime: string;
  license?: string;
  licenseUrl?: string;
  creator?: string;
  attributionRequired: boolean;
  attribution?: string;
  rightsConfidence: 'user-owned' | 'verified-metadata' | 'commentary' | 'generated';
  sha256: string;
}
export interface FrozenAsset extends AssetCandidate {
  assetId: string;
  committedPath: string;
  provenance: {
    intent: string;
    retrievedAt: string;
    sourceUrl?: string;
    landingUrl?: string;
    provider: string;
  };
}
export interface PendingAsset {
  candidate: AssetCandidate;
  requestId: string;
  intent: string;
  retrievedAt: string;
  previewed: boolean;
}
export interface AssetStore { projectDir: string; root: string }
const MAX_BYTES = 40 * 1024 * 1024;
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
const bookSchema = S.arr(S.obj({
  id: S.str(), kind: S.enum([...STILL_KINDS, 'video', 'music', 'sfx']),
  source: S.enum(['library', 'open', 'capture', 'generated']), provider: S.str(), title: S.str(),
  landingUrl: S.str(), sourceUrl: S.str(), localPath: S.str(), previewPath: S.str(), width: S.num(), height: S.num(),
  mime: S.str(), license: S.str(), licenseUrl: S.str(), creator: S.str(), attributionRequired: S.bool(), attribution: S.str(),
  rightsConfidence: S.enum(['user-owned', 'verified-metadata', 'commentary', 'generated']), sha256: S.str(undefined, { minLength: 64 }),
  assetId: S.str(), committedPath: S.str(), provenance: S.obj({
    intent: S.str(), retrievedAt: S.str(), sourceUrl: S.str(), landingUrl: S.str(), provider: S.str(),
  }),
}));
bookSchema.items.required = bookSchema.items.required.filter((k: string) => !['landingUrl', 'sourceUrl', 'width', 'height', 'license', 'licenseUrl', 'creator', 'attribution'].includes(k));
bookSchema.items.properties.provenance.required = ['intent', 'retrievedAt', 'provider'];
function assertBook(value: unknown): asserts value is FrozenAsset[] {
  const errors = validate(bookSchema, value);
  if (errors.length) throw new Error(`The asset ledger is invalid: ${errors.join('; ')}`);
}
function file(store: AssetStore, ref: string, write = false): string {
  return safeResolve(store.projectDir, store.root, ref, write ? 'write' : 'read').abs;
}
async function imageBytes(store: AssetStore, ref: string): Promise<{ bytes: Buffer; ext: keyof typeof MIME; sha256: string }> {
  const handle = await fs.open(file(store, ref), 'r');
  try {
    if ((await handle.stat()).size > MAX_BYTES) throw new Error('The picture is too large (over 40 MB).');
    const bytes = await handle.readFile();
    if (bytes.length > MAX_BYTES) throw new Error('The picture is too large (over 40 MB).');
    const ext = sniffImage(bytes);
    if (!ext) throw new Error('That file is not an image. Choose a PNG, JPEG, GIF or WebP.');
    return { bytes, ext, sha256: createHash('sha256').update(bytes).digest('hex') };
  } finally { await handle.close(); }
}
async function atomicWrite(store: AssetStore, ref: string, data: string | Buffer): Promise<void> {
  const dest = file(store, ref, true);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  const tmp = file(store, `${ref}.${randomUUID()}.tmp`, true);
  try {
    const handle = await fs.open(tmp, 'wx');
    try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
    await fs.rename(tmp, dest);
  } finally { await fs.rm(tmp, { force: true }); }
}
export async function stageAsset(store: AssetStore, ref: string): Promise<Pick<AssetCandidate, 'id' | 'localPath' | 'sha256' | 'mime'>> {
  const { bytes, ext, sha256 } = await imageBytes(store, ref);
  const id = randomUUID();
  const localPath = `work/assets/staging/${id}${ext}`;
  await atomicWrite(store, localPath, bytes);
  return { id, localPath, sha256, mime: MIME[ext] };
}
export async function readAssets(store: AssetStore): Promise<FrozenAsset[]> {
  let text: string;
  try { text = await fs.readFile(file(store, 'work/assets/manifest.jsonl'), 'utf8'); }
  catch (e) { if (e instanceof Error && 'code' in e && e.code === 'ENOENT') return []; throw e; }
  const records: unknown = text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  assertBook(records);
  return records;
}
async function reserveLedger(store: AssetStore): Promise<() => Promise<void>> {
  const ref = 'work/assets/manifest.lock';
  const lockPath = file(store, ref, true);
  const claimRef = `${ref}.${randomUUID()}`;
  const claim = JSON.stringify({ pid: process.pid });
  await atomicWrite(store, claimRef, claim);
  const claimPath = file(store, claimRef, true);
  try {
    // Publish an initialized owner record so a crash cannot leave an ownerless lock.
    try { await fs.link(claimPath, lockPath); }
    catch (e) {
      if (!(e instanceof Error && 'code' in e && e.code === 'EEXIST')) throw e;
      const owner: unknown = JSON.parse(await fs.readFile(lockPath, 'utf8'));
      if (!owner || typeof owner !== 'object' || !('pid' in owner) || typeof owner.pid !== 'number' || !Number.isInteger(owner.pid) || owner.pid <= 0) {
        throw new Error('The asset lock has no valid owner. Close Reel and remove work/assets/manifest.lock before retrying.');
      }
      try { process.kill(owner.pid, 0); }
      catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ESRCH') {
          await fs.rm(lockPath);
          await fs.link(claimPath, lockPath);
          return () => fs.rm(lockPath);
        }
        throw error;
      }
      throw new Error('The asset ledger is busy. Retry the commit.');
    }
    return () => fs.rm(lockPath);
  } finally { await fs.rm(claimPath, { force: true }); }
}
export async function commitAsset(store: AssetStore, pending: PendingAsset): Promise<FrozenAsset> {
  if (!pending.previewed) throw new Error('Inspect the still with preview_asset before committing this candidate.');
  const candidate = pending.candidate;
  const { bytes, ext, sha256 } = await imageBytes(store, candidate.localPath);
  if (sha256 !== candidate.sha256) throw new Error('The candidate changed after its preview. Resolve it again.');
  const release = await reserveLedger(store);
  try {
    const records = await readAssets(store);
    const existing = records.find((r) => r.sha256 === sha256);
    const committedPath = existing?.committedPath ?? `work/assets/frozen/${candidate.kind}/${sha256}${ext}`;
    if (existing) {
      if ((await imageBytes(store, committedPath)).sha256 !== sha256) throw new Error('A frozen asset changed. Restore it before committing another copy.');
    } else await atomicWrite(store, committedPath, bytes);
    const asset: FrozenAsset = {
      ...candidate, localPath: committedPath, committedPath, assetId: `asset_${randomUUID()}`,
      provenance: { intent: pending.intent, retrievedAt: pending.retrievedAt, provider: candidate.provider,
        ...(candidate.sourceUrl ? { sourceUrl: candidate.sourceUrl } : {}), ...(candidate.landingUrl ? { landingUrl: candidate.landingUrl } : {}) },
    };
    const handle = await fs.open(file(store, 'work/assets/manifest.jsonl', true), 'a');
    try { await handle.writeFile(`${JSON.stringify(asset)}\n`); await handle.sync(); } finally { await handle.close(); }
    await atomicWrite(store, 'work/assets/index.json', JSON.stringify({ assets: [...records, asset] }, null, 2));
    await fs.rm(file(store, candidate.localPath, true), { force: true });
    return asset;
  } finally { await release(); }
}
export async function committedAsset(store: AssetStore, ref: string): Promise<FrozenAsset> {
  const records = await readAssets(store);
  const asset = records.find((r) => r.assetId === ref)
    ?? records.find((r) => file(store, r.committedPath) === file(store, ref));
  if (!asset) throw new Error('Resolve and commit this asset with resolve_asset before adding it to the edit.');
  if ((await imageBytes(store, asset.committedPath)).sha256 !== asset.sha256) throw new Error('The committed asset changed. Resolve it again.');
  return asset;
}
export async function exportCredits(store: AssetStore, format: 'json' | 'markdown' | 'text', output?: string): Promise<{ path: string; count: number }> {
  const assets = await readAssets(store);
  const credits = assets.map((a) => ({ assetId: a.assetId, path: a.committedPath, title: a.title,
    sourceUrl: a.sourceUrl, landingUrl: a.landingUrl, creator: a.creator, license: a.license, licenseUrl: a.licenseUrl,
    attribution: a.attribution, retrievedAt: a.provenance.retrievedAt, sha256: a.sha256,
    ...(a.rightsConfidence === 'commentary' ? { notice: `The ${a.kind === 'website_screenshot' ? 'page' : 'image'} belongs to its owner. Use only as commentary; do not imply endorsement.` } : {}),
  }));
  const ref = output ?? `work/credits/assets.${format === 'json' ? 'json' : format === 'markdown' ? 'md' : 'txt'}`;
  const text = format === 'json' ? JSON.stringify(credits, null, 2) : credits.map((c) =>
    [c.title, c.attribution, c.creator, c.license, c.licenseUrl, c.landingUrl ?? c.sourceUrl, c.retrievedAt, c.sha256, c.notice].filter(Boolean).join(' | ')).join('\n');
  if (!safeResolve(store.projectDir, store.root, ref, 'write').ref.startsWith('work/credits/')) throw new Error('Save credits under work/credits/ to keep asset and project files intact.');
  await atomicWrite(store, ref, text);
  return { path: safeResolve(store.projectDir, store.root, ref, 'write').ref, count: credits.length };
}
