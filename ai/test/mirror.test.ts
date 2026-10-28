// A mirrored take (front camera: posters and shirts read backwards): the editor flips it with
// set_mirror, from what it SEES in the frames or from the user's note, and can undo it.
import { describe, it, expect } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { createAI, executeTool, loadProject, newToolState, Prompts, StyleStore, ToolContext, AgentEvent } from '../src';
import { saveProject } from '../src/project';
import { FakeHost, ScriptedModel, call, makeProject, tmpDir } from './helpers';

async function ctxFor(): Promise<{ ctx: ToolContext; dir: string; events: AgentEvent[] }> {
  const { root, dir } = await makeProject();
  const events: AgentEvent[] = [];
  const ctx: ToolContext = { projectDir: dir, host: new FakeHost(root), style: new StyleStore(() => root), emit: (e) => events.push(e), state: newToolState(), supportsImages: true };
  return { ctx, dir, events };
}

describe('set_mirror', () => {
  it('flips every take, says so in plain words, and shows in get_project', async () => {
    const { ctx, dir, events } = await ctxFor();
    const before = JSON.parse((await executeTool(ctx, 'get_project', {})).content);
    expect(before.sources[0].mirror).toBe(false);                      // an old project: absent = as shot
    const r = await executeTool(ctx, 'set_mirror', { on: true, source: null });
    expect(r.isError).toBe(false);
    expect(r.summary).toBe('Flipped your video (it was mirrored)');
    expect(events).toContainEqual({ type: 'tool', name: 'set_mirror', summary: 'Flipped your video (it was mirrored)' });
    expect((await loadProject(dir)).sources.every((s) => s.mirror === true)).toBe(true);
    expect(JSON.parse((await executeTool(ctx, 'get_project', {})).content).sources[0].mirror).toBe(true);
    expect(ctx.state.changed.has('mirror')).toBe(true);
  });

  it('a flip is a visible change: the next preview is really made', async () => {
    const { ctx } = await ctxFor();
    await executeTool(ctx, 'render_draft', {});
    expect(JSON.parse((await executeTool(ctx, 'render_draft', {})).content).skipped).toMatch(/Nothing visible/);
    await executeTool(ctx, 'set_mirror', { on: true, source: null });
    const rd = JSON.parse((await executeTool(ctx, 'render_draft', {})).content);
    expect(rd.skipped).toBeUndefined();
    expect(ctx.state.renders).toHaveLength(2);
  });

  it('undo removes the flag (the project is as it was), one take only when asked', async () => {
    const { ctx, dir } = await ctxFor();
    const p = await loadProject(dir);
    p.sources.push({ ...p.sources[0], id: 's2' });
    await saveProject(dir, p);
    await executeTool(ctx, 'set_mirror', { on: true, source: 's2' });
    let q = await loadProject(dir);
    expect(q.sources.map((s) => s.mirror ?? null)).toEqual([null, true]);
    await executeTool(ctx, 'set_mirror', { on: true, source: null });
    const off = await executeTool(ctx, 'set_mirror', { on: false, source: null });
    expect(off.summary).toBe('Put your video back the way you filmed it');
    q = await loadProject(dir);
    expect(q.sources.every((s) => !('mirror' in s))).toBe(true);
    const bad = await executeTool(ctx, 'set_mirror', { on: true, source: 's9' });
    expect(bad.isError).toBe(true);
    expect(bad.content).toMatch(/unknown source s9/);
    expect((await executeTool(ctx, 'set_mirror', { on: 'yes', source: null })).isError).toBe(true);
  });

  it('the prompts tell the editor when to flip, when not to, and how to say it', () => {
    const pr = new Prompts();
    const sys = pr.raw('system');
    expect(sys).toMatch(/set_mirror/);
    expect(sys).toMatch(/never the captions or the pictures you added/);
    expect(sys).toMatch(/never the face/);
    expect(sys).toMatch(/No readable text in the room: leave it alone/);
    expect(pr.raw('firstEdit')).toMatch(/set_mirror with on true/);
    expect(pr.raw('applyNote')).toMatch(/mirrored.*set_mirror with on true/s);
    expect(pr.raw('applyNote')).toMatch(/flip it back.*set_mirror with on false/s);
    for (const n of ['system', 'firstEdit', 'applyNote'] as const) expect(pr.raw(n)).not.toMatch(/—/);
  });
});

describe('a note about a mirrored video', () => {
  it('goes to the editor, which flips it and says so', async () => {
    const { root, dir } = await makeProject();
    const host = new FakeHost(root);
    const model = new ScriptedModel([
      { toolCalls: [call('get_project'), call('get_transcript')] },
      { toolCalls: [call('set_mirror', { on: true, source: null }), call('render_draft')] },
      { toolCalls: [call('look_at_frames', { times: [1], words: null })] },
      { toolCalls: [call('finish', { summary_for_user: 'Your video was mirrored, so I flipped it so the writing reads the right way.' })] },
    ]);
    const ai = createAI({ host, settingsDir: tmpDir('settings '), providerOverride: model });
    const r = await ai.applyNote(dir, 'my video is mirrored, the poster behind me is backwards', () => {});
    expect(r.fast).toBeUndefined();                       // never the no-AI fast path
    expect(r.changed).toContain('mirror');
    expect(r.summary).toMatch(/mirrored, so I flipped it/);
    const p = await loadProject(dir);
    expect(p.sources[0].mirror).toBe(true);
    expect(p.notes.at(-1)!.applied).toContain('mirror');
    // the note's task text carries the rule that maps it to the tool
    const task = JSON.stringify(model.requests[0].messages[0]);
    expect(task).toMatch(/set_mirror with on true/);
    expect(await fsp.readFile(path.join(dir, 'project.json'), 'utf8')).toMatch(/"mirror": true/);
  });
});
