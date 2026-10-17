// First-frame check: for every template (example + variants, default AND late speech-aligned times),
// find the first frame where the layer draws anything and measure how much "ink" (content that is not
// the card's own fill or shadow) it carries. An empty card on its first frame has ~0 ink.
//
//   node tools/firstframe.mjs [--out dir]      prints a table, writes first-frame PNGs to --out
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPlaywrightAdapter, findFfmpeg, inlineFiles, listTemplates, loadMeta, prepareParams, startTemplateServer } from '../render.mjs';

export function rgba(png) {
  return execFileSync(findFfmpeg(), ['-v', 'error', '-f', 'png_pipe', '-i', '-', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { input: png, maxBuffer: 64e6 });
}

/** { drawn: share of the frame with alpha > 8, ink: share of OPAQUE pixels far from the dominant opaque colour }. */
export function inkOf(buf) {
  let drawn = 0, opaque = 0;
  const hist = new Map();
  for (let i = 0; i < buf.length; i += 4) {
    if (buf[i + 3] > 8) drawn++;
    if (buf[i + 3] > 230) {
      opaque++;
      const k = ((buf[i] >> 4) << 8) | ((buf[i + 1] >> 4) << 4) | (buf[i + 2] >> 4);
      hist.set(k, (hist.get(k) || 0) + 1);
    }
  }
  let best = 0, bk = 0;
  for (const [k, n] of hist) if (n > best) { best = n; bk = k; }
  const fr = ((bk >> 8) & 15) * 16 + 8, fg = ((bk >> 4) & 15) * 16 + 8, fb = (bk & 15) * 16 + 8;
  let ink = 0;
  for (let i = 0; i < buf.length; i += 4) {
    if (buf[i + 3] > 230 && Math.abs(buf[i] - fr) + Math.abs(buf[i + 1] - fg) + Math.abs(buf[i + 2] - fb) > 120) ink++;
  }
  const px = buf.length / 4;
  return { drawn: drawn / px, ink: opaque ? ink / opaque : 0 };
}

/** Late, speech-aligned timing for each template (what the AI passes when the words come later). */
export const LATE = {
  'big-quote': (p) => ({ wordTimes: Array.from({ length: String(p.text).split(/\s+/).length }, (_, i) => 0.6 + i * 0.25) }),
  'list-reveal': (p) => ({ at: p.items.map((_, i) => 0.7 + i * 0.5) }),
  'logo-pop': () => ({ labelAt: 0.8 }),
  'price-tag': (p) => (p.oldValue ? { strikeAt: 0.9 } : {}),
  'stat-count-up': () => ({ labelAt: 0.8 }),
  'typing-terminal': () => ({ typeAt: 0.8 }),
};

export function cases(logo) {
  const out = [];
  for (const { id } of listTemplates()) {
    const m = loadMeta(id);
    [m.example, ...(m.variants || [])].forEach((ex, vi) => {
      const base = id === 'logo-pop' ? { ...ex, image: logo } : ex;
      out.push({ id, name: `${id}#${vi}`, params: base });
      out.push({ id, name: `${id}#${vi} late`, params: { ...base, ...LATE[id](base) } });
    });
  }
  return out;
}

/** Letters/digits the viewer can actually see right now (decorative glyphs like a quote mark don't count). */
export const VISIBLE_LETTERS = String.raw`(() => {
  const vis = (el) => { for (let e = el; e && e !== document.body; e = e.parentElement) { const s = getComputedStyle(e); if (Number(s.opacity) < 0.5 || s.visibility === 'hidden' || s.display === 'none') return false; } return true; };
  let n = 0;
  const w = document.createTreeWalker(document.getElementById('content'), NodeFilter.SHOW_TEXT);
  for (let t = w.nextNode(); t; t = w.nextNode()) { const k = (t.textContent.match(/[\p{L}\p{N}]/gu) || []).length; if (k && vis(t.parentElement)) n += k; }
  return n;
})()`;

/** Seek frame by frame from 0 until something is drawn; returns that frame's numbers + PNG. */
export async function firstFrame(adapter, url, params, maxT = 2) {
  await adapter.load(url);
  await adapter.evaluate(`window.__setup(${JSON.stringify(params)})`);
  for (let f = 0; f / 30 <= maxT; f++) {
    const t = f / 30;
    await adapter.evaluate(`window.__seek(${t})`);
    const png = await adapter.capture(t);
    const r = inkOf(rgba(png));
    if (r.drawn > 0.005) return { t, ...r, letters: await adapter.evaluate(VISIBLE_LETTERS), png };
  }
  return null;
}

if (process.argv[1] && process.argv[1].endsWith('firstframe.mjs')) {
  const oi = process.argv.indexOf('--out');
  const out = oi > 0 ? path.resolve(process.argv[oi + 1]) : null;
  if (out) mkdirSync(out, { recursive: true });
  const adapter = await createPlaywrightAdapter();
  const s = await startTemplateServer();
  const logoPath = path.join(out || os.tmpdir(), 'reelstudio-firstframe-logo.svg');
  writeFileSync(logoPath, '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" rx="12" fill="#7B4DFF"/><path d="M24 18 L46 32 L24 46 Z" fill="#fff"/></svg>');
  try {
    for (const c of cases(logoPath)) {
      const m = loadMeta(c.id);
      const params = await inlineFiles(m, prepareParams(m, c.params).params);
      const r = await firstFrame(adapter, `${s.url}/animations/${c.id}/index.html`, params);
      console.log(`${c.name.padEnd(26)} first drawn t=${r ? r.t.toFixed(3) : '-'} drawn=${r ? (r.drawn * 100).toFixed(1) : '-'}% ink=${r ? (r.ink * 100).toFixed(2) : '-'}% letters=${r ? r.letters : '-'}`);
      if (out && r) writeFileSync(path.join(out, c.name.replace(/[#\s]+/g, '_') + '.png'), r.png);
    }
  } finally { await s.close(); await adapter.close(); }
}
