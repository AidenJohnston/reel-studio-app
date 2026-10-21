import { afterEach, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { beginNote, recoverNoteStaging, PublishStep } from '../src/note-staging';
import { createAI, loadProject, saveProject, AgentEvent } from '../src';
import { FakeHost, ScriptedModel, call, makeProject } from './helpers';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });

async function setup() {
  const project = await makeProject();
  roots.push(project.root);
  const p = await loadProject(project.dir);
  p.version = 1;
  await saveProject(project.dir, p);
  await fs.mkdir(path.join(project.dir, 'versions', 'v1'), { recursive: true });
  await fs.writeFile(path.join(project.dir, 'versions', 'v1', 'export.mp4'), 'old video');
  const before = await fs.readFile(path.join(project.dir, 'project.json'));
  return { ...project, before };
}

const note = { text: 'quieter music', applied: ['music'], at: '2026-10-21T00:00:00Z' };

it('does not render or publish an unchanged setter when the note reaches its step limit', async () => {
  const { dir, root, before } = await setup();
  expect((await loadProject(dir)).cut.gapCap).toBe(0.25);
  const host = new FakeHost(root);
  const provider = new ScriptedModel([{ toolCalls: [call('set_gap_cap', { seconds: 0.25 })] }]);
  const ai = createAI({ host, settingsDir: path.join(root, 'settings'), providerOverride: provider, maxSteps: 1 });
  const result = await ai.applyNote(dir, 'Adjust the pauses', () => {});
  expect(result.version).toBe(1);
  expect(result.changed).toEqual([]);
  expect(result.summary).toBe('Your video has not changed.');
  expect(host.calls.filter((c) => c.command === 'render')).toEqual([]);
  expect(await fs.readFile(path.join(dir, 'project.json'))).toEqual(before);
  expect(await fs.readdir(path.join(dir, 'versions'))).toEqual(['v1']);
  expect(await fs.readdir(path.join(dir, '.staging'))).toEqual([]);
});

it('streams distinct staged drafts while keeping final success behind publication and revoking playback before cleanup', async () => {
  const { dir, root, before } = await setup();
  const host = new FakeHost(root);
  const run = host.runEngine.bind(host);
  const draftFiles: string[] = [];
  const lifecycle: (string | null)[] = [];
  const events: AgentEvent[] = [];
  host.runEngine = async (command, args, progress) => {
    if (command !== 'render') return run(command, args, progress);
    expect(await fs.readFile(path.join(dir, 'project.json'))).toEqual(before);
    const result = await run(command, args, progress);
    const out = args[args.indexOf('--out') + 1];
    const file = path.join(out, args.includes('--draft') ? 'draft.mp4' : 'export.mp4');
    if (args.includes('--draft')) {
      await fs.writeFile(file, `draft ${draftFiles.length + 1}`);
      draftFiles.push(file);
      if (draftFiles.length === 2) expect(await fs.readFile(draftFiles[0], 'utf8')).toBe('draft 1');
    }
    return { ...result, file };
  };
  const provider = new ScriptedModel([
    { toolCalls: [call('set_caption_style', { size: 90 }), call('render_draft')] },
    { toolCalls: [call('set_caption_style', { size: 85 }), call('render_draft')] },
    { toolCalls: [call('finish', { summary_for_user: 'I made your captions smaller.' })] },
  ]);
  const ai = createAI({ host, settingsDir: path.join(root, 'settings'), providerOverride: provider });
  const result = await ai.applyNote(dir, 'Please adjust the caption size', (event) => {
    events.push(event);
    if (event.type !== 'render' && event.type !== 'reply') return;
    if (event.type === 'render' && event.draft) {
      expect(lifecycle).toHaveLength(1);
      expect(event.file).toBe(draftFiles.at(-1));
      expect(readFileSync(path.join(dir, 'project.json'))).toEqual(before);
    } else {
      expect(JSON.parse(readFileSync(path.join(dir, 'project.json'), 'utf8')).version).toBe(2);
      expect(existsSync(path.join(dir, 'versions', 'v2', 'export.mp4'))).toBe(true);
    }
  }, undefined, { onStaging(stage) {
    if (stage === null) expect(existsSync(String(lifecycle[0]))).toBe(true);
    else expect(existsSync(stage)).toBe(true);
    lifecycle.push(stage);
  } });
  expect(result.version).toBe(2);
  expect(new Set(draftFiles).size).toBe(2);
  expect(events.filter((event) => event.type === 'render').map((event) => event.draft)).toEqual([true, true, false]);
  expect(events.some((event) => event.type === 'tool' && event.name === 'set_caption_style')).toBe(true);
  expect(events.filter((event) => event.type === 'status').map((event) => event.message)).toEqual(expect.arrayContaining(['Reading your note', 'Making the new version']));
  expect(lifecycle).toEqual([expect.any(String), null]);
  expect(existsSync(String(lifecycle[0]))).toBe(false);
});

