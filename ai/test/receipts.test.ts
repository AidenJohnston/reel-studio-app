import { expect, it } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { createAI, executeTool, loadProject, newToolState, Project, saveProject, StyleStore, ToolContext } from '../src';
import { call, FakeHost, makeProject, ScriptedModel, tmpDir } from './helpers';

it('fails if look_at_frames looks at the newer final render instead of its own preview, or at later layers', async () => {
  const { root, dir } = await makeProject();
  const host = new FakeHost(root);
  const ctx: ToolContext = { projectDir: dir, host, style: new StyleStore(() => root), emit: () => undefined, state: newToolState(), supportsImages: true };
  await executeTool(ctx, 'render_draft', {});
  const own = ctx.state.renders[0].result.renderId;
  await fsp.mkdir(path.join(dir, 'work', 'layers'), { recursive: true });
  await fsp.writeFile(path.join(dir, 'work', 'layers', 'layers.json'), JSON.stringify({ items: [{ id: 'later', treatment: 'animation', t0: 0, t1: 10 }] }));
  await host.runEngine('render', ['--project', dir]);
  const r = await executeTool(ctx, 'look_at_frames', { times: [1], words: null });
  expect(r.isError, String(r.content)).toBe(false);
  const asked = host.calls.find((c) => c.command === 'frames')!.args;
  expect(asked).toEqual(expect.arrayContaining(['--render-id', own, '--times', '1']));
});

it("fails if a note's receipt is not the final render's, recorded under the app's job", async () => {
  const { root, dir } = await makeProject();
  const host = new FakeHost(root);
  const renders: any[] = [];
  const run = host.runEngine.bind(host);
  host.runEngine = async (command, args, onProgress, signal) => {
    const r = await run(command, args, onProgress, signal);
    if (command === 'render') renders.push(r);
    return r;
  };
  const model = new ScriptedModel([
    { toolCalls: [call('set_cut', { keep: [{ from: 'w16', to: 'w56' }] }), call('set_caption_style', { size: 84 }), call('render_draft')] },
    { toolCalls: [call('finish', { summary_for_user: 'I kept your second take and made the captions smaller.' })] },
  ]);
  const ai = createAI({ host, settingsDir: tmpDir('settings '), providerOverride: model });
  await ai.applyNote(dir, 'keep the second take and smaller captions', () => {}, undefined, { jobId: 'job-1' });
  const [draft, final] = renders;
  expect([draft.draft, final.draft]).toEqual([true, false]);
  const note = (await loadProject(dir)).notes.at(-1)!;
  expect(note.receipt).toEqual(final.receipt);
  expect(note.receipt).toMatchObject({ jobId: 'job-1', renderId: final.renderId });
});

it('fails if a change the AI made and then took back is reported or rendered as a new version', async () => {
  const { root, dir } = await makeProject();
  const gap = (await loadProject(dir)).cut.gapCap;
  const host = new FakeHost(root);
  const model = new ScriptedModel([
    { toolCalls: [call('set_gap_cap', { seconds: 0.1 }), call('render_draft')] },
    { toolCalls: [call('set_gap_cap', { seconds: gap })] },
    { toolCalls: [call('finish', { summary_for_user: 'I tightened your pauses.' })] },
  ]);
  const ai = createAI({ host, settingsDir: tmpDir('settings '), providerOverride: model });
  const r = await ai.applyNote(dir, 'try tighter pauses', () => {});
  expect(r.summary).toBe("That left your video the same as before, so I didn't make a new version.");
  expect(r.changed).toEqual([]);
  expect(r).not.toHaveProperty('version');
  expect(host.calls.filter((c) => c.command === 'render' && !c.args.includes('--draft'))).toEqual([]);
});

it('fails if a note the AI took back is missing from the notes, or is filed under a version', async () => {
  const { root, dir } = await makeProject();
  const gap = (await loadProject(dir)).cut.gapCap;
  const model = new ScriptedModel([
    { toolCalls: [call('set_gap_cap', { seconds: 0.1 })] },
    { toolCalls: [call('set_gap_cap', { seconds: gap })] },
    { toolCalls: [call('finish', { summary_for_user: 'I tightened your pauses.' })] },
  ]);
  const ai = createAI({ host: new FakeHost(root), settingsDir: tmpDir('settings '), providerOverride: model });
  await ai.applyNote(dir, ' try tighter pauses ', () => {});
  const notes = (await loadProject(dir)).notes;
  expect(notes).toEqual([{ text: 'try tighter pauses', applied: [], at: expect.any(String) }]);
});

