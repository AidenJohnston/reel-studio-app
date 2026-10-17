// Live end-to-end follow-ups (2026-10-17): animations are not cards, animation text must
// be readable, frames of an animation are sampled at its settled end.
import { describe, it, expect } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { executeTool, newToolState, loadProject, StyleStore, ToolContext } from '../src';
import { estimateHeroPx, chooseReadableLayout, minHeroPx } from '../src/readable';
import { FakeHost, makeProject } from './helpers';

/** FakeHost whose animations carry the renderer's real `.anim.json` sidecar. */
class AnimHost extends FakeHost {
  async renderAnimation(template: string, params: Record<string, unknown>, outPath: string): Promise<string> {
    this.animations.push({ template, params, out: outPath });
    await fsp.writeFile(outPath, 'fake animation');
    await fsp.writeFile(outPath.replace(/\.mov$/, '.anim.json'), JSON.stringify({
      kind: 'reelstudio-animation', version: 1, template, params, duration: 3, layout: params.layout ?? 'top',
    }));
    return outPath;
  }
}

async function ctxFor() {
  const { root, dir } = await makeProject();
  const host = new AnimHost(root);
  const ctx: ToolContext = { projectDir: dir, host, style: new StyleStore(() => root), emit: () => undefined, state: newToolState(), supportsImages: true };
  return { ctx, host, dir };
}

const nullP = { side: null, tilt: null, scale: null, text: null, iconic: null };

async function addCountUp(ctx: ToolContext, text = 'people signed up') {
  const r = await executeTool(ctx, 'add_broll', {
    anchor: { from: 'w29', to: 'w30' }, treatment: 'card-above-head', asset: null, search: null,
    animation: { template: 'stat-count-up', params: { value: '20', text } }, params: nullP,
  });
  expect(r.isError, r.content).toBe(false);
  return JSON.parse(r.content);
}

describe('e2e (a): an animation is never "moved to the side"', () => {
  it('add_broll tells the model how animations are placed', async () => {
    const { ctx } = await ctxFor();
    const r = await addCountUp(ctx);
    expect(r.placement).toMatch(/cannot sit beside the face/);
  });

  it('asking to move it beside the face is refused plainly and nothing changes', async () => {
    const { ctx, dir, host } = await ctxFor();
    await addCountUp(ctx);
    const before = (await loadProject(dir)).broll[0];
    const r = await executeTool(ctx, 'update_broll', { id: 'b1', anchor: null, treatment: 'side-card', asset: null, params: { ...nullP, side: 'left' } });
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/cannot be moved like a card/);
    expect(r.content).toMatch(/never say it moved/);
    expect((await loadProject(dir)).broll[0]).toEqual(before);
    expect(host.animations).toHaveLength(1);
  });

  it('"make it full screen" re-renders the animation with layout full', async () => {
    const { ctx, dir, host } = await ctxFor();
    const first = (await addCountUp(ctx)).asset;
    const r = await executeTool(ctx, 'update_broll', { id: 'b1', anchor: null, treatment: 'full-frame', asset: null, params: null });
    expect(r.isError, r.content).toBe(false);
    expect(host.animations).toHaveLength(2);
    expect(host.animations[1].params.layout).toBe('full');
    const b = (await loadProject(dir)).broll[0];
    expect(b.treatment).toBe('animation');
    expect(b.asset).not.toBe(first);
    expect(b.asset).toMatch(/^work\/assets\/anim-stat-count-up-2\.mov$/);
    expect(r.summary).toMatch(/fill the screen/);
  });
});

describe('e2e (b): animation text is readable', () => {
  it('the estimate follows the templates (big region = big number; tiny region = tiny number)', () => {
    expect(estimateHeroPx('stat-count-up', { value: '9', text: 'days' }, { w: 1004, h: 650 })).toBeGreaterThan(250);
    expect(estimateHeroPx('stat-count-up', { value: '9', text: 'people who signed up for the beta in the first week' }, { w: 300, h: 160 })!).toBeLessThan(minHeroPx('stat-count-up'));
  });

  it('too small above the face -> full screen; too long even full screen -> refused', () => {
    const small = chooseReadableLayout('stat-count-up', { value: '9', text: 'people who signed up for the beta in the first week' }, { w: 300, h: 160 }, 'top');
    expect(small.switched).toBe(true);
    expect(small.layout).toBe('full');
    expect(small.heroPx!).toBeGreaterThanOrEqual(minHeroPx('stat-count-up'));
    const essay = chooseReadableLayout('big-quote', { text: 'word '.repeat(220) }, { w: 1004, h: 650 }, 'top');
    expect(essay.tooLong).toBe(true);
  });

  it('make_animation in a cramped region renders full screen and says why', async () => {
    const { ctx, host } = await ctxFor();
    const run = host.runEngine.bind(host);
    host.runEngine = async (cmd: string, args: string[], ...rest: any[]) => cmd === 'anim-context'
      ? { t0: 1, layout: 'top', region: { x: 760, y: 200, w: 300, h: 160 }, words: [] } : run(cmd, args, ...rest);
    const r = JSON.parse((await executeTool(ctx, 'make_animation', {
      template: 'stat-count-up', params: { value: '9', text: 'people who signed up for the beta in the first week' }, anchor: { from: 'w29', to: 'w30' },
    })).content);
    expect(r.layout).toBe('full');
    expect(r.readable.note).toMatch(/full screen/);
    expect(host.animations[0].params.region).toBeUndefined();
  });
});

describe('e2e: frames of an animation are sampled at its settled end', () => {
  it('a time inside an animation window moves to its end', async () => {
    const { ctx, dir, host } = await ctxFor();
    await executeTool(ctx, 'render_draft', {});
    await fsp.mkdir(path.join(dir, 'work', 'layers'), { recursive: true });
    await fsp.writeFile(path.join(dir, 'work', 'layers', 'layers.json'), JSON.stringify({ items: [{ id: 'b1', treatment: 'animation', t0: 4.0, t1: 7.5 }] }));
    const r = JSON.parse((await executeTool(ctx, 'look_at_frames', { times: [5.0, 9.0], words: null })).content);
    const asked = host.calls.find((c) => c.command === 'frames')!.args;
    expect(asked[asked.indexOf('--times') + 1]).toBe('7.35,9');
    expect(r.animationsSampledAtEnd).toEqual([{ asked: 5, sampled: 7.35, id: 'b1' }]);
  });
});
