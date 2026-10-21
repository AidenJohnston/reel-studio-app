import { afterEach, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { beginNote } from '../src/note-staging';
import { loadProject, saveProject } from '../src/project';
import { makeProject } from './helpers';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });

async function write(root: string, rel: string, data: string): Promise<void> {
  const file = path.join(root, rel);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, data);
  await fs.utimes(file, 1700000000, 1700000000);
}

it('publishes new cache keys for manual renders and seeds the next note without changing existing keys', async () => {
  const { root, dir } = await makeProject();
  roots.push(root);
  const prior: Record<string, string> = {
    'work/render/voice.wav': 'old voice', 'work/render/voice.sig': 'a'.repeat(40),
    'work/layers/clip-abc.mp4': 'old layer', 'work/audio/mix.json': '{"duration": 1}',
  };
  for (const [rel, data] of Object.entries(prior)) await write(dir, rel, data);
  const txn = await beginNote(dir);
  expect(await fs.readFile(path.join(txn.dir, 'work/render/voice.wav'), 'utf8')).toBe('old voice');
  const project = await loadProject(txn.dir);
  project.cut.keep = [{ from: 'w0', to: 'w8' }];
  await saveProject(txn.dir, project);
  const generated = {
    'work/render/voice.wav': 'new cut voice', 'work/render/voice.sig': 'b'.repeat(40),
    'work/audio/mix-abc.wav': 'new mix', 'work/audio/mix.json': '{"duration": 2}',
    'work/face-s1.json': '{"samples": []}', 'work/layers/clip-abc.mp4': 'layer',
    'work/render/cover-cache/abc.png': 'cover',
    'work/cache/search-credits.json': '{"https://example.test/image": {"creator": "A"}}',
    'work/cache/simple-icons.json': '{"icons": []}', 'work/cache/wikidata.json': '{}',
    'work/cache/music-analysis/0123456789abcdef0123456789abcdef.json': '{"bpm": 92}',
    'work/cache/encoder-probe.json': '{}',
    'work/cache/yt-dlp/youtube-sts/player.json': '{"yt-dlp_version": "2026.08.19", "data": 123}',
  };
  for (const [rel, data] of Object.entries(generated)) await write(txn.dir, rel, data);
  const scratch = ['work/layers/clip.part.mp4', 'work/layers/clip-mask.png',
    'work/layers/layers.json', 'work/render/voice.graph.txt',
    'work/cache/music-analysis/0123456789abcdef0123456789abcdef.9.part',
    'work/cache/yt-dlp/youtube-sts/player.json.9.tmp'];
  for (const rel of scratch) await write(txn.dir, rel, 'unfinished');
  await write(txn.versionDir, 'export.mp4', 'new video');
  await write(txn.versionDir, 'notes.md', 'Note: trim the intro\n\nTrimmed.\n');
  expect(existsSync(path.join(dir, 'work/audio/mix-abc.wav'))).toBe(false);
  await txn.publish({ text: 'trim the intro', applied: ['cut'], at: '2026-10-21T00:00:00Z' }, [], undefined, (step) => {
    if (step === 'append') expect(existsSync(path.join(dir, 'work/audio/mix-abc.wav'))).toBe(false);
  });
  expect(await fs.readFile(path.join(dir, 'versions/v1/notes.md'), 'utf8')).toBe('# v1\n\nNote: trim the intro\n\nTrimmed.\n');
  const snapshot = path.join(dir, 'versions/v1/.cache');
  for (const [rel, data] of Object.entries(generated)) {
    expect(await fs.readFile(path.join(snapshot, rel), 'utf8')).toBe(data);
    await expect(fs.access(path.join(txn.dir, rel))).rejects.toThrow();
    expect(await fs.readFile(path.join(dir, rel), 'utf8')).toBe(prior[rel] ?? data);
    expect((await fs.stat(path.join(dir, rel))).mtimeMs).toBe(1700000000000);
  }
  for (const rel of scratch) {
    await expect(fs.access(path.join(snapshot, rel))).rejects.toThrow();
    await expect(fs.access(path.join(dir, rel))).rejects.toThrow();
  }
  await expect(fs.access(path.join(snapshot, 'work/transcript.json'))).rejects.toThrow();
  await txn.discard();

  const next = await beginNote(dir);
  expect((await loadProject(next.dir)).cut.keep).toEqual(project.cut.keep);
  for (const [rel, data] of Object.entries(generated)) {
    expect(await fs.readFile(path.join(next.dir, rel), 'utf8')).toBe(data);
    expect((await fs.stat(path.join(next.dir, rel))).mtimeMs).toBe(1700000000000);
  }
  await fs.writeFile(path.join(next.dir, 'work/render/voice.wav'), 'another staged change');
  await next.discard();
  expect(await fs.readFile(path.join(snapshot, 'work/render/voice.wav'), 'utf8')).toBe('new cut voice');
  for (const [rel, data] of Object.entries(prior)) expect(await fs.readFile(path.join(dir, rel), 'utf8')).toBe(data);
  expect(await fs.readFile(path.join(dir, 'work/audio/mix-abc.wav'), 'utf8')).toBe('new mix');
});
