// npm test   (from templates/animations). Browser tests are skipped when playwright is missing.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { listTemplates, loadMeta, prepareParams, inlineFiles, startTemplateServer, renderAnimation, createPlaywrightAdapter, findFfmpeg } from '../render.mjs';

function rgba(png) {
  return execFileSync(findFfmpeg(), ['-v', 'error', '-f', 'png_pipe', '-i', '-', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { input: png, maxBuffer: 64e6 });
}
function pixelDiff(p1, p2) {
  const a = rgba(p1), b = rgba(p2);
  let pixels = 0, max = 0;
  for (let i = 0; i < a.length; i += 4) {
    let m = 0;
    for (let c = 0; c < 4; c++) m = Math.max(m, Math.abs(a[i + c] - b[i + c]));
    if (m) { pixels++; if (m > max) max = m; }
  }
  return { pixels, max };
}

const EXPECTED = ['big-quote', 'list-reveal', 'logo-pop', 'price-tag', 'stat-count-up', 'typing-terminal'];

describe('templates', () => {
  it('lists the six templates with a description and schema', () => {
    const t = listTemplates();
    assert.deepEqual(t.map((x) => x.id), EXPECTED);
    for (const x of t) {
      assert.ok(x.description && x.description.length > 20, `${x.id} description`);
      assert.ok(x.defaultDuration > 0, `${x.id} defaultDuration`);
      assert.equal(x.params.type, 'object');
      for (const k of ['layout', 'theme', 'accentColor', 'tilt', 'duration', 'drift', 'region']) assert.ok(x.params.properties[k], `${x.id} has ${k}`);
      assert.ok(!/[\u2013\u2014]/.test(JSON.stringify(loadMeta(x.id))), `${x.id} meta has no em/en dash`);
    }
  });

  it('examples and variants validate', () => {
    for (const { id } of listTemplates()) {
      const m = loadMeta(id);
      for (const p of [m.example, ...(m.variants || [])]) prepareParams(m, p);
    }
  });

  it('rejects bad params with a readable message, drops unknown ones', () => {
    const m = loadMeta('list-reveal');
    assert.throws(() => prepareParams(m, { items: ['one'] }), (e) => e.code === 'BAD_PARAMS' && /at least 2/.test(e.message));
    assert.throws(() => prepareParams(m, {}), (e) => e.code === 'BAD_PARAMS' && /missing required param "items"/.test(e.message));
    assert.throws(() => prepareParams(m, { items: ['a', 'b'], theme: 'neon' }), (e) => /one of light, dark, accent/.test(e.message));
    const ok = prepareParams(m, { items: ['a', 'b'], sparkle: true, value: null });
    assert.deepEqual(ok.warnings, ['ignored unknown param "sparkle"']);
    assert.equal(ok.params.layout, 'top');
  });

  it('rejects unknown and unsafe template ids', () => {
    assert.throws(() => loadMeta('nope'), (e) => e.code === 'BAD_TEMPLATE');
    assert.throws(() => loadMeta('../render'), (e) => e.code === 'BAD_TEMPLATE');
  });

  it('inlines a local image path (with spaces) as a data URL', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'anim test é '));
    const f = path.join(dir, 'my logo.svg');
    writeFileSync(f, '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>');
    const out = await inlineFiles(loadMeta('logo-pop'), { image: f, text: 'x' });
    assert.match(out.image, /^data:image\/svg\+xml;base64,/);
    await assert.rejects(inlineFiles(loadMeta('logo-pop'), { image: path.join(dir, 'missing.png') }), (e) => e.code === 'ASSET_MISSING');
    rmSync(dir, { recursive: true, force: true });
  });

  it('serves templates and fonts, refuses to leave the folder', async () => {
    const s = await startTemplateServer();
    try {
      assert.equal((await fetch(`${s.url}/animations/stat-count-up/meta.json`)).status, 200);
      assert.equal((await fetch(`${s.url}/fonts/Inter_700Bold.ttf`)).headers.get('content-type'), 'font/ttf');
      assert.notEqual((await fetch(`${s.url}/..%2F..%2Fpackage.json`)).status, 200);
    } finally { await s.close(); }
  });
});

