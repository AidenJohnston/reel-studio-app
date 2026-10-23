import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { safeResolve } from './safety';

export const STILL_KINDS = ['image', 'logo', 'icon', 'website_screenshot'] as const;
export const ASSET_KINDS = [...STILL_KINDS, 'video', 'music'] as const;
export type AssetKind = typeof ASSET_KINDS[number];
export interface AssetCandidate {
  id: string;
  kind: AssetKind;
  source: 'library' | 'open' | 'capture';
  provider: string;
  title: string;
  landingUrl?: string;
  sourceUrl?: string;
  localPath: string;
  previewPath: string;
  durationSec?: number;
  loudnessLufs?: number;
  width?: number;
  height?: number;
  mime: string;
  license?: string;
  licenseUrl?: string;
  creator?: string;
  attributionRequired: boolean;
  attribution?: string;
  trademark?: boolean;
  rightsConfidence: 'user-owned' | 'verified-metadata' | 'commentary';
  sha256: string;
}
/** A Library picture placed by its path is frozen without a candidate, so it has no still. */
export interface FrozenAsset extends Omit<AssetCandidate, 'previewPath'> {
  previewPath?: string;
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
  /** Downloads owned by this candidate, deleted once frozen or when the run ends. */
  made: string[];
}
export interface AssetStore { projectDir: string; root: string }
/** The AI package never reads media (CONTRIBUTING): the engine hashes and copies it. */
export interface MediaEngine {
  /** engine freeze-asset: copies `ref` into work/assets/frozen (or reuses a file with the same bytes) */
  freeze(ref: string, kind: AssetKind, expectSha256?: string): Promise<{ committedPath: string; sha256: string; mime: string }>;
  /** engine hash-asset */
  hash(ref: string): Promise<{ sha256: string }>;
}
export const LEDGER = 'work/assets/manifest.jsonl';
function file(store: AssetStore, ref: string, write = false): string {
  return safeResolve(store.projectDir, store.root, ref, write ? 'write' : 'read').abs;
}
async function atomicWrite(store: AssetStore, ref: string, data: string | Buffer): Promise<void> {
  const dest = file(store, ref, true);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  const tmp = file(store, `${ref}.${randomUUID()}.tmp`, true);
  try {
    const handle = await fs.open(tmp, 'wx');
    try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
    try {
      await fs.rename(tmp, dest);
    } catch (e) {
      // Windows refuses rename-over-existing while another reader has the destination open.
      // Concurrent commits of the same content are safe to coalesce; do not discard a
      // different write that won the race.
      if (!(e instanceof Error && 'code' in e && (e.code === 'EPERM' || e.code === 'EEXIST'))) throw e;
      const current = await fs.readFile(dest).catch(() => null);
      if (!current || !current.equals(Buffer.isBuffer(data) ? data : Buffer.from(data))) throw e;
    }
  } finally { await fs.rm(tmp, { force: true }); }
}
/** Commit writes to a record's committedPath, so only the frozen shape is trusted. */
const FROZEN_PATH = /^work\/assets\/frozen\/(image|logo|icon|website_screenshot|video|music)\/([0-9a-f]{64})\.(png|jpg|gif|webp|mp4|mov|m4v|webm|mkv|avi|wav|mp3|m4a|aac|flac|ogg|opus)$/;
function isRecord(v: any): v is FrozenAsset {
  return !!v && typeof v === 'object' && typeof v.assetId === 'string' && typeof v.committedPath === 'string'
    && FROZEN_PATH.exec(v.committedPath)?.[2] === v.sha256 && ASSET_KINDS.includes(v.kind) && typeof v.provenance?.intent === 'string';
}
/** Lines that do not parse are skipped wherever they are: a crash mid-append leaves a torn line,
 * and the next append (which starts on a fresh line) turns it into a middle line. */
