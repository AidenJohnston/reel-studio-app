// Will an animation's main text be readable on a phone? (live e2e: a stat-count-up "9" came out
// ~60 px tall in a corner of a wide shot). Every template shrinks its type scale --k until the
// content fits its region (templates/animations/_lib `fit`), so a small region or a long label
// silently makes the hero text tiny. This estimates the hero size BEFORE rendering, from the same
// px sizes the templates use, so the editor can switch to `layout: full` or say the text is too long.

/** Absolute floor for an animation's main text, px at 1080 wide (captions are ~76 px). */
export const MIN_HERO_PX = 64;
/** ...and never below 55% of the size the template was designed at (a count-up's number is 230 px
 * at scale 1: the e2e's 60 px "9" was a quarter of that). */
export const MIN_SCALE = 0.55;

export function minHeroPx(template: string): number {
  const s = spec(template, {});
  return s ? Math.max(MIN_HERO_PX, Math.round(MIN_SCALE * s.hero)) : MIN_HERO_PX;
}

/** Templates' full-screen region (1080x1920 template px), clear of the platform UI. */
export const FULL_REGION = { x: 60, y: 260, w: 960, h: 1240 };

interface Piece { chars: number; size: number; nowrap?: boolean; mono?: boolean }
interface Spec { hero: number; pieces: Piece[]; maxKTop: number; maxKFull: number }

const len = (v: unknown) => (typeof v === 'string' ? v.trim().length : typeof v === 'number' ? String(v).length : 0);

function spec(template: string, p: Record<string, any>): Spec | null {
  switch (template) {
    case 'stat-count-up':
      return { hero: 230, maxKTop: 1.35, maxKFull: 2.2, pieces: [{ chars: Math.max(1, len(p.value)), size: 230, nowrap: true }, { chars: len(p.text), size: 66 }] };
    case 'price-tag':
      return { hero: 196, maxKTop: 1.35, maxKFull: 2.2, pieces: [{ chars: Math.max(1, len(p.value)), size: 196, nowrap: true }, { chars: len(p.oldValue), size: 92, nowrap: true }, { chars: len(p.text) + len(p.name), size: 54 }] };
    case 'big-quote':
      return { hero: 96, maxKTop: 1.35, maxKFull: 2.2, pieces: [{ chars: Math.max(1, len(p.text)), size: 96 }, { chars: len(p.author), size: 44 }] };
    case 'list-reveal': {
      const items: string[] = Array.isArray(p.items) ? p.items.map(String) : [];
      return { hero: 72, maxKTop: 1.35, maxKFull: 2.2, pieces: [{ chars: len(p.text), size: 72 }, ...items.map((s) => ({ chars: Math.max(1, s.length), size: 72, nowrap: true }))] };
    }
    case 'logo-pop':
      return { hero: 72, maxKTop: 1.35, maxKFull: 2.2, pieces: [{ chars: Math.max(1, len(p.text)), size: 72 }] };
    case 'typing-terminal':
      return { hero: 64, maxKTop: 1.35, maxKFull: 1.3, pieces: [{ chars: Math.max(1, len(p.text)), size: 64, mono: true }, { chars: len(p.response), size: 54, mono: true }] };
    default:
      return null;
  }
}

/** Estimated hero text height (px at 1080 wide) for template + params in a region. null = unknown template. */
export function estimateHeroPx(template: string, params: Record<string, any>, region: { w: number; h: number }, layout: 'top' | 'full' = 'top'): number | null {
  const s = spec(template, params);
  if (!s) return null;
  const cw = (pc: Piece) => (pc.mono ? 0.6 : 0.56) * pc.size;          // average glyph width per px of size
  const maxW = region.w * 0.97; const maxH = region.h * 0.97;
  // the templates' own loop: start at the largest scale, shrink until every line fits the width
  // and the wrapped stack fits the height
  const fits = (k: number) => {
    let h = 0;
    for (const pc of s.pieces) {
      if (!pc.chars) continue;
      const w = pc.chars * cw(pc) * k;
      if (pc.nowrap && w > maxW) return false;
      h += pc.size * k * 1.12 * (pc.nowrap ? 1 : Math.max(1, Math.ceil(w / maxW)));
    }
    return h <= maxH;
  };
  let k = layout === 'full' ? s.maxKFull : s.maxKTop;
  while (k > 0.05 && !fits(k)) k *= 0.95;
  return Math.round(s.hero * k);
}

export interface ReadableChoice { layout: 'top' | 'full'; heroPx: number | null; switched: boolean; tooLong: boolean }

/** Pick the layout: keep `top` when its hero text is readable, else go full screen; `tooLong` when
 * even full screen is too small (the text must be shortened). */
export function chooseReadableLayout(template: string, params: Record<string, any>, region: { w: number; h: number } | undefined,
  layout: 'top' | 'full'): ReadableChoice {
  const min = minHeroPx(template);
  if (layout === 'top' && region) {
    const top = estimateHeroPx(template, params, region, 'top');
    if (top === null || top >= min) return { layout: 'top', heroPx: top, switched: false, tooLong: false };
    const full = estimateHeroPx(template, params, FULL_REGION, 'full');
    return { layout: 'full', heroPx: full, switched: true, tooLong: full !== null && full < min };
  }
  const full = estimateHeroPx(template, params, FULL_REGION, 'full');
  return { layout, heroPx: full, switched: false, tooLong: layout === 'full' && full !== null && full < min };
}