it('returns a playable draft-only result without publishing the proposed edit', async () => {
  const { dir, root, before } = await setup();
  const host = new FakeHost(root);
  const run = host.runEngine.bind(host);
  host.runEngine = async (command, args, progress) => {
    const result = await run(command, args, progress);
    if (command === 'render') {
      expect(args).toContain('--draft');
      return { ...result, file: path.join(args[args.indexOf('--out') + 1], 'draft.mp4') };
    }
    return result;
  };
  const ai = createAI({ host, settingsDir: path.join(root, 'settings'), providerOverride: new ScriptedModel([]) });
  const result = await ai.applyNote(dir, 'smaller captions', () => {}, undefined, { previewOnly: true });
  expect(result.previewFile).toBeDefined();
  roots.push(path.dirname(result.previewFile!));
  expect(await fs.readFile(result.previewFile!, 'utf8')).toBe('fake');
  expect(await fs.readFile(path.join(dir, 'project.json'))).toEqual(before);
  expect(await fs.readdir(path.join(dir, 'versions'))).toEqual(['v1']);
  expect(await fs.readdir(path.join(dir, '.staging'))).toEqual([]);
  expect(result.summary).toContain('Your video has not changed');
  expect(result.changed).toEqual([]);
});

it('stages a relative project path starting with a dash', async () => {
  const root = await fs.mkdtemp('-dash-project-');
  roots.push(path.resolve(root));
  const { dir } = await makeProject({ root });
  const before = await fs.readFile(path.join(dir, 'project.json'));
  const transcript = await fs.readFile(path.join(dir, 'work', 'transcript.json'));
  const txn = await beginNote(dir);
  expect(await fs.readFile(path.join(txn.dir, 'work', 'transcript.json'))).toEqual(transcript);
  expect(await fs.readFile(path.join(dir, 'project.json'))).toEqual(before);
  await txn.discard();
  expect(await fs.readdir(path.join(dir, '.staging'))).toEqual([]);
});

