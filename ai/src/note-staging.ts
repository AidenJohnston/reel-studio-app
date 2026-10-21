import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AIError } from './types';
import { loadProject, NoteEntry, writeFileAtomic } from './project';
import { StyleStore } from './style';

const projectLocks = new Map<string, Promise<unknown>>();
const copyOnMac = promisify(execFile);

/** Main-process edits and note publication share this queue, including read-modify-write edits. */
export function withProjectLock<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const key = path.resolve(dir);
  const previous = projectLocks.get(key) ?? Promise.resolve();
  const run = previous.then(fn);
  const tail = run.catch(() => undefined);
  projectLocks.set(key, tail);
  void tail.then(() => { if (projectLocks.get(key) === tail) projectLocks.delete(key); });
  return run;
}

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const cancelled = () => new AIError('cancelled', 'Stopped. Your video has not changed.');

async function names(dir: string): Promise<string[]> {
  try { return await fs.readdir(dir); } catch (e: any) { if (e.code === 'ENOENT') return []; throw e; }
}

async function cloneFile(src: string, dest: string): Promise<void> {
  const stat = await fs.stat(src);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  // Node/libuv 1.52.1 returns ENOSYS for FICLONE_FORCE on macOS, making FICLONE a full copy.
  // macOS cp -c uses clonefile on APFS and falls back to an isolated copy on other volumes.
  if (process.platform === 'darwin') await copyOnMac('/bin/cp', ['-c', '--', path.resolve(src), path.resolve(dest)]);
  else await fs.copyFile(src, dest, constants.COPYFILE_FICLONE);
  await fs.utimes(dest, stat.atimeMs / 1000, stat.mtimeMs / 1000);
}

async function transferCompletedCaches(sourceDir: string, dir: string, mode: 'clone' | 'move', signal?: AbortSignal): Promise<void> {
  await forCompletedCache(sourceDir, async (rel) => {
    const source = path.join(sourceDir, rel);
    const destination = path.join(dir, rel);
    if (mode === 'clone') await cloneFile(source, destination);
    else {
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.rename(source, destination);
    }
  }, signal);
}

async function forCompletedCache(sourceDir: string, transfer: (rel: string) => Promise<void>, signal?: AbortSignal): Promise<void> {
  const copy = async (rel: string) => {
    if (signal?.aborted) throw cancelled();
    await transfer(rel);
  };
  const json = async (rel: string) => {
    try { JSON.parse(await fs.readFile(path.join(sourceDir, rel), 'utf8')); }
    catch (e: any) { if (e.code === 'ENOENT' || e instanceof SyntaxError) return; throw e; }
    await copy(rel);
  };
  const render = path.join(sourceDir, 'work', 'render');
  for (const name of await names(path.join(sourceDir, 'work'))) {
    if (!/^face-.+\.json$/.test(name)) continue;
    await json(`work/${name}`);
  }
  try {
    if (/^[a-f0-9]{40}$/.test((await fs.readFile(path.join(render, 'voice.sig'), 'utf8')).trim())) {
      await copy('work/render/voice.wav');
      await copy('work/render/voice.sig');
    }
  } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
  // Final cache media are renamed into place by the engine. Never seed partial files or
  // the directly-written chrome/mask scratch images used to construct video treatments.
  for (const folder of ['layers', 'render/cover-cache']) {
    for (const name of await names(path.join(sourceDir, 'work', folder))) {
      if (!/\.(png|mp4|mov|json)$/.test(name) || /\.part\.|-(chrome|mask)\.png$/.test(name) || name === 'layers.json') continue;
      await copy(`work/${folder}/${name}`);
    }
  }
  for (const name of ['simple-icons.json', 'wikidata.json', 'search-credits.json', 'encoder-probe.json']) {
    await json(`work/cache/${name}`);
  }
  for (const name of await names(path.join(sourceDir, 'work/cache/music-analysis'))) {
    if (/^[a-f0-9]{32}\.json$/.test(name)) await json(`work/cache/music-analysis/${name}`);
  }
  const downloads = path.join(sourceDir, 'work/cache/yt-dlp');
  for (const section of await names(downloads)) {
    if (!/^[\w.-]+$/.test(section) || !(await fs.stat(path.join(downloads, section))).isDirectory()) continue;
    for (const name of await names(path.join(downloads, section))) {
      if (name.endsWith('.json')) await json(`work/cache/yt-dlp/${section}/${name}`);
    }
  }
  const audio = path.join(sourceDir, 'work', 'audio');
  try { JSON.parse(await fs.readFile(path.join(audio, 'mix.json'), 'utf8')); }
  catch (e: any) { if (e.code === 'ENOENT' || e instanceof SyntaxError) return; throw e; }
  for (const name of await names(audio)) {
    if (/^mix-[a-f0-9]+\.wav$/.test(name) || name === 'mix.json') await copy(`work/audio/${name}`);
  }
}

