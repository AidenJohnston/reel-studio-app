// Reel Studio animation renderer.
//
// Turns an HTML template (templates/animations/<id>/index.html) + params into a transparent video
// layer the engine overlays on the speaker. Output: QuickTime .mov, codec qtrle (Animation), pixel
// format argb, full 1080x1920 frame, alpha straight (not premultiplied). See README.md for why.
//
// Two ways to drive it:
//   1. Dev / CI, from Node:   node render.mjs <template> --params '{"value":"3,000"}' --out "out dir/x.mov"
//      (uses Playwright's Chromium: `npm i` here, then `npx playwright install chromium` once)
//   2. Electron main process: renderAnimation({ template, params, outPath, adapter: createElectronAdapter(BrowserWindow) })
//
// An adapter is the only browser-specific part:
//   { load(url): Promise<void>, evaluate(expr: string): Promise<any>, capture(t: number): Promise<Buffer /* PNG */>, close(): Promise<void> }
// `evaluate` runs an expression in the page and awaits it if it is a Promise. `capture` returns a
// 1080x1920 PNG with a real alpha channel of the page as it is right now (after __seek(t)).

import { spawn } from 'node:child_process';
import { createReadStream, existsSync, promises as fsp, readdirSync, readFileSync, statSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ANIMATIONS_DIR = path.dirname(fileURLToPath(import.meta.url));
export const TEMPLATES_ROOT = path.dirname(ANIMATIONS_DIR); // serves animations/ and fonts/
export const WIDTH = 1080;
export const HEIGHT = 1920;
export const DEFAULT_FPS = 30;
export const OUTPUT_EXT = '.mov';

// ------------------------------------------------------------------------------------- templates

export function listTemplates(dir = ANIMATIONS_DIR) {
  return readdirSafe(dir)
    .filter((d) => !d.startsWith('_') && !d.startsWith('.') && existsSync(path.join(dir, d, 'meta.json')))
    .sort()
    .map((id) => {
      const m = loadMeta(id, dir);
      return { id, name: m.name, description: m.description, defaultDuration: m.defaultDuration, params: m.params };
    });
}

export function loadMeta(id, dir = ANIMATIONS_DIR) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(String(id))) throw renderError('BAD_TEMPLATE', `bad template id: ${id}`);
  const f = path.join(dir, id, 'meta.json');
  if (!existsSync(f)) throw renderError('BAD_TEMPLATE', `unknown animation template: ${id}`);
  return JSON.parse(readFileSync(f, 'utf8'));
}

function readdirSafe(d) {
  try { return readdirSync(d); } catch { return []; }
}

/**
 * Validate params against the template's JSON schema (the subset our meta.json files use) and fill
 * defaults. Unknown keys are dropped with a warning instead of failing, so an AI that sends an
 * extra field still gets its animation. Returns { params, warnings } or throws BAD_PARAMS.
 */
export function prepareParams(meta, params = {}) {
  const schema = meta.params || { properties: {} };
  const props = schema.properties || {};
  const out = {};
  const warnings = [];
  const errors = [];
  for (const [k, v] of Object.entries(params || {})) {
    if (v === null || v === undefined) continue;
    if (!props[k]) { warnings.push(`ignored unknown param "${k}"`); continue; }
    const s = props[k].$ref ? resolveRef(schema, props[k].$ref) : props[k];
    const err = checkValue(s, v, k);
    if (err) errors.push(err); else out[k] = v;
  }
  for (const r of schema.required || []) if (out[r] === undefined) errors.push(`missing required param "${r}"`);
  for (const [k, s] of Object.entries(props)) if (out[k] === undefined && s.default !== undefined && s.default !== null) out[k] = s.default;
  if (errors.length) throw renderError('BAD_PARAMS', `${meta.id}: ${errors.join('; ')}`);
  return { params: out, warnings };
}

function resolveRef(schema, ref) {
  const m = /^#\/definitions\/(.+)$/.exec(ref);
  return (m && schema.definitions && schema.definitions[m[1]]) || {};
}