let pw = true;
try { await import('playwright'); } catch { pw = false; }

describe('rendering (playwright)', { skip: !pw && 'playwright not installed' }, () => {
  let adapter;
  let dir;
  before(async () => { adapter = await createPlaywrightAdapter(); dir = mkdtempSync(path.join(os.tmpdir(), 'anim render é ')); });
  after(async () => { await adapter?.close(); if (dir) rmSync(dir, { recursive: true, force: true }); });

  it('__seek is a pure function of time for every template', async () => {
    const logo = path.join(dir, 'logo.svg');
    writeFileSync(logo, '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" rx="12" fill="#7B4DFF"/></svg>');
    const s = await startTemplateServer();
    try {
      for (const { id } of listTemplates()) {
        const m = loadMeta(id);
        const params = await inlineFiles(m, prepareParams(m, id === 'logo-pop' ? { ...m.example, image: logo } : m.example).params);
        await adapter.load(`${s.url}/animations/${id}/index.html`);
        const info = await adapter.evaluate(`window.__setup(${JSON.stringify(params)})`);
        assert.ok(info.duration > 0.5, `${id} duration`);
        const shot = async (t) => { await adapter.evaluate(`window.__seek(${t})`); return adapter.capture(t); };
        for (const t of [0.1, 1.0]) {
          const a = await shot(t);
          await shot(0.05);
          await shot(info.duration - 0.01);
          const b = await shot(t);
          // Chromium may differ by a few LSB on a handful of anti-aliased pixels (raster caches);
          // anything visible is a real state leak in __seek.
          const d = pixelDiff(a, b);
          assert.ok(d.pixels <= 64 && d.max <= 16, `${id}: frame at ${t} s differs after seeking elsewhere (${d.pixels} px, max ${d.max})`);
        }
        assert.ok(pixelDiff(await shot(0), await shot(1.0)).pixels > 1000, `${id}: nothing moves between 0 s and 1 s`);
      }
    } finally { await s.close(); }
  });

  it('every card enters WITH content: no empty or half-built first frame, even when the words come later', async () => {
    const { cases, firstFrame } = await import('../tools/firstframe.mjs');
    const logo = path.join(dir, 'logo512.svg');
    writeFileSync(logo, '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><rect width="512" height="512" rx="112" fill="#7B4DFF"/><path d="M206 160 L366 256 L206 352 Z" fill="#fff"/></svg>');
    const s = await startTemplateServer();
    try {
      for (const c of cases(logo)) {
        const m = loadMeta(c.id);
        const params = await inlineFiles(m, prepareParams(m, c.params).params);
        const r = await firstFrame(adapter, `${s.url}/animations/${c.id}/index.html`, params);
        assert.ok(r, `${c.name}: never draws anything`);
        // a logo shown on its own (white tile / bare) IS the content; everything else must show words
        const logoOnly = c.id === 'logo-pop' && params.background !== 'card';
        assert.ok(logoOnly || r.letters >= 1, `${c.name}: first drawn frame (t=${r.t.toFixed(3)} s) shows no words: an empty card`);
      }
    } finally { await s.close(); }
  });

  it('renders a qtrle .mov with alpha, swapping the extension, into a path with spaces', async () => {
    const r = await renderAnimation({ template: 'price-tag', params: { value: '$20', oldValue: '$50', duration: 1 }, outPath: path.join(dir, 'out dir', 'price tag.webm'), adapter });
    assert.equal(path.extname(r.path), '.mov');
    assert.ok(existsSync(r.path));
    assert.equal(r.frames, 30);
    const side = JSON.parse(readFileSync(r.path.replace(/\.mov$/, '.anim.json'), 'utf8'));
    assert.equal(side.kind, 'reelstudio-animation');
    const probe = execFileSync(findFfmpeg().replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1'), ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,pix_fmt,width,height', '-of', 'csv=p=0', r.path]).toString().trim();
    assert.equal(probe, 'qtrle,1080,1920,argb');
  });
});