async function promoteCompletedCaches(sourceDir: string, liveDir: string, scratchDir: string): Promise<void> {
  const render = new Set(await names(path.join(liveDir, 'work/render')));
  // The voice and signature describe one result. Installing only half could validate old audio.
  const hasVoice = render.has('voice.wav') || render.has('voice.sig');
  await forCompletedCache(sourceDir, async (rel) => {
    if (hasVoice && (rel === 'work/render/voice.wav' || rel === 'work/render/voice.sig')) return;
    const destination = path.join(liveDir, rel);
    try { await fs.lstat(destination); return; }
    catch (e: any) { if (e.code !== 'ENOENT') throw e; }
    const temporary = path.join(scratchDir, rel);
    await cloneFile(path.join(sourceDir, rel), temporary);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    // Publication holds the same-app project lock across this absence check and rename.
    await fs.rename(temporary, destination);
  });
}

async function removeUnpublished(dir: string, version: number): Promise<void> {
  const root = await fs.realpath(dir);
  await rejectSymlinks(root, 'versions');
  for (const name of await names(path.join(dir, 'versions'))) {
    if (/^v\d+$/.test(name) && Number(name.slice(1)) > version) {
      await rejectSymlinks(root, 'versions');
      await fs.rm(path.join(dir, 'versions', name), { recursive: true, force: true });
    }
  }
}

interface PublicationManifest {
  version: number;
  assets: string[];
  createdDirectories: string[];
  credits?: string | null; // Original bytes in base64; null means the file did not exist.
  creditsHash?: string;
}

function parseManifest(value: unknown, txnId: string): PublicationManifest {
  const invalid = () => { throw new Error('invalid publication manifest'); };
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(txnId)
    || !value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  if (Object.keys(value).some((key) => !['version', 'assets', 'createdDirectories', 'credits', 'creditsHash'].includes(key))) return invalid();
  if (!('version' in value) || typeof value.version !== 'number' || !Number.isSafeInteger(value.version) || value.version < 1
    || !('assets' in value) || !Array.isArray(value.assets)
    || !('createdDirectories' in value) || !Array.isArray(value.createdDirectories)) return invalid();
  const assets: string[] = [];
  for (const rel of value.assets) {
    if (typeof rel !== 'string') return invalid();
    const [work, folder, name, ...extra] = rel.split('/');
    if (work !== 'work' || !['assets', 'thumbs'].includes(folder) || !name || extra.length
      || !name.startsWith(`${txnId}-`) || /[\\/\0]/.test(name) || name.includes('..') || name === `${txnId}-`) return invalid();
    assets.push(rel);
  }
  const createdDirectories: string[] = [];
  for (const rel of value.createdDirectories) {
    if (typeof rel !== 'string' || !['work/assets', 'work/thumbs'].includes(rel)
      || !assets.some((asset) => asset.startsWith(`${rel}/`))) return invalid();
    createdDirectories.push(rel);
  }
  if (new Set(assets).size !== assets.length || new Set(createdDirectories).size !== createdDirectories.length) return invalid();
  const manifest: PublicationManifest = { version: value.version, assets, createdDirectories };
  if ('credits' in value || 'creditsHash' in value) {
    if (!('credits' in value) || !('creditsHash' in value) || typeof value.creditsHash !== 'string'
      || !/^[a-f0-9]{64}$/.test(value.creditsHash)) return invalid();
    const credits = value.credits;
    if (credits !== null && (typeof credits !== 'string' || Buffer.from(credits, 'base64').toString('base64') !== credits)) return invalid();
    manifest.credits = credits;
    manifest.creditsHash = value.creditsHash;
  }
  return manifest;
}