it('a failed final render leaves project bytes and the published video unchanged, with no success reply', async () => {
  const { dir, root, before } = await setup();
  const caches: Record<string, string> = {
    'render/voice.wav': 'voice', 'render/voice.sig': 'a'.repeat(40),
    'audio/mix-abc.wav': 'mix', 'audio/mix.json': '{}',
    'layers/clip-abc.mp4': 'clip', 'render/cover-cache/abc.png': 'cover',
    'face-s1.json': '{"samples": []}',
  };
  for (const [rel, data] of Object.entries(caches)) {
    const file = path.join(dir, 'work', rel);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, data);
    await fs.utimes(file, 1700000000, 1700000000);
  }
  await fs.writeFile(path.join(dir, 'work/layers/clip.part.mp4'), 'unfinished');
  const host = new FakeHost(root);
  host.failRender = true;
  const run = host.runEngine.bind(host);
  host.runEngine = async (command, args, progress) => {
    if (command === 'render') {
      const staged = path.dirname(args[args.indexOf('--project-file') + 1]);
      for (const [rel, data] of Object.entries(caches)) {
        const file = path.join(staged, 'work', rel);
        expect(await fs.readFile(file, 'utf8')).toBe(data);
        expect((await fs.stat(file)).mtimeMs).toBe(1700000000000);
      }
      await expect(fs.access(path.join(staged, 'work/layers/clip.part.mp4'))).rejects.toThrow();
      await fs.writeFile(path.join(staged, 'work/render/voice.wav'), 'changed staged voice');
    }
    return run(command, args, progress);
  };
  const events: AgentEvent[] = [];
  const lifecycle: (string | null)[] = [];
  const ai = createAI({ host, settingsDir: path.join(root, 'settings'), providerOverride: new ScriptedModel([]) });
  await expect(ai.applyNote(dir, 'smaller captions', (e) => events.push(e), undefined,
    { onStaging: (stage) => lifecycle.push(stage) })).rejects.toMatchObject({ code: 'RENDER_FAILED' });
  expect(await fs.readFile(path.join(dir, 'project.json'))).toEqual(before);
  expect(await fs.readFile(path.join(dir, 'versions', 'v1', 'export.mp4'), 'utf8')).toBe('old video');
  expect(await fs.readFile(path.join(dir, 'work/render/voice.wav'), 'utf8')).toBe('voice');
  expect(events.some((e) => e.type === 'reply' || e.type === 'render')).toBe(false);
  expect(await fs.readdir(path.join(dir, '.staging'))).toEqual([]);
  expect(lifecycle).toEqual([expect.any(String), null]);
});

it('a crash at each publish boundary exposes the old project or a complete new version', async () => {
  const boundaries: PublishStep[] = ['base', 'assets', 'credits', 'version', 'project', 'append'];
  for (const boundary of boundaries) {
    const { dir, before } = await setup();
    const txn = await beginNote(dir);
    const asset = `${txn.txnId}-image.png`;
    const p = await loadProject(txn.dir);
    p.music.level = 'quiet';
    await saveProject(txn.dir, p);
    await fs.writeFile(path.join(txn.dir, 'work', 'assets', asset), 'new image');
    await fs.writeFile(path.join(txn.dir, 'work', 'assets', 'credits.json'), JSON.stringify({ [asset]: { attribution: 'Photographer' } }));
    await fs.mkdir(txn.versionDir);
    await fs.writeFile(path.join(txn.versionDir, 'export.mp4'), 'new video');
    await fs.writeFile(path.join(txn.versionDir, 'render.json'), JSON.stringify({ file: path.join(txn.versionDir, 'export.mp4'), versionDir: txn.versionDir, version: 2 }));
    await expect(txn.publish(note, [], undefined, (step) => {
      if (step === boundary) throw new Error('simulated process crash');
    })).rejects.toThrow('simulated process crash');
    await recoverNoteStaging(dir);
    const live = await loadProject(dir);
    if (boundary === 'project' || boundary === 'append') {
      expect(live.version).toBe(2);
      expect(live.music.level).toBe('quiet');
      expect(await fs.readFile(path.join(dir, 'versions', 'v2', 'export.mp4'), 'utf8')).toBe('new video');
      expect(JSON.parse(await fs.readFile(path.join(dir, 'versions', 'v2', 'project.json'), 'utf8')).version).toBe(2);
      expect(JSON.parse(await fs.readFile(path.join(dir, 'versions', 'v2', 'render.json'), 'utf8')).file).toBe(path.join(dir, 'versions', 'v2', 'export.mp4'));
      expect(await fs.readFile(path.join(dir, 'work', 'assets', asset), 'utf8')).toBe('new image');
    } else {
      expect(await fs.readFile(path.join(dir, 'project.json'))).toEqual(before);
      await expect(fs.access(path.join(dir, 'versions', 'v2'))).rejects.toThrow();
    }
    expect(await fs.readFile(path.join(dir, 'versions', 'v1', 'export.mp4'), 'utf8')).toBe('old video');
  }
});

