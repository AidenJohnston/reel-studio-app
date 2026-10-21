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
  if (process.platform === 'darwin') await copyOnMac('/bin/cp', ['-c', src, dest]);
  else await fs.copyFile(src, dest, constants.COPYFILE_FICLONE);
  await fs.utimes(dest, stat.atimeMs / 1000, stat.mtimeMs / 1000);
}

async function seedRenderCache(liveDir: string, dir: string, signal?: AbortSignal): Promise<void> {
  const copy = async (rel: string) => {
    if (signal?.aborted) throw cancelled();
    await cloneFile(path.join(liveDir, rel), path.join(dir, rel));
  };
  const render = path.join(liveDir, 'work', 'render');
  for (const name of await names(path.join(liveDir, 'work'))) {
    if (!/^face-.+\.json$/.test(name)) continue;
    try { JSON.parse(await fs.readFile(path.join(liveDir, 'work', name), 'utf8')); }
    catch (e) { if (e instanceof SyntaxError) continue; throw e; }
    await copy(`work/${name}`);
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
    for (const name of await names(path.join(liveDir, 'work', folder))) {
      if (!/\.(png|mp4|mov|json)$/.test(name) || /\.part\.|-(chrome|mask)\.png$/.test(name) || name === 'layers.json') continue;
      await copy(`work/${folder}/${name}`);
    }
  }
  const audio = path.join(liveDir, 'work', 'audio');
  try { JSON.parse(await fs.readFile(path.join(audio, 'mix.json'), 'utf8')); }
  catch (e: any) { if (e.code === 'ENOENT' || e instanceof SyntaxError) return; throw e; }
  for (const name of await names(audio)) {
    if (/^mix-[a-f0-9]+\.wav$/.test(name) || name === 'mix.json') await copy(`work/audio/${name}`);
  }
}

async function removeUnpublished(dir: string, version: number): Promise<void> {
  for (const name of await names(path.join(dir, 'versions'))) {
    if (/^v\d+$/.test(name) && Number(name.slice(1)) > version) {
      await fs.rm(path.join(dir, 'versions', name), { recursive: true, force: true });
    }
  }
}

/** Startup only, before jobs are accepted. Staging is disposable even without an app job record. */
export async function recoverNoteStaging(dir: string): Promise<void> {
  await withProjectLock(dir, async () => {
    await fs.rm(path.join(dir, '.staging'), { recursive: true, force: true });
    let p;
    try { p = await loadProject(dir); } catch { return; }
    await removeUnpublished(dir, p.version);
  });
}

export type PublishStep = 'base' | 'assets' | 'credits' | 'version' | 'project' | 'append';

export class NoteTransaction {
  readonly versionDir: string;
  published = false;
  constructor(
    readonly liveDir: string,
    readonly dir: string,
    readonly txnId: string,
    private readonly base: string,
    private readonly signal?: AbortSignal,
  ) { this.versionDir = path.join(dir, 'version'); }

  private check(): void { if (this.signal?.aborted) throw cancelled(); }

  async discard(): Promise<void> { await fs.rm(this.dir, { recursive: true, force: true }); }

  /** Only this function publishes a note. The project rename makes the complete version visible. */
  async publish(entry: Omit<NoteEntry, 'version' | 'txnId'>, rules: string[] = [], style?: StyleStore,
    afterStep?: (step: PublishStep) => void): Promise<number> {
    return withProjectLock(this.liveDir, async () => {
      this.check();
      const file = path.join(this.liveDir, 'project.json');
      const live = await fs.readFile(file);
      if (hash(live) !== this.base) {
        await this.discard();
        throw new AIError('stale_note', 'Your video changed while I was working. Send your note again.');
      }
      const current = JSON.parse(live.toString('utf8'));
      const p = await loadProject(this.dir);
      const version = Number(current.version ?? 0) + 1;
      const destination = path.join(this.liveDir, 'versions', `v${version}`);
      p.version = version;
      const note: NoteEntry = { ...entry, version, txnId: this.txnId };
      // Prepare every version file before it is moved; published folders are never edited.
      await fs.access(path.join(this.versionDir, 'export.mp4'));
      await writeFileAtomic(path.join(this.versionDir, 'project.json'), JSON.stringify({ ...p, notes: [...p.notes, note] }, null, 2) + '\n');
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
        await writeFileAtomic(metadataFile, JSON.stringify(metadata, null, 2) + '\n');
      }
      await removeUnpublished(this.liveDir, Number(current.version ?? 0));
      afterStep?.('base');
      this.check();
      for (const folder of ['assets', 'thumbs']) {
        const staged = path.join(this.dir, 'work', folder);
        const dest = path.join(this.liveDir, 'work', folder);
        const existing = new Set(await names(dest));
        for (const name of await names(staged)) {
          if (folder === 'assets' && name === 'credits.json') continue;
          if (!name.startsWith(`${this.txnId}-`)) throw new Error(`Staged ${folder} file has no transaction prefix: ${name}`);
          await fs.mkdir(dest, { recursive: true });
          // The lock protects this check from same-app writers. Rename preserves the exact
          // mtime recorded in assets.json, so the next unchanged render reuses this version.
          if (existing.has(name)) throw new Error(`Asset already exists: ${name}`);
          await fs.rename(path.join(staged, name), path.join(dest, name));
        }
      }
      afterStep?.('assets');
      this.check();
      const credits = path.join(this.dir, 'work', 'assets', 'credits.json');
      let stagedCredits: Record<string, unknown> | undefined;
      try { stagedCredits = JSON.parse(await fs.readFile(credits, 'utf8')); } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
      if (stagedCredits) {
        const dest = path.join(this.liveDir, 'work', 'assets', 'credits.json');
        let prior: Record<string, unknown> = {};
        try { prior = JSON.parse(await fs.readFile(dest, 'utf8')); } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
        const additions = Object.fromEntries(Object.entries(stagedCredits).filter(([key]) => key.startsWith(`${this.txnId}-`)));
        if (Object.keys(additions).length) await writeFileAtomic(dest, JSON.stringify({ ...prior, ...additions }, null, 2) + '\n');
      }
      afterStep?.('credits');
      this.check();
      await fs.mkdir(path.join(this.liveDir, 'versions'), { recursive: true });
      await fs.rename(this.versionDir, destination);
      afterStep?.('version');
      const tmp = path.join(this.dir, 'published-project.json');
      await fs.writeFile(tmp, JSON.stringify(p, null, 2) + '\n');
      this.check();
      await fs.rename(tmp, file);
      this.published = true;
      afterStep?.('project');
      // Stop after the commit cannot undo the version. Complete its note record and preferences.
      for (const rule of rules) await style?.add(rule);
      p.notes = [...p.notes, note];
      await writeFileAtomic(file, JSON.stringify(p, null, 2) + '\n');
      afterStep?.('append');
      return version;
    });
  }
}

export async function beginNote(liveDir: string, signal?: AbortSignal): Promise<NoteTransaction> {
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
      await seedRenderCache(liveDir, dir, signal);
      if (signal?.aborted) throw cancelled();
      return new NoteTransaction(liveDir, dir, txnId, hash(bytes), signal);
    } catch (e) {
      await fs.rm(dir, { recursive: true, force: true });
      throw e;
    }
  });
}