async function rejectSymlinks(root: string, rel: string): Promise<void> {
  let file = root;
  for (const component of rel.split('/')) {
    file = path.join(file, component);
    try {
      if ((await fs.lstat(file)).isSymbolicLink()) throw new Error('symlink in publication path');
    } catch (e: any) { if (e.code === 'ENOENT') return; throw e; }
  }
}

async function unlinkRecoveredFile(root: string, rel: string): Promise<void> {
  await rejectSymlinks(root, path.dirname(rel));
  try { await fs.unlink(path.join(root, rel)); }
  catch (e: any) { if (e.code !== 'ENOENT') throw e; }
}

async function syncDirectory(dir: string): Promise<void> {
  const handle = await fs.open(dir, 'r');
  try {
    try { await handle.sync(); }
    catch (e: any) {
      if (!['EINVAL', 'ENOTSUP'].includes(e.code)) throw e;
      console.warn(`[note publish] directory sync unsupported for ${dir}: ${e.code}`);
    }
  } finally { await handle.close(); }
}

async function readOptional<T>(file: string): Promise<T | undefined> {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (e: any) { if (e.code === 'ENOENT') return undefined; throw e; }
}

async function replayStyle(versionDir: string, store?: StyleStore): Promise<void> {
  const intent = await readOptional<{ root: string; rules: string[] }>(path.join(versionDir, 'style-rules.json'));
  if (!intent) return;
  const style = store ?? new StyleStore(() => intent.root);
  for (const rule of intent.rules) await style.add(rule);
}

/** Keep the manifest until all repairs finish, so another crash can repeat them safely. */
async function recoverTransaction(liveDir: string, dir: string, style?: StyleStore): Promise<boolean> {
  let manifest: PublicationManifest | undefined;
  let root: string;
  try {
    // Resolve the project-root alias, but reject links within it before reading or deleting.
    root = await fs.realpath(liveDir);
    await rejectSymlinks(root, `.staging/${path.basename(dir)}/publication.json`);
    const raw = await readOptional<unknown>(path.join(dir, 'publication.json'));
    if (raw !== undefined) {
      manifest = parseManifest(raw, path.basename(dir));
      const paths = [...manifest.assets, ...manifest.createdDirectories, 'work/assets/credits.json', `versions/v${manifest.version}`];
      for (const rel of paths) await rejectSymlinks(root, rel);
    }
  } catch (error) {
    console.warn(`[note recovery] refused ${path.basename(dir)}: ${error instanceof Error ? error.message : 'invalid publication manifest'}`);
    return false;
  }
  const p = await loadProject(liveDir);
  const committed = p.notes.find((note) => note.txnId === path.basename(dir));
  if (committed) {
    await replayStyle(path.join(liveDir, 'versions', `v${committed.version}`), style);
  } else if (manifest) {
    for (const rel of manifest.assets) await unlinkRecoveredFile(root, rel);
    const credits = path.join(liveDir, 'work/assets/credits.json');
    if (manifest.credits !== undefined) {
      let current: Buffer | undefined;
      try { current = await fs.readFile(credits); }
      catch (e: any) { if (e.code !== 'ENOENT') throw e; }
      if (current && hash(current) === manifest.creditsHash) {
        if (manifest.credits === null) await unlinkRecoveredFile(root, 'work/assets/credits.json');
        else {
          const restored = path.join(dir, 'restored-credits.json');
          await writeFileAtomic(restored, Buffer.from(manifest.credits, 'base64'));
          await rejectSymlinks(root, 'work/assets');
          await fs.rename(restored, credits);
        }
      } else console.warn(`[note recovery] credits do not match ${path.basename(dir)}; leaving them unchanged`);
    }
    for (const rel of manifest.createdDirectories) {
      await rejectSymlinks(root, path.dirname(rel));
      try { await fs.rmdir(path.join(liveDir, rel)); }
      catch (e: any) { if (e.code !== 'ENOENT' && e.code !== 'ENOTEMPTY') throw e; }
    }
    if (manifest.version > p.version) {
      await rejectSymlinks(root, 'versions');
      await fs.rm(path.join(liveDir, 'versions', `v${manifest.version}`), { recursive: true, force: true });
    }
  }
  await rejectSymlinks(root, '.staging');
  await fs.rm(dir, { recursive: true, force: true });
  return true;
}