it('Stop during render waits for the in-flight render before deleting staging and preserves the project', async () => {
  const { dir, root, before } = await setup();
  const controller = new AbortController();
  let release!: () => void;
  let started!: () => void;
  const rendering = new Promise<void>((resolve) => { started = resolve; });
  const exited = new Promise<void>((resolve) => { release = resolve; });
  const host = new FakeHost(root);
  const run = host.runEngine.bind(host);
  host.runEngine = async (command, args, progress) => {
    if (command !== 'render') return run(command, args, progress);
    started();
    await exited;
    // An engine that completes just after Stop still cannot publish.
    return run(command, args, progress);
  };
  const ai = createAI({ host, settingsDir: path.join(root, 'settings'), providerOverride: new ScriptedModel([]) });
  let settled = false;
  const lifecycle: (string | null)[] = [];
  const result = ai.applyNote(dir, 'smaller captions', () => {}, controller.signal,
    { onStaging: (stage) => lifecycle.push(stage) }).finally(() => { settled = true; });
  const rejected = expect(result).rejects.toMatchObject({ code: 'cancelled' });
  await rendering;
  controller.abort();
  await Promise.resolve();
  expect(settled).toBe(false);
  expect((await fs.readdir(path.join(dir, '.staging'))).length).toBe(1);
  release();
  await rejected;
  expect(await fs.readFile(path.join(dir, 'project.json'))).toEqual(before);
  expect(await fs.readdir(path.join(dir, '.staging'))).toEqual([]);
  expect(lifecycle).toEqual([expect.any(String), null]);
});

it('a stale base refuses to publish without overwriting the newer manual edit', async () => {
  const { dir } = await setup();
  const txn = await beginNote(dir);
  const p = await loadProject(dir);
  p.title = 'A manual edit';
  await saveProject(dir, p);
  const edited = await fs.readFile(path.join(dir, 'project.json'));
  await expect(txn.publish(note)).rejects.toMatchObject({ code: 'stale_note', userMessage: 'Your video changed while I was working. Send your note again.' });
  expect(await fs.readFile(path.join(dir, 'project.json'))).toEqual(edited);
  await expect(fs.access(txn.dir)).rejects.toThrow();
});

it('a rerender immediately after publishing a new asset reuses the published version', async () => {
  const { dir } = await setup();
  const txn = await beginNote(dir);
  const asset = `work/assets/${txn.txnId}-song.wav`;
  const p = await loadProject(txn.dir);
  p.music.track = asset;
  await saveProject(txn.dir, p);
  await fs.writeFile(path.join(txn.dir, asset), 'new song');
  // An older timestamp makes a copy-created mtime reliably differ, even on coarse filesystems.
  await fs.utimes(path.join(txn.dir, asset), 1700000000, 1700000000);
  await fs.mkdir(txn.versionDir);
  await fs.writeFile(path.join(txn.versionDir, 'export.mp4'), 'new video');
  const python = process.env.REELENGINE_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
  const engine = (code: string) => execFileSync(python, ['-c', code, dir, txn.dir], {
    env: { ...process.env, PYTHONPATH: path.resolve(__dirname, '../../engine') }, encoding: 'utf8',
  }).trim();
  engine(`from pathlib import Path
import sys
from reelengine import project, render
live, stage = map(Path, sys.argv[1:])
project.write_json(stage / 'version/assets.json', render.asset_fingerprint(live, project.load(stage), staged_dir=stage))`);
  await txn.publish(note);
  await txn.discard();
  // This is the version selection used by the next manual render, including its asset check.
  expect(engine(`from pathlib import Path
import sys
from reelengine import project, render
live = Path(sys.argv[1])
print(render.pick_version(live, project.load(live)))`)).toBe('2');
});
