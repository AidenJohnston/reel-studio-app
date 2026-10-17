// Proof run: render every template (its example + variants), overlay each onto a real talking-head
// take with ffmpeg exactly the way the engine will, pull frames, check the alpha channel numerically,
// and build a contact sheet.
//
//   node tools/proof.mjs --take "<raw talking-head.mp4>" [--out <dir>] [--only id,id] [--ffmpeg path]
//
// Checks (per render, over EVERY frame of the layer, not a sample):
//   * caption band (y 1250-1500): alpha must be 0 for every layout
//   * face box (x 330-750, y 760-1140, eyes to chin of a typical centred head): alpha <= 40 for layout `top` (shadow only)
//   * the layer must not be empty (something is drawn)
import { spawn } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPlaywrightAdapter, findFfmpeg, listTemplates, loadMeta, renderAnimation } from '../render.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..', '..');
const CAPTION_BAND = { x: 0, y: 1250, w: 1080, h: 250 };
// eyes-to-chin of a typical centred speaker; the hair above it may be covered by a card that must read
const FACE_BOX = { x: 330, y: 760, w: 420, h: 380 };

function args() {
  const a = {};
  const v = process.argv.slice(2);
  for (let i = 0; i < v.length; i++) if (v[i].startsWith('--')) a[v[i].slice(2)] = v[i + 1] && !v[i + 1].startsWith('--') ? v[++i] : true;
  return a;
}

function run(bin, argv, { capture = false } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, argv, { stdio: ['ignore', capture ? 'pipe' : 'ignore', 'pipe'], windowsHide: true });
    const out = []; let err = '';
    if (capture) p.stdout.on('data', (d) => out.push(d));
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (c) => (c === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`${bin} ${argv.join(' ')}\n${err}`))));
  });
}