function checkValue(s, v, k) {
  const types = Array.isArray(s.type) ? s.type : s.type ? [s.type] : [];
  const typeOf = (x) => (Array.isArray(x) ? 'array' : x === null ? 'null' : Number.isInteger(x) ? 'integer' : typeof x);
  const t = typeOf(v);
  if (types.length && !types.some((ty) => ty === t || (ty === 'number' && t === 'integer'))) return `"${k}" should be ${types.join(' or ')}`;
  if (s.enum && !s.enum.includes(v)) return `"${k}" should be one of ${s.enum.join(', ')}`;
  if (typeof v === 'string') {
    if (s.maxLength && v.length > s.maxLength) return `"${k}" is too long (max ${s.maxLength} characters)`;
    if (s.minLength && v.length < s.minLength) return `"${k}" is too short`;
    if (s.pattern && !new RegExp(s.pattern).test(v)) return `"${k}" has the wrong format`;
  }
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return `"${k}" is not a number`;
    if (s.minimum !== undefined && v < s.minimum) return `"${k}" should be at least ${s.minimum}`;
    if (s.maximum !== undefined && v > s.maximum) return `"${k}" should be at most ${s.maximum}`;
  }
  if (Array.isArray(v)) {
    if (s.minItems !== undefined && v.length < s.minItems) return `"${k}" needs at least ${s.minItems} items`;
    if (s.maxItems !== undefined && v.length > s.maxItems) return `"${k}" allows at most ${s.maxItems} items`;
    if (s.items) for (let i = 0; i < v.length; i++) { const e = checkValue(s.items, v[i], `${k}[${i}]`); if (e) return e; }
  }
  if (t === 'object' && s.properties) {
    for (const r of s.required || []) if (v[r] === undefined) return `"${k}.${r}" is missing`;
    for (const [kk, vv] of Object.entries(v)) if (s.properties[kk]) { const e = checkValue(s.properties[kk], vv, `${k}.${kk}`); if (e) return e; }
  }
  return null;
}

const IMAGE_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml' };

/**
 * Params marked `"format": "file"` in the schema may be local paths. The page cannot read arbitrary
 * disk paths, so they are inlined as data: URLs here (also keeps rendering offline).
 */
export async function inlineFiles(meta, params, baseDir = process.cwd()) {
  const props = (meta.params && meta.params.properties) || {};
  const out = { ...params };
  for (const [k, s] of Object.entries(props)) {
    const v = out[k];
    if (s.format !== 'file' || typeof v !== 'string' || !v || /^(data:|https?:)/i.test(v)) continue;
    let p = v.startsWith('file:') ? fileURLToPath(v) : v;
    if (!path.isAbsolute(p)) p = path.resolve(baseDir, p);
    const mime = IMAGE_MIME[path.extname(p).toLowerCase()];
    if (!mime) throw renderError('BAD_PARAMS', `"${k}" must be an image file (png, jpg, webp, gif, svg): ${v}`, 'That picture is in a format I cannot use. Try a PNG or JPG.');
    let buf;
    try { buf = await fsp.readFile(p); } catch { throw renderError('ASSET_MISSING', `image not found: ${p}`, 'A picture for your animation is missing. It may have been moved or deleted.'); }
    out[k] = `data:${mime};base64,${buf.toString('base64')}`;
  }
  return out;
}

// ------------------------------------------------------------------------------------- server

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.ttf': 'font/ttf', '.otf': 'font/otf', '.woff2': 'font/woff2', '.woff': 'font/woff', ...IMAGE_MIME };

/**
 * Serve the templates folder on 127.0.0.1 (random port). Pages load over http instead of file://
 * so fonts, fetch('meta.json') and relative assets behave the same in Chromium and Electron and on
 * every OS, whatever characters the install path contains.
 */
export function startTemplateServer(root = TEMPLATES_ROOT) {
  const rootAbs = path.resolve(root);
  const server = http.createServer({ keepAlive: false }, (req, res) => {
    let rel;
    try { rel = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400).end(); return; }
    const f = path.resolve(rootAbs, '.' + rel);
    if (f !== rootAbs && !f.startsWith(rootAbs + path.sep)) { res.writeHead(403).end(); return; }
    let st;
    try { st = statSync(f); } catch { res.writeHead(404).end(); return; }
    if (!st.isFile()) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': 'no-store' });
    createReadStream(f).pipe(res);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      // The page keeps keep-alive connections open; close() alone would wait on them forever.
      const close = () => new Promise((r) => { server.close(() => r()); server.closeAllConnections?.(); });
      resolve({ url: `http://127.0.0.1:${port}`, close });
    });
  });
}

