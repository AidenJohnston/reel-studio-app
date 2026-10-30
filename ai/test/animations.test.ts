import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { ANIMATION_TEMPLATES, ENGINE_FED, alignWordTimes, itemTimes } from '../src/animations';
import { executeTool, newToolState, toolByName, ToolContext } from '../src/tools';
import { loadProject, saveProject } from '../src/project';
import { StyleStore } from '../src/style';
import { FakeHost, makeProject, tinyPng } from './helpers';

const templatesDir = path.resolve(__dirname, '..', '..', 'templates', 'animations');

async function ctxFor() {
  const { root, dir } = await makeProject();
  const host = new FakeHost(root);
  const ctx: ToolContext = { projectDir: dir, host, style: new StyleStore(() => root), emit: () => {}, state: newToolState(), supportsImages: true };
  return { ctx, host, dir, root };
}

describe('make_animation schema comes from the templates', () => {
  it('generated file matches templates/animations/*/meta.json', () => {
    execFileSync(process.execPath, [path.resolve(__dirname, '..', 'scripts', 'gen-animations.mjs'), '--check']);
  });

  it('lists every template and every param the AI may set (incl. logo-pop image)', () => {
    const ids = fs.readdirSync(templatesDir).filter((d) => fs.existsSync(path.join(templatesDir, d, 'meta.json')));
    const tool = toolByName('make_animation')!;
    const props = (tool.parameters as any).properties;
    expect([...props.template.enum].sort()).toEqual(ids.sort());
    for (const id of ids) {
      const meta = JSON.parse(fs.readFileSync(path.join(templatesDir, id, 'meta.json'), 'utf8'));
      for (const k of Object.keys(meta.params.properties)) {
        if (ENGINE_FED.has(k)) expect(props.params.properties[k]).toBeUndefined();
        else expect(props.params.properties[k], `${id}.${k}`).toBeDefined();
      }
    }
    expect(props.params.properties.image.description).toMatch(/logo-pop/);
    expect(props.anchor).toBeDefined();
    expect(ANIMATION_TEMPLATES.length).toBe(ids.length);
  });
});

describe('word timing', () => {
  const words = [{ w: 'Done', t: 0.13, e: 0.4 }, { w: 'is', t: 0.45, e: 0.55 }, { w: 'better', t: 0.6, e: 0.9 },
    { w: 'than', t: 0.95, e: 1.1 }, { w: 'perfect.', t: 1.2, e: 1.6 }];
  it('lands each quote word on its spoken word', () => {
    expect(alignWordTimes('Done is better than perfect', words)).toEqual([0.13, 0.45, 0.6, 0.95, 1.2]);
  });
  it('places an unmatched word between its neighbours and never goes backwards', () => {
    const wt = alignWordTimes('Done is WAY better than perfect', words);
    expect(wt.length).toBe(6);
    expect(wt[2]).toBeGreaterThan(0.45);
    expect(wt[2]).toBeLessThan(0.6);
    expect([...wt].sort((a, b) => a - b)).toEqual(wt);
  });
  it('matches a written number the recogniser split in two', () => {
    const ws = [{ w: 'has', t: 0.1 }, { w: '3', t: 0.4 }, { w: ',000', t: 0.6 }, { w: 'users', t: 0.9 }];
    expect(alignWordTimes('has 3,000 users', ws)).toEqual([0.1, 0.4, 0.9]);
  });
  it('lands list items on the word that names them', () => {
    expect(itemTimes(['Better', 'Perfect'], words)).toEqual([0.6, 1.2]);
  });
});