export async function readAssets(store: AssetStore): Promise<FrozenAsset[]> {
  let text: string;
  try { text = await fs.readFile(file(store, LEDGER), 'utf8'); }
  catch (e) { if (e instanceof Error && 'code' in e && e.code === 'ENOENT') return []; throw e; }
  return text.split('\n').flatMap((line) => {
    try { const r = JSON.parse(line); return isRecord(r) ? [r] : []; } catch { return []; }
  });
}
async function appendRecord(store: AssetStore, asset: FrozenAsset): Promise<void> {
  const handle = await fs.open(file(store, LEDGER, true), 'a+');
  try {
    const { size } = await handle.stat();
    const last = Buffer.alloc(1);
    const torn = size > 0 && (await handle.read(last, 0, 1, size - 1)).bytesRead === 1 && last[0] !== 0x0a;
    await handle.writeFile(`${torn ? '\n' : ''}${JSON.stringify(asset)}\n`);
    await handle.sync();
  } finally { await handle.close(); }
}
/** The engine copies the bytes to their frozen path (reusing a frozen file with the same hash); this appends the record. */
async function freeze(store: AssetStore, media: MediaEngine, candidate: Omit<AssetCandidate, 'previewPath'> & { previewPath?: string },
  intent: string, retrievedAt: string, expectSha256?: string): Promise<FrozenAsset> {
  const frozen = await media.freeze(candidate.localPath, candidate.kind, expectSha256);
  const asset: FrozenAsset = {
    ...candidate, sha256: frozen.sha256, mime: frozen.mime, localPath: frozen.committedPath, committedPath: frozen.committedPath,
    assetId: `asset_${randomUUID()}`,
    provenance: { intent, retrievedAt, provider: candidate.provider,
      ...(candidate.sourceUrl ? { sourceUrl: candidate.sourceUrl } : {}), ...(candidate.landingUrl ? { landingUrl: candidate.landingUrl } : {}) },
  };
  if (!isRecord(asset)) throw new Error(`The engine froze ${candidate.localPath} at an unexpected path: ${frozen.committedPath}`);
  await appendRecord(store, asset);
  return asset;
}
export async function commitAsset(store: AssetStore, media: MediaEngine, pending: PendingAsset): Promise<FrozenAsset> {
  const asset = await freeze(store, media, pending.candidate, pending.intent, pending.retrievedAt, pending.candidate.sha256);
  await removeFiles(store, pending.made);
  return asset;
}
/** The user's own Library file (a picture, a clip or a song) placed by its path: frozen and recorded in
 * the same call, with no candidate turn. `ref` must already be a resolved `Library/...` path. */
export async function freezeLibraryFile(store: AssetStore, media: MediaEngine, ref: string, kind: AssetKind): Promise<FrozenAsset> {
  if (!ref.startsWith('Library/')) throw new Error(`Only a Library file is frozen by its path: ${ref}`);
  return freeze(store, media, { id: randomUUID(), kind, source: 'library', provider: 'library', title: path.basename(ref), localPath: ref,
    mime: '', sha256: '', rightsConfidence: 'user-owned', attributionRequired: false }, ref, new Date().toISOString());
}
export async function removeFiles(store: AssetStore, refs: string[]): Promise<void> {
  await Promise.allSettled(refs.map(async (ref) => fs.rm(file(store, ref, true), { force: true })));
}
/** sha256 the engine last read for a frozen file, by path, kept while its size and mtime stay the same:
 * a placement re-checks a frozen file without reading it again. */
const verified = new Map<string, { size: number; mtimeMs: number; sha256: string }>();
async function frozenSha(store: AssetStore, media: MediaEngine, ref: string): Promise<string> {
  const abs = file(store, ref);
  const { size, mtimeMs } = await fs.stat(abs);
  const known = verified.get(abs);
  if (known && known.size === size && known.mtimeMs === mtimeMs) return known.sha256;
  const { sha256 } = await media.hash(ref);
  verified.set(abs, { size, mtimeMs, sha256 });
  return sha256;
}
export async function committedAsset(store: AssetStore, media: MediaEngine, ref: string): Promise<FrozenAsset> {
  const records = await readAssets(store);
  const asset = records.find((r) => r.assetId === ref)
    ?? records.find((r) => file(store, r.committedPath) === file(store, ref));
  if (!asset) throw new Error('Resolve and commit this asset with resolve_asset before adding it to the edit.');
  if (await frozenSha(store, media, asset.committedPath) !== asset.sha256) throw new Error('The committed asset changed. Resolve it again.');
  return asset;
}
export async function exportCredits(store: AssetStore, format: 'json' | 'text', output?: string): Promise<{ path: string; count: number }> {
  const assets = await readAssets(store);
  const credits = assets.map((a) => ({ assetId: a.assetId, path: a.committedPath, title: a.title,
    sourceUrl: a.sourceUrl, landingUrl: a.landingUrl, creator: a.creator, license: a.license, licenseUrl: a.licenseUrl,
    attribution: a.attribution, retrievedAt: a.provenance.retrievedAt, sha256: a.sha256,
    ...(a.rightsConfidence === 'commentary' ? { notice: `The ${a.kind === 'website_screenshot' ? 'page' : 'image'} belongs to its owner. Use only as commentary; do not imply endorsement.` }
      : a.trademark ? { notice: 'A trademark of its owner: show it when talking about the brand; do not imply the brand made or endorses the video.' } : {}),
  }));
  const dest = safeResolve(store.projectDir, store.root, output ?? `work/credits/assets.${format === 'json' ? 'json' : 'txt'}`, 'write').ref;
  if (!dest.startsWith('work/credits/')) throw new Error('Save credits under work/credits/ to keep asset and project files intact.');
  const text = format === 'json' ? JSON.stringify(credits, null, 2) : credits.map((c) =>
    [c.title, c.attribution, c.creator, c.license, c.licenseUrl, c.landingUrl ?? c.sourceUrl, c.retrievedAt, c.sha256, c.notice].filter(Boolean).join(' | ')).join('\n');
  await atomicWrite(store, dest, text);
  return { path: dest, count: credits.length };
}