/** Startup only, before jobs are accepted. Repair publication before deleting its evidence. */
export async function recoverNoteStaging(dir: string): Promise<void> {
  await withProjectLock(dir, async () => {
    try {
      const root = await fs.realpath(dir);
      await rejectSymlinks(root, '.staging');
      await rejectSymlinks(root, 'versions');
    } catch (error) {
      console.warn(`[note recovery] refused cleanup: ${error instanceof Error ? error.message : 'invalid recovery path'}`);
      return;
    }
    let allRecovered = true;
    for (const txn of await names(path.join(dir, '.staging'))) {
      if (!await recoverTransaction(dir, path.join(dir, '.staging', txn))) allRecovered = false;
    }
    // Leave refused transactions and their unknown publication artifacts for inspection.
    if (!allRecovered) return;
    await rejectSymlinks(await fs.realpath(dir), '.staging');
    try { await fs.rmdir(path.join(dir, '.staging')); }
    catch (e: any) { if (e.code !== 'ENOENT' && e.code !== 'ENOTEMPTY') throw e; }
    let p;
    try { p = await loadProject(dir); } catch { return; }
    await removeUnpublished(dir, p.version);
  });
}

export type PublishStep = 'base' | 'assets' | 'credits' | 'version' | 'project' | 'append';

export class NoteTransaction {
  readonly versionDir: string;
  published = false;
  private discardNotified = false;
  private appended = false;
  private style?: StyleStore;
  constructor(
    readonly liveDir: string,
    readonly dir: string,
    readonly txnId: string,
    private readonly base: string,
    private readonly signal?: AbortSignal,
    private readonly onDiscard?: () => void,
  ) { this.versionDir = path.join(dir, 'version'); }

  private async check(): Promise<void> {
    if (!this.signal?.aborted) return;
    // Publication still owns the lock: undo live moves before a queued edit can run.
    await this.discardLocked();
    throw cancelled();
  }

  async discard(): Promise<void> {
    await withProjectLock(this.liveDir, () => this.discardLocked());
  }

  private async discardLocked(): Promise<void> {
    try {
      if (!this.discardNotified) {
        this.discardNotified = true;
        this.onDiscard?.();
      }
    } finally {
      if (this.appended) await fs.rm(this.dir, { recursive: true, force: true });
      else await recoverTransaction(this.liveDir, this.dir, this.style);
    }
  }

