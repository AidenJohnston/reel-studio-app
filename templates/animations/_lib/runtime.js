/*
 * Shared runtime for Reel Studio animation templates.
 *
 * A template page is a pure function of time: window.__seek(t) must produce the same pixels for the
 * same t, every time, in any order. So: no timers, no requestAnimationFrame, no Math.random, no CSS
 * transitions. Everything below is plain math on t.
 *
 * A template calls RS.define({ fonts, build, seek, duration }) and gets window.__setup / window.__seek.
 */
(function () {
  'use strict';

  const W = 1080, H = 1920;
  // Default regions. `top` keeps clear of the platform UI at the very top, ends above a typical
  // head, and never reaches the caption band (~y 1250-1500). `full` hides the speaker but still
  // stays above the caption band, because captions are burned on top of everything.
  const REGIONS = {
    top: { x: 50, y: 130, w: 980, h: 590 },   // bottom edge ~y 720: may touch the hairline, never the eyes
    full: { x: 70, y: 200, w: 940, h: 1000 },
  };
  const THEMES = {
    light: { card: '#FBFAF7', ink: '#1D1B18', muted: '#6E675D', line: 'rgba(29,27,24,0.12)', page: '#F4F1EB' },
    dark: { card: '#1D1B18', ink: '#F7F5F1', muted: '#ABA396', line: 'rgba(247,245,241,0.16)', page: '#141311' },
  };
  const DEFAULT_ACCENT = '#2F5BFF';

  // ---------------------------------------------------------------- math
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const clamp01 = (v) => clamp(v, 0, 1);
  const lerp = (a, b, p) => a + (b - a) * p;
  const ease = {
    linear: (p) => p,
    outCubic: (p) => 1 - Math.pow(1 - p, 3),
    outQuart: (p) => 1 - Math.pow(1 - p, 4),
    outExpo: (p) => (p >= 1 ? 1 : 1 - Math.pow(2, -10 * p)),
    inOutCubic: (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2),
    outBack: (p, s = 1.6) => 1 + (s + 1) * Math.pow(p - 1, 3) + s * Math.pow(p - 1, 2),
  };
  /** 0..1 progress of a segment that starts at `at` and lasts `dur` seconds. */
  const prog = (t, at, dur) => (dur <= 0 ? (t >= at ? 1 : 0) : clamp01((t - at) / dur));

  /**
   * A hard, quick entrance. Fully opaque on its first frame (no fade), then settles from a slightly
   * smaller, lower position in `dur` seconds. Returns a CSS transform + opacity for time t.
   * Use `from: 1` (move only) for small text: Chromium caches raster of scaled text by the scales of
   * earlier frames, so a scaling word can render differently for the same t. Cards may scale.
   */
  function pop(t, at, o = {}) {
    const dur = o.dur ?? 0.22, from = o.from ?? 0.86, dy = o.dy ?? 30, dx = o.dx ?? 0, rot = o.rot ?? 0;
    if (t < at) return { opacity: 0, transform: 'none', p: 0, visible: false };
    const p = prog(t, at, dur);
    const s = lerp(from, 1, ease.outBack(p, o.overshoot ?? 1.4));
    const m = ease.outCubic(p);
    return {
      opacity: 1, p, visible: true,
      transform: `translate(${(dx * (1 - m)).toFixed(2)}px, ${(dy * (1 - m)).toFixed(2)}px) scale(${s.toFixed(4)})` +
        (rot ? ` rotate(${(rot * (1 - m)).toFixed(3)}deg)` : ''),
    };
  }
  function applyPop(el, st) {
    el.style.opacity = String(st.opacity);
    el.style.transform = st.transform;
  }

  // ---------------------------------------------------------------- colour
  function parseColor(c) {
    if (typeof c !== 'string') return null;
    const m = c.trim().match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i);
    if (!m) return null;
    let h = m[1];
    if (h.length === 3) h = h.split('').map((x) => x + x).join('');
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), hex: '#' + h.toUpperCase() };
  }
  function luminance({ r, g, b }) {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  }
  /** Ink that reads on a given background: near-black or near-white, whichever contrasts more. */
  function inkOn(hex) {
    const c = parseColor(hex);
    if (!c) return '#FFFFFF';
    const L = luminance(c);
    const cDark = (L + 0.05) / (luminance(parseColor('#1D1B18')) + 0.05);
    const cLight = (luminance(parseColor('#FFFFFF')) + 0.05) / (L + 0.05);
    return cDark >= cLight ? '#1D1B18' : '#FFFFFF';
  }

  function applyTheme(params) {
    const accent = (parseColor(params.accentColor) || parseColor(DEFAULT_ACCENT)).hex;
    const theme = params.theme === 'dark' || params.theme === 'accent' ? params.theme : 'light';
    let v;
    if (theme === 'accent') {
      const ink = inkOn(accent);
      const muted = ink === '#FFFFFF' ? 'rgba(255,255,255,0.82)' : 'rgba(29,27,24,0.72)';
      v = { card: accent, ink, muted, line: ink === '#FFFFFF' ? 'rgba(255,255,255,0.28)' : 'rgba(29,27,24,0.18)', page: accent, hl: ink };
    } else {
      v = Object.assign({}, THEMES[theme], { hl: accent });
    }
    const r = document.documentElement.style;
    r.setProperty('--card', v.card); r.setProperty('--ink', v.ink); r.setProperty('--muted', v.muted);
    r.setProperty('--line', v.line); r.setProperty('--page', v.page); r.setProperty('--hl', v.hl);
    r.setProperty('--accent', accent); r.setProperty('--accent-ink', inkOn(accent));
    document.body.classList.add('theme-' + theme);
    return theme;
  }

  // ---------------------------------------------------------------- params
  /** Fill missing params from the template's meta.json JSON-schema defaults (shallow). */
  function withDefaults(params, meta) {
    const out = Object.assign({}, params || {});
    const props = (meta && meta.params && meta.params.properties) || {};
    for (const k of Object.keys(props)) {
      if ((out[k] === undefined || out[k] === null) && props[k].default !== undefined) out[k] = props[k].default;
    }
    return out;
  }
  async function loadMeta() {
    if (window.__META__) return window.__META__;
    try {
      const r = await fetch('./meta.json', { cache: 'no-store' });
      if (r.ok) return await r.json();
    } catch (e) { /* opened from disk without a server: defaults come from the template */ }
    return null;
  }

  // ---------------------------------------------------------------- layout
  function regionFor(params) {
    const layout = params.layout === 'full' ? 'full' : 'top';
    const def = REGIONS[layout];
    const r = params.region && typeof params.region === 'object' ? params.region : {};
    const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
    const x = clamp(num(r.x, def.x), 0, W - 100), y = clamp(num(r.y, def.y), 0, H - 100);
    return { layout, x, y, w: clamp(num(r.w, def.w), 100, W - x), h: clamp(num(r.h, def.h), 100, H - y) };
  }

  /**
   * Shrink the type scale (--k) until `el` fits inside the region, with everything in its final,
   * fully-revealed state. Runs once in __setup, never during __seek, so layout cannot jump.
   */
  function fit(el, region, opts = {}) {
    const root = document.documentElement.style;
    const margin = opts.margin ?? 0.96;
    const maxW = region.w * margin, maxH = region.h * margin;
    // text boxes wrap at the region width (not at a size that scales with the type), so type can
    // grow until the HEIGHT is used up
    root.setProperty('--maxw', Math.floor(maxW) + 'px');
    const maxK = opts.maxK ?? 1;
    // scrollWidth catches a long word overflowing its max-width box
    const fits = () => Math.max(el.offsetWidth, el.scrollWidth) <= maxW && Math.max(el.offsetHeight, el.scrollHeight) <= maxH;
    const set = (k) => root.setProperty('--k', k.toFixed(4));
    let k = 1;
    set(k);
    if (fits()) {
      // grow toward the region (big type reads in under a second) but never past maxK
      while (k * 1.04 <= maxK) { set(k * 1.04); if (!fits()) break; k *= 1.04; }
      set(k);
    } else {
      for (let i = 0; i < 40 && !fits(); i++) { k *= 0.95; set(k); }
    }
    return k;
  }

  async function waitFonts(fonts) {
    const specs = fonts && fonts.length ? fonts : ['700 64px Inter'];
    await Promise.all(specs.map((f) => document.fonts.load(f).catch(() => null)));
    await document.fonts.ready;
    const missing = specs.filter((f) => !document.fonts.check(f));
    if (missing.length) throw new Error('fonts did not load: ' + missing.join(', '));
  }

  function loadImage(img, src) {
    return new Promise((resolve, reject) => {
      img.onload = () => (img.decode ? img.decode().then(resolve, resolve) : resolve());
      img.onerror = () => reject(new Error('image failed to load'));
      img.src = src;
    });
  }

  /**
   * An image that scales without a transform. Chromium's compositor caches raster and image decodes
   * by the scales of EARLIER frames, so a transform-scaled image could render differently for the
   * same t (measured: 1 of 3 identical renders differed). Instead the <img> becomes a fixed-size
   * CPU canvas (`room` x its size, centred, layout unchanged) and draw(scale) repaints it in software.
   */
  function imageSprite(img, room = 1.3) {
    const r = img.getBoundingClientRect();
    const w = Math.max(1, Math.round(r.width)), h = Math.max(1, Math.round(r.height));
    const W = Math.ceil(w * room), H = Math.ceil(h * room);
    const src = document.createElement('canvas');             // the logo once, at 2x its size
    src.width = w * 2; src.height = h * 2;
    const sg = src.getContext('2d', { willReadFrequently: true });
    sg.imageSmoothingEnabled = true; sg.imageSmoothingQuality = 'high';
    sg.drawImage(img, 0, 0, src.width, src.height);
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    Object.assign(c.style, { width: W + 'px', height: H + 'px', display: 'block', margin: `${-(H - h) / 2}px ${-(W - w) / 2}px` });
    img.replaceWith(c);
    const g = c.getContext('2d', { willReadFrequently: true }); // CPU canvas: never promoted to a GPU layer
    g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
    return {
      el: c,
      draw(scale, shadow) {
        g.clearRect(0, 0, W, H);
        if (!(scale > 0)) return;
        const dw = w * scale, dh = h * scale;
        g.save();
        if (shadow) { g.shadowColor = 'rgba(0,0,0,0.35)'; g.shadowBlur = 28; g.shadowOffsetY = 10; }
        g.drawImage(src, (W - dw) / 2, (H - dh) / 2, dw, dh);
        g.restore();
      },
    };
  }

  /** Split text into words, keeping punctuation attached (for word-by-word reveals). */
  const words = (s) => String(s || '').trim().split(/\s+/).filter(Boolean);

  /** Evenly spaced beat times, or the caller's own times (seconds from the clip start) when given. */
  function beats(n, given, start, step) {
    const out = [];
    for (let i = 0; i < n; i++) {
      const g = Array.isArray(given) ? Number(given[i]) : NaN;
      out.push(Number.isFinite(g) && g >= 0 ? g : start + i * step);
    }
    return out;
  }

  /** The earliest beat (0 when there are none): a card enters on it, so it never shows up empty. */
  function firstBeat(times) {
    const v = (times || []).filter((x) => Number.isFinite(x));
    return v.length ? Math.max(0, Math.min(...v)) : 0;
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ---------------------------------------------------------------- define
  /**
   * def = {
   *   fonts: ['700 64px Inter', ...],           // CSS font shorthands that must be loaded
   *   build(params, ctx) -> Promise|void,        // create DOM inside ctx.content, final state visible
   *   duration(params) -> seconds,               // used when params.duration is not given
   *   afterFit(params, ctx) -> Promise|void,     // optional: final sizes are known (e.g. rasterise images)
   *   enterAt(params, ctx) -> seconds,           // optional: when the first CONTENT appears (default 0).
   *                                              // Before it the layer is fully transparent (in `full`
   *                                              // layout too): a card never shows up empty.
   *   seek(t, params, ctx),                      // pure: set styles for time t
   *   tilt: default tilt degrees for `top` layout,
   *   ownDrift: true when the template applies the slow push (ctx.push) itself,
   * }
   */
  function define(def) {
    const ctx = { stage: null, content: null, region: null, params: null, duration: 3, ready: false };

    window.__setup = async function (params) {
      const meta = await loadMeta();
      const p = withDefaults(params, meta);
      ctx.params = p;
      ctx.theme = applyTheme(p);
      ctx.region = regionFor(p);
      document.body.classList.add('layout-' + ctx.region.layout);
      if (p.boxed) document.body.classList.add('boxed');

      const stage = document.getElementById('stage');
      const content = document.getElementById('content');
      Object.assign(stage.style, { left: ctx.region.x + 'px', top: ctx.region.y + 'px', width: ctx.region.w + 'px', height: ctx.region.h + 'px' });
      ctx.stage = stage; ctx.content = content;

      await waitFonts(def.fonts);
      await def.build(p, ctx);
      ctx.tilt = Number.isFinite(Number(p.tilt)) && p.tilt !== null ? clamp(Number(p.tilt), -8, 8)
        : (ctx.region.layout === 'top' ? (def.tilt ?? 0) : 0);
      // Measure with everything revealed and untransformed, then fit (a tilted card needs a margin).
      ctx.k = fit(content, ctx.region, { margin: ctx.tilt ? 0.92 : 0.97, maxK: ctx.region.layout === 'full' ? (def.maxKFull ?? 2.2) : (def.maxKTop ?? 1.35) });
      if (def.afterFit) await def.afterFit(p, ctx);
      ctx.enter = def.enterAt ? Math.max(0, Number(def.enterAt(p, ctx)) || 0) : 0;
      const d = Number(p.duration);
      ctx.duration = Number.isFinite(d) && d > 0 ? clamp(d, 0.5, 30) : clamp(def.duration ? def.duration(p) : 3, 0.5, 30);
      ctx.drift = Number.isFinite(Number(p.drift)) ? clamp(Number(p.drift), 0, 0.08) : 0.015;
      ctx.ready = true;
      window.__seek(0);
      return { duration: ctx.duration, width: W, height: H, layout: ctx.region.layout, scale: ctx.k };
    };

    window.__seek = function (t) {
      if (!ctx.ready) return;
      t = Math.max(0, Number(t) || 0);
      // A barely-there push over the whole clip so a held card never reads as a frozen frame.
      const push = 1 + ctx.drift * clamp01(t / ctx.duration);
      ctx.push = push;
      // ownDrift: the template applies `ctx.push` itself (logo-pop draws it into a canvas)
      ctx.content.style.transform = def.ownDrift ? `rotate(${ctx.tilt}deg)` : `rotate(${ctx.tilt}deg) scale(${push.toFixed(5)})`;
      // Nothing at all (not even the `full` page) before the first content: an empty card or a blank
      // page while the speaker gets to the word reads as a glitch.
      document.body.classList.toggle('pre-enter', t < ctx.enter);
      def.seek(t, ctx.params, ctx);
    };

    window.__info = () => ({ duration: ctx.duration, region: ctx.region, k: ctx.k, tilt: ctx.tilt });
  }

  window.RS = { W, H, REGIONS, THEMES, clamp, clamp01, lerp, ease, prog, pop, applyPop, parseColor, inkOn, withDefaults, regionFor, fit, waitFonts, loadImage, imageSprite, words, beats, firstBeat, escapeHtml, define };
})();