/** Max alpha inside a box over every frame of the layer. */
async function maxAlpha(ffmpeg, mov, box) {
  const buf = await run(ffmpeg, ['-v', 'error', '-i', mov, '-vf', `alphaextract,crop=${box.w}:${box.h}:${box.x}:${box.y}`, '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { capture: true });
  let m = 0;
  for (let i = 0; i < buf.length; i++) if (buf[i] > m) { m = buf[i]; if (m === 255) break; }
  return m;
}

/** Largest per-channel deviation from the band's first pixel, over every frame (0 = plain colour). */
async function bandSpread(ffmpeg, mov, box) {
  const buf = await run(ffmpeg, ['-v', 'error', '-i', mov, '-vf', `crop=${box.w}:${box.h}:${box.x}:${box.y}`, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { capture: true });
  let m = 0;
  for (let i = 0; i < buf.length; i++) { const d = Math.abs(buf[i] - buf[i % 4]); if (d > m) m = d; }
  return m <= 2 ? 0 : m;
}

async function drawnPixels(ffmpeg, mov, t) {
  const buf = await run(ffmpeg, ['-v', 'error', '-ss', String(t), '-i', mov, '-frames:v', '1', '-vf', 'alphaextract', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { capture: true });
  let n = 0;
  for (let i = 0; i < buf.length; i++) if (buf[i] > 8) n++;
  return n / buf.length;
}

async function sampleLogo(dir) {
  const f = path.join(dir, 'sample logo.svg');
  await fsp.writeFile(f, `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#FF7A59"/><stop offset="1" stop-color="#7B4DFF"/></linearGradient></defs>
  <rect x="16" y="16" width="480" height="480" rx="112" fill="url(#g)"/>
  <path d="M206 160 L366 256 L206 352 Z" fill="#fff"/></svg>`);
  return f;
}

async function main() {
  const a = args();
  const ffmpeg = findFfmpeg(a.ffmpeg);
  const take = a.take;
  if (!take) throw new Error('--take <raw talking-head video> is required');
  const out = path.resolve(a.out || path.join(repo, 'testdata', 'anim proof'));
  await fsp.mkdir(path.join(out, 'frames'), { recursive: true });
  const logo = await sampleLogo(out);
  const only = a.only ? new Set(String(a.only).split(',')) : null;

  const jobs = [];
  for (const t of listTemplates()) {
    if (only && !only.has(t.id)) continue;
    const meta = loadMeta(t.id);
    [meta.example, ...(meta.variants || [])].forEach((p, i) => {
      const params = { ...p };
      if (t.id === 'logo-pop') params.image = logo;
      jobs.push({ id: `${t.id}-${i}`, template: t.id, params });
    });
  }

  const adapter = await createPlaywrightAdapter();
  const report = [];
  const sheet = [];
  try {
    let offset = 6;
    for (const j of jobs) {
      const t0 = Date.now();
      const r = await renderAnimation({ template: j.template, params: j.params, outPath: path.join(out, 'layers', `${j.id}.mov`), adapter, ffmpeg });
      const ms = Date.now() - t0;
      const layout = r.layout;
      // top: nothing at all in the caption band. full: an opaque backdrop is expected there (captions
      // burn on top of it), so check the band holds only the plain backdrop colour, no content.
      const capA = layout === 'full' ? await bandSpread(ffmpeg, r.path, CAPTION_BAND) : await maxAlpha(ffmpeg, r.path, CAPTION_BAND);
      const faceA = layout === 'top' ? await maxAlpha(ffmpeg, r.path, FACE_BOX) : null;
      const drawn = await drawnPixels(ffmpeg, r.path, Math.min(r.duration - 0.05, 1.5));
      const stat = await fsp.stat(r.path);

      // Overlay exactly as the engine would: layer at 0,0 over the speaker. Guides drawn AFTER the
      // overlay on the proof only: red = caption band, yellow = typical face box.
      const comp = path.join(out, 'over', `${j.id}.mp4`);
      await fsp.mkdir(path.dirname(comp), { recursive: true });
      offset = (offset + 7) % 70 + 4;
      await run(ffmpeg, ['-v', 'error', '-y', '-ss', String(offset), '-t', String(r.duration), '-i', take, '-i', r.path,
        '-filter_complex', `[0:v]scale=1080:1920,setsar=1[bg];[bg][1:v]overlay=0:0:format=auto:shortest=1,` +
        `drawbox=x=0:y=${CAPTION_BAND.y}:w=1080:h=${CAPTION_BAND.h}:color=red@0.9:t=6,` +
        `drawbox=x=${FACE_BOX.x}:y=${FACE_BOX.y}:w=${FACE_BOX.w}:h=${FACE_BOX.h}:color=yellow@0.7:t=4[v]`,
        '-map', '[v]', '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', comp]);
      const times = [0.1, Math.min(0.45, r.duration / 3), r.duration - 0.1];
      const frames = [];
      for (const [k, t] of times.entries()) {
        const f = path.join(out, 'frames', `${j.id}-${k}.png`);
        await run(ffmpeg, ['-v', 'error', '-y', '-ss', t.toFixed(3), '-i', comp, '-frames:v', '1', '-vf', 'scale=360:640', f]);
        frames.push(f);
        sheet.push(f);
      }
      // a soft card shadow may touch the hair line (alpha <= 40 of 255); drawn content is 255
      const ok = capA === 0 && (faceA === null || faceA <= 40) && drawn > 0.01;
      const row = { id: j.id, template: j.template, layout, duration: r.duration, frames: r.frames, mb: +(stat.size / 1e6).toFixed(1), ms, captionBandMaxAlpha: capA, faceBoxMaxAlpha: faceA, drawnFraction: +drawn.toFixed(3), ok, frames_png: frames };
      report.push(row);
      process.stdout.write(`${ok ? 'OK  ' : 'FAIL'} ${j.id.padEnd(20)} ${layout.padEnd(4)} ${r.duration.toFixed(2)}s ${String(row.mb).padStart(5)} MB ${String(ms).padStart(6)} ms  caption=${capA}${layout === 'full' ? '(spread)' : ''} face=${faceA ?? '-'} drawn=${row.drawnFraction}\n`);
    }
  } finally {
    await adapter.close();
  }

  // contact sheet: 3 renders per row (9 tiles of 360x640), numbered in job order
  const tilesDir = path.join(out, 'tiles');
  await fsp.rm(tilesDir, { recursive: true, force: true });
  await fsp.mkdir(tilesDir, { recursive: true });
  for (const [i, f] of sheet.entries()) await fsp.copyFile(f, path.join(tilesDir, `t${String(i).padStart(3, '0')}.png`));
  const rows = Math.ceil(sheet.length / 9);
  const contact = path.join(out, 'contact-sheet.png');
  await run(ffmpeg, ['-v', 'error', '-y', '-framerate', '1', '-i', path.join(tilesDir, 't%03d.png'), '-vf', `tile=9x${rows}:padding=6:color=white`, '-frames:v', '1', contact]);
  await fsp.writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  const bad = report.filter((r) => !r.ok);
  process.stdout.write(`\n${report.length - bad.length}/${report.length} passed. contact sheet: ${contact}\n`);
  if (bad.length) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