// ------------------------------------------------------------------------------------- ffmpeg

export function findFfmpeg(explicit) {
  return explicit || process.env.REELENGINE_FFMPEG || process.env.FFMPEG || 'ffmpeg';
}

function startEncoder(ffmpeg, fps, outFile) {
  const args = [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'png', '-i', 'pipe:0',
    '-c:v', 'qtrle', '-pix_fmt', 'argb', '-r', String(fps),
    '-f', 'mov', outFile,
  ];
  const proc = spawn(ffmpeg, args, { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
  let stderr = '';
  proc.stderr.on('data', (d) => { stderr += d; if (stderr.length > 20000) stderr = stderr.slice(-20000); });
  const done = new Promise((resolve, reject) => {
    proc.once('error', (e) => reject(renderError('NO_FFMPEG', `could not start ffmpeg (${ffmpeg}): ${e.message}`, 'The video tools are missing. Try reinstalling the app.')));
    proc.once('close', (code) => (code === 0 ? resolve() : reject(renderError('ENCODE_FAILED', `ffmpeg exited ${code}: ${stderr.trim()}`))));
  });
  done.catch(() => {}); // observed by the caller; avoid an unhandled rejection while frames are still being written
  const write = (buf) => new Promise((resolve, reject) => {
    if (proc.stdin.destroyed) { reject(renderError('ENCODE_FAILED', `ffmpeg closed its input: ${stderr.trim()}`)); return; }
    proc.stdin.write(buf, (err) => (err ? reject(renderError('ENCODE_FAILED', `${err.message}: ${stderr.trim()}`)) : resolve()));
  });
  const finish = async () => { proc.stdin.end(); await done; };
  const kill = () => { try { proc.kill(); } catch { /* already gone */ } };
  proc.stdin.on('error', () => {}); // EPIPE surfaces through `done`
  return { write, finish, kill, done };
}

// ------------------------------------------------------------------------------------- render

/**
 * Render one animation.
 * opts: { template, params, outPath, adapter, fps?, ffmpeg?, onProgress?(pct), signal?, baseDir?, templatesRoot?, callTimeoutMs? }
 * callTimeoutMs bounds every single browser call (load, setup, one frame); default 30 s.
 * Returns { path, duration, width, height, fps, frames, template, warnings }.
 * The output is always a .mov (qtrle/argb); a different extension on outPath is replaced.
 */
export async function renderAnimation(opts) {
  const { template, adapter, signal } = opts;
  if (!adapter) throw renderError('NO_RENDERER', 'renderAnimation needs an adapter (createElectronAdapter or createPlaywrightAdapter)');
  const fps = clampInt(opts.fps ?? DEFAULT_FPS, 1, 120);
  const animationsDir = opts.templatesRoot ? path.join(opts.templatesRoot, 'animations') : ANIMATIONS_DIR;
  const meta = loadMeta(template, animationsDir);
  const { params: checked, warnings } = prepareParams(meta, opts.params || {});
  const params = await inlineFiles(meta, checked, opts.baseDir);

  const out = withMovExt(path.resolve(String(opts.outPath)));
  await fsp.mkdir(path.dirname(out), { recursive: true });
  const part = out.slice(0, -OUTPUT_EXT.length) + '.part' + OUTPUT_EXT;

  const server = await startTemplateServer(opts.templatesRoot || TEMPLATES_ROOT);
  let enc = null;
  try {
    const callMs = opts.callTimeoutMs ?? 30000;
    await withTimeout(adapter.load(`${server.url}/animations/${encodeURIComponent(template)}/index.html`), callMs, 'loading the template');
    const info = await withTimeout(adapter.evaluate(`window.__setup(${JSON.stringify(params)})`), callMs, 'setting up the template');
    if (!info || !(info.duration > 0)) throw renderError('TEMPLATE_FAILED', `${template}: __setup returned ${JSON.stringify(info)}`);
    const frames = Math.max(1, Math.round(info.duration * fps));
    enc = startEncoder(findFfmpeg(opts.ffmpeg), fps, part);
    for (let i = 0; i < frames; i++) {
      if (signal?.aborted) throw renderError('CANCELLED', 'animation render cancelled', 'Stopped.');
      const t = i / fps;
      await withTimeout(adapter.evaluate(`window.__seek(${t})`), callMs, `frame ${i}`);
      const png = await withTimeout(adapter.capture(t), callMs, `capturing frame ${i}`);
      await enc.write(png);
      opts.onProgress?.(Math.round(((i + 1) / frames) * 100));
    }
    await enc.finish();
    enc = null;
    await fsp.rm(out, { force: true });
    await fsp.rename(part, out);
    const result = { path: out, duration: frames / fps, width: WIDTH, height: HEIGHT, fps, frames, template, layout: info.layout, warnings };
    // Sidecar so the engine knows this is a full-frame transparent layer (overlay at 0,0, no backdrop).
    await fsp.writeFile(out.slice(0, -OUTPUT_EXT.length) + '.anim.json', JSON.stringify({
      kind: 'reelstudio-animation', version: 1, template, params: opts.params || {}, duration: result.duration, fps,
      width: WIDTH, height: HEIGHT, layout: info.layout, transparent: true, codec: 'qtrle', pixFmt: 'argb',
    }, null, 2));
    return result;
  } catch (e) {
    enc?.kill();
    await fsp.rm(part, { force: true }).catch(() => {});
    throw e.code ? e : renderError('TEMPLATE_FAILED', `${template}: ${e.message || e}`);
  } finally {
    await server.close();
  }
}

function withTimeout(promise, ms, what) {
  let timer;
  const t = new Promise((_, reject) => { timer = setTimeout(() => reject(renderError('TIMEOUT', `animation render timed out while ${what} (${ms} ms)`)), ms); });
  return Promise.race([promise, t]).finally(() => clearTimeout(timer));
}

function withMovExt(p) {
  const ext = path.extname(p);
  return ext.toLowerCase() === OUTPUT_EXT ? p : (ext ? p.slice(0, -ext.length) : p) + OUTPUT_EXT;
}
const clampInt = (v, a, b) => Math.min(b, Math.max(a, Math.round(Number(v) || a)));

export function renderError(code, message, userMessage = 'I could not make that animation. Try a picture or a text card instead.') {
  const e = new Error(message);
  e.code = code;
  e.userMessage = userMessage;
  return e;
}

// ------------------------------------------------------------------------------------- adapters

/**
 * Electron adapter. Pass Electron's BrowserWindow class (this module never imports electron).
 * Uses an offscreen, transparent window so nothing flashes on screen and the size is not limited
 * by the user's display.
 */
export function createElectronAdapter(BrowserWindow, { show = false } = {}) {
  const win = new BrowserWindow({
    show, width: WIDTH, height: HEIGHT, useContentSize: true, frame: false, transparent: true,
    backgroundColor: '#00000000', resizable: false, enableLargerThanScreen: true, paintWhenInitiallyHidden: true,
    webPreferences: { offscreen: true, backgroundThrottling: false, contextIsolation: true, sandbox: true, nodeIntegration: false, devTools: false },
  });
  // A window taller than the display is clamped at creation, even offscreen (seen on Windows,
  // 1392 px tall screen): set the size again afterwards and verify it in the page.
  win.setContentSize(WIDTH, HEIGHT);
  const wc = win.webContents;
  wc.setFrameRate?.(60);
  wc.setZoomFactor?.(1);
  let lastPaint = null;
  wc.on('paint', (_e, _dirty, image) => { lastPaint = image; });
  const viewport = () => wc.executeJavaScript('[innerWidth, innerHeight]', true);
  return {
    async load(url) {
      await win.loadURL(url);
      let [w, h] = await viewport();
      if (w !== WIDTH || h !== HEIGHT) {
        win.setContentSize(WIDTH, HEIGHT);
        await new Promise((r) => setTimeout(r, 100));
        [w, h] = await viewport();
      }
      if (w !== WIDTH || h !== HEIGHT) throw renderError('RENDER_SIZE', `offscreen window is ${w}x${h}, expected ${WIDTH}x${HEIGHT}`);
    },
    async evaluate(expr) { return wc.executeJavaScript(expr, true); },
    async capture() {
      // let the compositor pick up the DOM change from __seek, then grab the frame
      await wc.executeJavaScript('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(1))))', true);
      let img = await wc.capturePage();
      if (img.isEmpty() && lastPaint) img = lastPaint;
      const { width, height } = img.getSize();
      if (width !== WIDTH || height !== HEIGHT) {
        // a HiDPI capture (2x) is scaled down uniformly; anything else would stretch the frame
        if (Math.abs(width / height - WIDTH / HEIGHT) > 0.002) throw renderError('RENDER_SIZE', `captured ${width}x${height}, expected ${WIDTH}x${HEIGHT}`);
        img = img.resize({ width: WIDTH, height: HEIGHT, quality: 'best' });
      }
      return img.toPNG();
    },
    async close() { if (!win.isDestroyed()) win.destroy(); },
    window: win,
  };
}

/** Playwright (Chromium) adapter for dev, tests and CI. `playwright` is a dev dependency only. */
export async function createPlaywrightAdapter({ headless = true } = {}) {
  let pw;
  try { pw = await import('playwright'); } catch {
    try { pw = await import('playwright-core'); } catch {
      throw renderError('NO_RENDERER', 'playwright is not installed: run `npm install` in templates/animations, then `npx playwright install chromium`');
    }
  }
  const chromium = pw.chromium || pw.default?.chromium;
  const browser = await chromium.launch({ headless, args: ['--force-color-profile=srgb', '--font-render-hinting=none', '--disable-lcd-text'] });
  const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  return {
    async load(url) { await page.goto(url, { waitUntil: 'load' }); },
    async evaluate(expr) {
      try { return await page.evaluate(expr); } catch (e) { throw new Error(`${e.message}${pageErrors.length ? ' | page: ' + pageErrors.join(' | ') : ''}`); }
    },
    async capture() { return page.screenshot({ type: 'png', omitBackground: true, animations: 'disabled', caret: 'hide' }); },
    async close() { await browser.close(); },
    page,
  };
}

/** Convenience for Node: render with a throwaway Playwright browser. */
export async function renderWithPlaywright(opts) {
  const adapter = await createPlaywrightAdapter();
  try { return await renderAnimation({ ...opts, adapter }); } finally { await adapter.close(); }
}

/** Render several animations reusing one browser (much faster than one browser each). */
export async function renderManyWithPlaywright(jobs, common = {}) {
  const adapter = await createPlaywrightAdapter();
  const results = [];
  try {
    for (const j of jobs) results.push(await renderAnimation({ ...common, ...j, adapter }));
  } finally { await adapter.close(); }
  return results;
}

// ------------------------------------------------------------------------------------- CLI

function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x.startsWith('--')) {
      const k = x.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) a[k] = true; else { a[k] = next; i++; }
    } else a._.push(x);
  }
  return a;
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a.list) { process.stdout.write(JSON.stringify(listTemplates(), null, 2) + '\n'); return; }
  const template = a._[0];
  if (!template || !a.out) {
    process.stderr.write('usage: node render.mjs <template> --out <file.mov> [--params JSON | --params-file f.json] [--fps 30] [--ffmpeg path]\n       node render.mjs --list\n');
    process.exitCode = 2;
    return;
  }
  const params = a['params-file'] ? JSON.parse(await fsp.readFile(a['params-file'], 'utf8')) : a.params ? JSON.parse(a.params) : {};
  const t0 = Date.now();
  const r = await renderWithPlaywright({ template, params, outPath: a.out, fps: a.fps ? Number(a.fps) : undefined, ffmpeg: a.ffmpeg });
  process.stdout.write(JSON.stringify({ ...r, ms: Date.now() - t0 }) + '\n');
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((e) => {
    process.stdout.write(JSON.stringify({ error: { code: e.code || 'ERROR', message: e.message, userMessage: e.userMessage } }) + '\n');
    process.exitCode = 1;
  });
}
