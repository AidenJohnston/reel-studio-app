// capture_website (a screenshot of a page the speaker names) and the `website` hint search_images
// passes on. The host's captureWebsite is faked: the real one is the app's offscreen window.
import { describe, it, expect } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { executeTool, newToolState, StyleStore, ToolContext } from '../src';
import { FakeHost, makeProject, tinyPng } from './helpers';

class CaptureHost extends FakeHost {
  captures: { url: string; out: string; layout?: string }[] = [];
  registered: string[][] = [];
  captureFails: any = null;
  async captureWebsite(url: string, outPath: string, opts?: { layout?: 'phone' | 'desktop' }) {
    if (this.captureFails) throw this.captureFails;
    this.captures.push({ url, out: outPath, layout: opts?.layout });
    await fsp.writeFile(outPath, tinyPng());
    return { path: outPath, url: 'https://www.zorblax.example/', site: 'zorblax.example', title: 'Zorblax', width: 1080, height: 2340 };
  }
  async runEngine(command: string, args: string[], onProgress?: any): Promise<any> {
    if (command === 'register-capture') {
      this.registered.push(args);
      const dir = args[args.indexOf('--project') + 1];
      const thumb = path.join(dir, 'work', 'thumbs', 'shot.jpg');
      await fsp.mkdir(path.dirname(thumb), { recursive: true });
      await fsp.writeFile(thumb, tinyPng());
      return { asset: args[args.indexOf('--asset') + 1], thumb };
    }
    if (command === 'search-images') {
      return { results: this.searchResults, website: { url: 'https://zorblax.example', name: 'Zorblax' } };
    }
    return super.runEngine(command, args, onProgress);
  }
}

async function ctxWith(host: FakeHost, dir: string, root: string): Promise<ToolContext> {
  return { projectDir: dir, host, style: new StyleStore(() => root), emit: () => {}, state: newToolState(), supportsImages: true, lookupImpl: async () => ['93.184.215.14'] };
}

describe('capture_website', () => {
  it('saves the screenshot into work/assets, credits it, and shows the AI a still', async () => {
    const { root, dir } = await makeProject();
    const host = new CaptureHost(root);
    const ctx = await ctxWith(host, dir, root);
    const r = await executeTool(ctx, 'capture_website', { url: 'zorblax.example', layout: null, name: null });
    expect(r.isError).toBe(false);
    const c = JSON.parse(r.content);
    expect(c.asset).toBe('work/assets/zorblax-example-screen.png');
    expect(c.label).toBe('Screenshot of zorblax.example');
    expect(c.rights).toMatch(/belongs to its owner/);
    expect(r.images?.length).toBe(1);
    expect(host.captures[0]).toMatchObject({ url: 'zorblax.example', layout: 'phone' });
    expect(host.captures[0].out.endsWith(path.join('work', 'assets', 'zorblax-example-screen.png'))).toBe(true);
    expect(host.registered[0]).toEqual(expect.arrayContaining(['--asset', 'work/assets/zorblax-example-screen.png', '--url', 'https://www.zorblax.example/']));
    // a second capture never overwrites the first
    const again = JSON.parse((await executeTool(ctx, 'capture_website', { url: 'https://zorblax.example', layout: 'desktop', name: null })).content);
    expect(again.asset).toBe('work/assets/zorblax-example-screen-2.png');
    expect(host.captures[1].layout).toBe('desktop');
  });

  it('a file name hint is a slug, never a path', async () => {
    const { root, dir } = await makeProject();
    const host = new CaptureHost(root);
    const c = JSON.parse((await executeTool(await ctxWith(host, dir, root), 'capture_website', { url: 'zorblax.example', layout: null, name: '../../Desktop/x' })).content);
    expect(c.asset).toMatch(/^work\/assets\/[a-z0-9-]+\.png$/);
  });

  it('a refused page comes back as a plain tool error with the way out', async () => {
    const { root, dir } = await makeProject();
    const host = new CaptureHost(root);
    host.captureFails = { code: 'SITE_REFUSED', userMessage: 'That site blocks automatic screenshots.' };
    const r = await executeTool(await ctxWith(host, dir, root), 'capture_website', { url: 'zorblax.example', layout: null, name: null });
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/blocks automatic screenshots.*search_images or a text-pop/);
  });

  it('without the app (no captureWebsite on the host) it says so', async () => {
    const { root, dir } = await makeProject();
    const r = await executeTool(await ctxWith(new FakeHost(root), dir, root), 'capture_website', { url: 'zorblax.example', layout: null, name: null });
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/only work in the Reel Studio app/);
  });
});

describe('search_images', () => {
  it('passes the website hint and marks copyrighted results', async () => {
    const { root, dir } = await makeProject();
    const host = new CaptureHost(root);
    host.searchResults = [
      { url: 'https://cdn.example/zorblax.svg', title: 'Zorblax logo', kind: 'logo', license: 'CC0 1.0' },
      { url: 'https://static.example/poster.jpg', title: 'Zorblax poster', kind: 'poster', copyrighted: true, attributionRequired: true, attribution: 'Zorblax poster: Zorblax (c) its owner' },
    ];
    const c = JSON.parse((await executeTool(await ctxWith(host, dir, root), 'search_images', { query: 'Zorblax app' })).content);
    expect(c.website).toEqual({ url: 'https://zorblax.example', name: 'Zorblax' });
    expect(c.results[0].copyrighted).toBeUndefined();
    expect(c.results[1].copyrighted).toMatch(/used as commentary, your responsibility/);
  });
});