  /** Only this function publishes a note. The project rename makes the complete version visible. */
  async publish(entry: Omit<NoteEntry, 'version' | 'txnId'>, rules: string[] = [], style?: StyleStore,
    afterStep?: (step: PublishStep) => void): Promise<number> {
    return withProjectLock(this.liveDir, async () => {
      await this.check();
      const file = path.join(this.liveDir, 'project.json');
      const live = await fs.readFile(file);
      if (hash(live) !== this.base) {
        await this.discardLocked();
        throw new AIError('stale_note', 'Your video changed while I was working. Send your note again.');
      }
      const current = JSON.parse(live.toString('utf8'));
      const p = await loadProject(this.dir);
      const version = Number(current.version ?? 0) + 1;
      const destination = path.join(this.liveDir, 'versions', `v${version}`);
      p.version = version;
      this.style = style;
      const note: NoteEntry = { ...entry, version, txnId: this.txnId };
      p.notes = [...p.notes, note];
      // Prepare every version file before it is moved; published folders are never edited.
      await fs.access(path.join(this.versionDir, 'export.mp4'));
      // Preserve completed work for the next note without copying generated media again.
      const cache = path.join(this.versionDir, '.cache');
      await fs.mkdir(cache, { recursive: true });
      await transferCompletedCaches(this.dir, cache, 'move', this.signal);
      const projectBytes = JSON.stringify(p, null, 2) + '\n';
      const tmp = path.join(this.dir, 'published-project.json');
      const files: [string, string][] = [[path.join(this.versionDir, 'project.json'), projectBytes], [tmp, projectBytes]];
      if (style && rules.length) files.push([path.join(this.versionDir, 'style-rules.json'),
        JSON.stringify({ root: path.dirname(style.file), rules }) + '\n']);
      const notesFile = path.join(this.versionDir, 'notes.md');
      try {
        const notes = await fs.readFile(notesFile, 'utf8');
        files.push([notesFile, `# v${version}\n\n${notes.replace(/^# v\d+\r?\n(?:\r?\n)?/, '')}`]);
      } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
      // Engine metadata must point at the published files after staging is removed.
      for (const name of ['render.json', 'verify.json']) {
        const metadataFile = path.join(this.versionDir, name);
        let metadata;
        try { metadata = JSON.parse(await fs.readFile(metadataFile, 'utf8')); }
        catch (e: any) { if (e.code === 'ENOENT') continue; throw e; }
        metadata.file = path.join(destination, 'export.mp4');
        if (name === 'render.json') {
          metadata.version = version;
          metadata.versionDir = destination;
          if (metadata.cover) metadata.cover = path.join(destination, 'cover.png');
        }
        files.push([metadataFile, JSON.stringify(metadata, null, 2) + '\n']);
      }
      const manifest: PublicationManifest = { version, assets: [], createdDirectories: [] };
      for (const folder of ['assets', 'thumbs']) {
        const rel = `work/${folder}`;
        const dest = path.join(this.liveDir, rel);
        const existing = new Set(await names(dest));
        const staged = (await names(path.join(this.dir, rel))).filter((name) => !(folder === 'assets' && name === 'credits.json'));
        if (staged.length) {
          try { await fs.access(dest); }
          catch (e: any) { if (e.code !== 'ENOENT') throw e; manifest.createdDirectories.push(rel); }
        }
        for (const name of staged) {
          if (!name.startsWith(`${this.txnId}-`)) throw new Error(`Staged ${folder} file has no transaction prefix: ${name}`);
          if (existing.has(name)) throw new Error(`Asset already exists: ${name}`);
          manifest.assets.push(`${rel}/${name}`);
        }
      }
      const creditsFile = path.join(this.liveDir, 'work/assets/credits.json');
      const stagedCredits = await readOptional<Record<string, unknown>>(path.join(this.dir, 'work/assets/credits.json'));
      let mergedCredits: string | undefined;
      if (stagedCredits) {
        const additions = Object.fromEntries(Object.entries(stagedCredits).filter(([key]) => key.startsWith(`${this.txnId}-`)));
        if (Object.keys(additions).length) {
          let prior: Buffer | undefined;
          try { prior = await fs.readFile(creditsFile); }
          catch (e: any) { if (e.code !== 'ENOENT') throw e; }
          manifest.credits = prior?.toString('base64') ?? null;
          mergedCredits = JSON.stringify({ ...(prior ? JSON.parse(prior.toString('utf8')) : {}), ...additions }, null, 2) + '\n';
          manifest.creditsHash = hash(Buffer.from(mergedCredits));
        }
      }
      const preparedCredits = path.join(this.dir, 'published-credits.json');
      if (mergedCredits !== undefined) files.push([preparedCredits, mergedCredits]);
      // Sync the complete destination list and original credits before any live write.
      files.push([path.join(this.dir, 'publication.json'), JSON.stringify(manifest) + '\n']);
      // These independent staged files each sync before publication. Settle every write even
      // after a failure so cleanup cannot race a sibling still preparing its file.
      const prepared = await Promise.allSettled(files.map(([file, data]) => writeFileAtomic(file, data)));
      for (const result of prepared) if (result.status === 'rejected') throw result.reason;
      await syncDirectory(this.dir);
      await removeUnpublished(this.liveDir, Number(current.version ?? 0));
      afterStep?.('base');
      await this.check();
      for (const rel of manifest.assets) {
        await fs.mkdir(path.dirname(path.join(this.liveDir, rel)), { recursive: true });
        // Preserve the timestamps recorded in assets.json for unchanged manual rerenders.
        await fs.rename(path.join(this.dir, rel), path.join(this.liveDir, rel));
      }
      afterStep?.('assets');
      await this.check();
      if (mergedCredits !== undefined) await fs.rename(preparedCredits, creditsFile);
      afterStep?.('credits');
      await this.check();
      await fs.mkdir(path.join(this.liveDir, 'versions'), { recursive: true });
      await fs.rename(this.versionDir, destination);
      afterStep?.('version');
      await this.check();
      await fs.rename(tmp, file);
      this.published = true;
      try { await syncDirectory(this.liveDir); }
      catch (error) {
        console.warn(`[note publish] committed version ${version}, but directory sync failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      afterStep?.('project');
      // The note record committed with the edit. StyleStore.add deduplicates replayed rules.
      for (const rule of rules) await style?.add(rule);
      this.appended = true;
      afterStep?.('append');
      // Cache additions are optional work after the complete note has committed. Existing
      // keys remain untouched, including singleton metadata describing an older live render.
      await promoteCompletedCaches(path.join(destination, '.cache'), this.liveDir, path.join(this.dir, 'cache-promotion'));
      return version;
    });
  }
}

export async function beginNote(liveDir: string, signal?: AbortSignal, onDiscard?: () => void): Promise<NoteTransaction> {
  return withProjectLock(liveDir, async () => {
    if (signal?.aborted) throw cancelled();
    const bytes = await fs.readFile(path.join(liveDir, 'project.json'));
    const txnId = randomUUID();
    const dir = path.join(liveDir, '.staging', txnId);
    await fs.mkdir(path.join(dir, 'work', 'assets'), { recursive: true });
    try {
      await fs.writeFile(path.join(dir, 'project.json'), bytes);
      // Raw media and existing assets remain read-only live inputs.
      for (const rel of ['work/transcript.json', 'work/analysis.json', 'work/analyze.json', 'work/face.json', 'work/assets/credits.json']) {
        try { await cloneFile(path.join(liveDir, rel), path.join(dir, rel)); }
        catch (e: any) { if (e.code !== 'ENOENT') throw e; }
      }
      const version = JSON.parse(bytes.toString('utf8')).version ?? 0;
      let cache = path.join(liveDir, 'versions', `v${version}`, '.cache');
      try { await fs.access(cache); }
      catch (e: any) { if (e.code !== 'ENOENT') throw e; cache = liveDir; }
      await transferCompletedCaches(cache, dir, 'clone', signal);
      if (signal?.aborted) throw cancelled();
      return new NoteTransaction(liveDir, dir, txnId, hash(bytes), signal, onDiscard);
    } catch (e) {
      await fs.rm(dir, { recursive: true, force: true });
      throw e;
    }
  });
}
