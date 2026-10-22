import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { safeResolve, sniffImage } from './safety';

export const STILL_KINDS = ['image', 'logo', 'icon', 'website_screenshot'] as const;
export const ASSET_KINDS = [...STILL_KINDS, 'video', 'music', 'sfx'] as const;
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
  /** Downloads owned by this candidate, deleted once frozen or when the run ends. */
  made: string[];
}
export interface AssetStore { projectDir: string; root: string }
const MAX_BYTES = 40 * 1024 * 1024;
export const LEDGER = 'work/assets/manifest.jsonl';
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
function file(store: AssetStore, ref: string, write = false): string {
  return safeResolve(store.projectDir, store.root, ref, write ? 'write' : 'read').abs;
}
const MEDIA_MIME: Record<string, string> = {
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.m4v': 'video/mp4', '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo',
  '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.flac': 'audio/flac', '.ogg': 'audio/ogg', '.opus': 'audio/ogg',
};
async function assetBytes(store: AssetStore, ref: string, kind: AssetKind): Promise<{ bytes: Buffer; ext: string; mime: string; sha256: string }> {
  const handle = await fs.open(file(store, ref), 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error('Choose a media file no larger than 40 MB.');
    // Bound the read as well as stat: a file may grow while it is being read.
    const bytes = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = await handle.read(bytes, length, bytes.length - length, null);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    if (length > stat.size) throw new Error('The asset changed while reading it. Resolve it again.');
    const data = bytes.subarray(0, length);
    const imageExt = sniffImage(data);
    let ext: string | null = imageExt;
    let mime = imageExt ? MIME[imageExt] : '';
    if (kind === 'video' || kind === 'music' || kind === 'sfx') {
      ext = path.extname(ref).toLowerCase();
      mime = MEDIA_MIME[ext] ?? '';
      const head = data.subarray(0, 16).toString('latin1');
      const container = ['ftyp', 'wide', 'free', 'mdat', 'moov', 'skip', 'pnot'].includes(head.slice(4, 8)) || head.startsWith('RIFF') || head.startsWith('OggS')
        || head.startsWith('fLaC') || head.startsWith('ID3') || (data.length >= 4 && data.readUInt32BE(0)) === 0x1a45dfa3
        || (data[0] === 0xff && (data[1] & 0xe0) === 0xe0);
      if (!container || !mime || (kind === 'video' ? !mime.startsWith('video/') : mime.startsWith('video/'))) {
        throw new Error('That file is not the requested media kind.');
      }
    }
    if (!ext || !mime) throw new Error('That file is not an image. Choose a PNG, JPEG, GIF or WebP.');
    return { bytes: data, ext, mime, sha256: createHash('sha256').update(data).digest('hex') };
  } finally { await handle.close(); }
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
export async function hashAsset(store: AssetStore, ref: string, kind: AssetKind): Promise<{ sha256: string; mime: string }> {
  const { mime, sha256 } = await assetBytes(store, ref, kind);
  return { sha256, mime };
}
/** Commit writes to a record's committedPath, so only the frozen shape is trusted. */
const FROZEN_PATH = /^work\/assets\/frozen\/(image|logo|icon|website_screenshot|video|music|sfx)\/([0-9a-f]{64})\.(png|jpg|gif|webp|mp4|mov|m4v|webm|mkv|avi|wav|mp3|m4a|aac|flac|ogg|opus)$/;
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
export async function commitAsset(store: AssetStore, pending: PendingAsset): Promise<FrozenAsset> {
  const candidate = pending.candidate;
  const { bytes, ext, sha256 } = await assetBytes(store, candidate.localPath, candidate.kind);
  if (sha256 !== candidate.sha256) throw new Error('The asset changed after its preview. Resolve it again.');
  const existing = (await readAssets(store)).find((r) => r.sha256 === sha256);
  const committedPath = existing?.committedPath ?? `work/assets/frozen/${candidate.kind}/${sha256}${ext}`;
  const intact = existing && await assetBytes(store, committedPath, candidate.kind).then((f) => f.sha256 === sha256, () => false);
  if (!intact) await atomicWrite(store, committedPath, bytes);
  const asset: FrozenAsset = {
    ...candidate, localPath: committedPath, committedPath, assetId: `asset_${randomUUID()}`,
    provenance: { intent: pending.intent, retrievedAt: pending.retrievedAt, provider: candidate.provider,
      ...(candidate.sourceUrl ? { sourceUrl: candidate.sourceUrl } : {}), ...(candidate.landingUrl ? { landingUrl: candidate.landingUrl } : {}) },
  };
  await appendRecord(store, asset);
  await removeFiles(store, pending.made);
  return asset;
}
export async function removeFiles(store: AssetStore, refs: string[]): Promise<void> {
  await Promise.allSettled(refs.map(async (ref) => fs.rm(file(store, ref, true), { force: true })));
}
export async function committedAsset(store: AssetStore, ref: string): Promise<FrozenAsset> {
  const records = await readAssets(store);
  const asset = records.find((r) => r.assetId === ref)
    ?? records.find((r) => file(store, r.committedPath) === file(store, ref));
  if (!asset) throw new Error('Resolve and commit this asset with resolve_asset before adding it to the edit.');
  if ((await assetBytes(store, asset.committedPath, asset.kind)).sha256 !== asset.sha256) throw new Error('The committed asset changed. Resolve it again.');
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