it('fails if a note the AI took back leaves its discarded edit in the only preview the app plays', async () => {
  const { root, dir } = await makeProject();
  const p = await loadProject(dir);
  p.cut.keep = [{ from: 'w0', to: 'w56' }];
  await saveProject(dir, p);
  const host = new FakeHost(root);
  const madeFrom = new Map<string, Project>();   // render id -> the project it was made from
  const run = host.runEngine.bind(host);
  host.runEngine = async (command, args, onProgress, signal) => {
    const before = await loadProject(dir);
    const r = await run(command, args, onProgress, signal);
    if (command === 'render') madeFrom.set(r.renderId, before);
    return r;
  };
  // the first edit's final render failed: the project has a preview and no vN
  await host.runEngine('render', ['--project', dir, '--draft']);
  const model = new ScriptedModel([
    { toolCalls: [call('set_cut', { keep: [{ from: 'w16', to: 'w56' }] }), call('render_draft')] },
    { toolCalls: [call('set_cut', { keep: [{ from: 'w0', to: 'w56' }] })] },
    { toolCalls: [call('finish', { summary_for_user: 'I cut the intro.' })] },
  ]);
  const ai = createAI({ host, settingsDir: tmpDir('settings '), providerOverride: model });
  await ai.applyNote(dir, 'try cutting the intro', () => {});
  const shown = JSON.parse(await fsp.readFile(path.join(dir, 'versions', 'preview', 'render_draft.json'), 'utf8')).renderId;
  expect(madeFrom.get(shown)?.cut.keep).toEqual([{ from: 'w0', to: 'w56' }]);
});

it('fails if a note whose final render failed records the fallback preview as its version receipt', async () => {
  const { root, dir } = await makeProject();
  const host = new FakeHost(root);
  const model = new ScriptedModel([
    { toolCalls: [call('set_cut', { keep: [{ from: 'w16', to: 'w56' }] }), call('render_draft')] },
    () => { host.failRender = true; return { toolCalls: [call('finish', { summary_for_user: 'I kept your second take.' })] }; },
  ]);
  const ai = createAI({ host, settingsDir: tmpDir('settings '), providerOverride: model });
  await ai.applyNote(dir, 'keep the second take', () => {}, undefined, { jobId: 'job-2' });
  expect((await loadProject(dir)).notes.at(-1)!.receipt).toBeUndefined();
});

it("fails if the AI's view of the project carries every note's receipt", async () => {
  const { root, dir } = await makeProject();
  const p = await loadProject(dir);
  const facts = [{ kind: 'cut.keep', before: [{ from: 'w0', to: 'w56' }], after: [{ from: 'w16', to: 'w56' }] }];
  p.notes = [{ version: 1, text: 'keep the second take', applied: ['cut'], at: '2026-10-22T00:00:00Z', receipt: { jobId: 'job-1', renderId: 'r_1', version: 1, facts } }];
  await saveProject(dir, p);
  const ctx: ToolContext = { projectDir: dir, host: new FakeHost(root), style: new StyleStore(() => root), emit: () => undefined, state: newToolState(), supportsImages: true };
  const view = JSON.parse((await executeTool(ctx, 'get_project', {})).content);
  expect(view.notes).toEqual([{ version: 1, text: 'keep the second take', applied: ['cut'], at: '2026-10-22T00:00:00Z' }]);
});

it('fails if look_at_frames on a project rendered before render ids gives up instead of making a preview', async () => {
  const { root, dir } = await makeProject();
  const p = await loadProject(dir);
  p.version = 1;
  await saveProject(dir, p);
  await fsp.mkdir(path.join(dir, 'versions', 'v1'), { recursive: true });
  await fsp.writeFile(path.join(dir, 'versions', 'v1', 'render.json'), JSON.stringify({ version: 1, file: 'export.mp4' }));
  const host = new FakeHost(root);
  const ctx: ToolContext = { projectDir: dir, host, style: new StyleStore(() => root), emit: () => undefined, state: newToolState(), supportsImages: true };
  await executeTool(ctx, 'write_post', { caption: 'Bread', hashtags: ['a', 'b', 'c', 'd', 'e'], keywords: [] });
  expect(JSON.parse((await executeTool(ctx, 'render_draft', {})).content).skipped).toBeTruthy();
  const r = await executeTool(ctx, 'look_at_frames', { times: [1], words: null });
  expect(r.isError, String(r.content)).toBe(false);
  const draft = ctx.state.renders.at(-1)!;
  expect(draft.draft).toBe(true);
  expect(host.calls.find((c) => c.command === 'frames')!.args).toEqual(expect.arrayContaining(['--render-id', draft.result.renderId]));
});

it('fails if a took-back note that saved a My style rule makes or names a version', async () => {
  const { root, dir } = await makeProject();
  const gap = (await loadProject(dir)).cut.gapCap;
  const model = new ScriptedModel([
    { toolCalls: [call('set_gap_cap', { seconds: 0.1 }), call('add_style_rule', { rule: 'Keep my pauses as they are.' })] },
    { toolCalls: [call('set_gap_cap', { seconds: gap })] },
    { toolCalls: [call('finish', { summary_for_user: 'I tightened your pauses.' })] },
  ]);
  const ai = createAI({ host: new FakeHost(root), settingsDir: tmpDir('settings '), providerOverride: model });
  const r = await ai.applyNote(dir, 'from now on keep my pauses as they are', () => {});
  expect(r).not.toHaveProperty('version');
  expect(r.styleRulesAdded).toEqual(['Keep my pauses as they are.']);
  expect(r.summary).toMatch(/^That left your video the same as before, so I didn't make a new version\. I also saved this to My style/);
  expect((await loadProject(dir)).notes.map((n) => n.version)).toEqual([undefined]);
});