describe('make_animation', () => {
  it('fails if the project frame rate is omitted from an animation renderer request', async () => {
    const { ctx, host, dir } = await ctxFor();
    const project = await loadProject(dir);
    project.format.fps = 60;
    await saveProject(dir, project);
    const result = await executeTool(ctx, 'make_animation', {
      template: 'big-quote', params: { text: 'Keep moving' },
    });
    expect(result.isError).toBe(false);
    expect(host.animations[0].fps).toBe(60);
  });

  it('feeds wordTimes from the transcript and writes a .mov', async () => {
    const { ctx, host } = await ctxFor();
    // w48-w52 = "eighteen hours in the fridge"; older engine (no anim-context): approximate timings
    const r = await executeTool(ctx, 'make_animation', { template: 'big-quote', anchor: { from: 'w48', to: 'w52' },
      params: { text: 'eighteen hours in the fridge' } });
    expect(r.isError).toBe(false);
    const out = JSON.parse(r.content);
    expect(out.asset).toMatch(/^work\/assets\/anim-big-quote-1\.mov$/);
    expect(out.timing).toMatch(/spoken word/);
    const sent = host.animations[0].params;
    expect(sent.wordTimes).toHaveLength(5);
    expect(sent.wordTimes[0]).toBeCloseTo(0.13, 2);                // the lead-in: the clip starts just before the word
    expect([...sent.wordTimes].sort((a: number, b: number) => a - b)).toEqual(sent.wordTimes);
    expect(host.animations[0].out.endsWith('.mov')).toBe(true);
  });

  it('uses the engine region above the face and list timings', async () => {
    const { ctx, host } = await ctxFor();
    const run = host.runEngine.bind(host);
    host.runEngine = async (command: string, args: string[], onProgress?: any) => {
      if (command !== 'anim-context') return run(command, args, onProgress);
      return { t0: 10, layout: 'top', region: { x: 38, y: 180, w: 1004, h: 520 },
        words: [{ id: 'w42', w: 'so', t: 0.13 }, { id: 'w43', w: 'I', t: 0.3 }, { id: 'w44', w: 'tried', t: 0.5 },
          { id: 'w45', w: 'the', t: 0.8 }, { id: 'w46', w: 'slow', t: 0.95 }, { id: 'w47', w: 'method', t: 1.3 }] };
    };
    const r = await executeTool(ctx, 'add_broll', { anchor: { from: 'w42', to: 'w47' }, treatment: 'card-above-head', asset: null, search: null,
      animation: { template: 'list-reveal', params: { items: ['slow', 'method'] } }, params: {} });
    expect(r.isError).toBe(false);
    const sent = host.animations[0].params;
    expect(sent.region).toEqual({ x: 38, y: 180, w: 1004, h: 520 });
    expect(sent.at).toEqual([0.95, 1.3]);
    const p = await loadProject(ctx.projectDir);
    expect(p.broll[0].treatment).toBe('animation');               // never pushed through a card
  });

  it('logo-pop: resolves the image path; refuses a missing one', async () => {
    const { ctx, host, root } = await ctxFor();
    await fsp.writeFile(path.join(root, 'Library', 'Images', 'acme.png'), tinyPng());
    const ok = await executeTool(ctx, 'make_animation', { template: 'logo-pop', anchor: null, params: { image: 'acme.png', text: 'Acme' } });
    expect(ok.isError).toBe(false);
    expect(path.isAbsolute(host.animations[0].params.image)).toBe(true);
    const missing = await executeTool(ctx, 'make_animation', { template: 'logo-pop', anchor: null, params: { image: 'nope.png' } });
    expect(missing.isError).toBe(true);
    const none = await executeTool(ctx, 'make_animation', { template: 'logo-pop', anchor: null, params: { text: 'Acme' } });
    expect(JSON.parse(none.content).error).toMatch(/needs params.image/);
  });

  it('drops params the template does not take', async () => {
    const { ctx, host } = await ctxFor();
    const r = await executeTool(ctx, 'make_animation', { template: 'stat-count-up', anchor: null, params: { value: '3,000', text: 'people', items: ['x', 'y'], image: null } });
    expect(r.content).not.toMatch(/error/);
    expect(host.animations[0].params).toEqual({ value: '3,000', text: 'people' });
  });
});
